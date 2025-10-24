import core from "@actions/core";
import github from "@actions/github";
import fetch from "node-fetch";
import { Octokit } from "@octokit/rest";

// const OLLAMA_URL = "https://api.ollama.com/v1/chat/completions"; // Check if changed

const SYSTEM_PROMPT = `
You are a Legendary Agentic DevOps Engineer.
Your job is to:
- Read the provided files and context.
- Suggest minimal, safe code changes to improve DevOps automation, testing, or CI/CD pipelines.
- Always output a JSON object with keys:
  { "verdict": "PATCH"|"HUMAN_REVIEW_REQUIRED", "files": [{ "path": "file.txt", "content": "..." }], "summary": "one-line summary" }
- If the change could break something, use verdict "HUMAN_REVIEW_REQUIRED".
- Keep explanations short and focused.
`;

async function callOllama(messages, apiKey) {
  const res = await fetch("https://ollama.com/api/chat", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "qwen3-coder:480b-cloud", // or another available model
      messages,
      stream: false,
    }),
  });

  if (!res.ok) {
    throw new Error(`Ollama Cloud request failed: ${res.status}`);
  }

  const data = await res.json();
  return data?.message?.content || data?.choices?.[0]?.message?.content || "";
}

function extractJSON(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON object found in model response");
  return JSON.parse(match[0]);
}

async function run() {
  try {
    const apiKey = process.env.OLLAMA_API_KEY;
    if (!apiKey) throw new Error("Missing OLLAMA_API_KEY");

    const token = process.env.GITHUB_TOKEN;
    if (!token) throw new Error("Missing GITHUB_TOKEN");

    const octokit = new Octokit({ auth: token });
    const context = github.context;
    const repo = context.repo;

    // --- Fetch repo info ---
    const { data: repoData } = await octokit.repos.get({
      owner: repo.owner,
      repo: repo.repo,
    });
    const defaultBranch = repoData.default_branch;

    // --- Gather small sample of repo content ---
    async function getFile(path) {
      try {
        const { data } = await octokit.repos.getContent({
          owner: repo.owner,
          repo: repo.repo,
          path,
          ref: defaultBranch,
        });
        return Buffer.from(data.content, "base64").toString();
      } catch {
        return "";
      }
    }

    const readme = await getFile("README.md");
    const workflow = await getFile(".github/workflows/ci.yml");

    const comment = core.getInput("comment_body") || "Improve CI reliability";

    const userPrompt = `
User instruction: ${comment}

Files:
README.md:
${readme.slice(0, 1000)}

.github/workflows/ci.yml:
${workflow.slice(0, 1000)}
`;

    core.info("Calling Ollama Cloud...");
    const responseText = await callOllama(
      [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      apiKey
    );

    core.info("Parsing model response...");
    const output = extractJSON(responseText);

    if (output.verdict === "HUMAN_REVIEW_REQUIRED") {
      core.warning("Model requires human review");
      core.notice(output.summary);
      return;
    }

    if (!output.files || !Array.isArray(output.files)) {
      throw new Error("Model did not return valid files array");
    }

    // Extract PR number from comment if it exists (e.g., "#123" or "PR #123")
    const prMatch = comment.match(/#(\d+)/);
    let existingPR;
    let branch;

    if (prMatch) {
      const prNumber = parseInt(prMatch[1], 10);
      try {
        // Try to get the existing PR
        const { data: pr } = await octokit.pulls.get({
          owner: repo.owner,
          repo: repo.repo,
          pull_number: prNumber
        });
        existingPR = pr;
        branch = pr.head.ref;
      } catch (err) {
        core.warning(`Could not find PR #${prNumber}, creating new branch`);
      }
    }

    // If no existing PR found, create new branch
    if (!branch) {
      branch = `agentic/${Date.now()}`;
    }

    const baseRef = await octokit.git.getRef({
      owner: repo.owner,
      repo: repo.repo,
      ref: `heads/${defaultBranch}`,
    });

    await octokit.git.createRef({
      owner: repo.owner,
      repo: repo.repo,
      ref: `refs/heads/${branch}`,
      sha: baseRef.data.object.sha,
    });

    for (const file of output.files) {
      const contentB64 = Buffer.from(file.content, "utf8").toString("base64");
      let sha;
      try {
        const existing = await octokit.repos.getContent({
          owner: repo.owner,
          repo: repo.repo,
          path: file.path,
          ref: defaultBranch,
        });
        sha = existing.data.sha;
      } catch {
        sha = undefined;
      }

      await octokit.repos.createOrUpdateFileContents({
        owner: repo.owner,
        repo: repo.repo,
        path: file.path,
        message: `agentic: ${output.summary}`,
        content: contentB64,
        branch,
        sha,
      });
    }

    let pr;
    const prBody = `### Proposed by Agentic Ollama AI\n\n${output.summary}\n\n<details><summary>Model Output</summary>\n\n${"```json\n" + JSON.stringify(output, null, 2) + "\n```"}\n\n</details>`;

    if (existingPR) {
      // Update existing PR
      pr = await octokit.pulls.update({
        owner: repo.owner,
        repo: repo.repo,
        pull_number: existingPR.number,
        title: `Agentic PR: ${output.summary}`,
        body: prBody,
      });
      core.notice(`PR updated: ${pr.data.html_url}`);
    } else {
      // Create new PR
      pr = await octokit.pulls.create({
        owner: repo.owner,
        repo: repo.repo,
        title: `Agentic PR: ${output.summary}`,
        head: branch,
        base: defaultBranch,
        draft: true,
        headers: { "X-GitHub-Api-Version": "2022-11-28" },
        body: prBody,
      });
      core.notice(`PR created: ${pr.data.html_url}`);
    }
  } catch (error) {
    core.setFailed(error.message);
  }
}

run();
