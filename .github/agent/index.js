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
      
      // If there's a PR number in the comment, try to add a review comment
      const prMatch = comment.match(/#(\d+)/);
      if (prMatch) {
        const prNumber = parseInt(prMatch[1], 10);
        try {
          const timestamp = new Date().toISOString();
          const reviewBody = `### Human Review Required (${timestamp})\n\n${output.summary}\n\n<details><summary>Model Output</summary>\n\n${"```json\n" + JSON.stringify(output, null, 2) + "\n```"}\n\n</details>`;
          
          await octokit.issues.createComment({
            owner: repo.owner,
            repo: repo.repo,
            issue_number: prNumber,
            body: reviewBody
          });
          
          core.info(`Added review request comment to PR #${prNumber}`);
        } catch (err) {
          core.warning(`Failed to add review comment: ${err.message}`);
        }
      }
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

    // Only create new branch if we're not using an existing PR's branch
    if (!existingPR) {
      const baseRef = await octokit.git.getRef({
        owner: repo.owner,
        repo: repo.repo,
        ref: `heads/${defaultBranch}`,
      });

      try {
        await octokit.git.createRef({
          owner: repo.owner,
          repo: repo.repo,
          ref: `refs/heads/${branch}`,
          sha: baseRef.data.object.sha,
        });
        core.info(`Created new branch: ${branch}`);
      } catch (err) {
        if (err.status === 422 && err.message.includes('Reference already exists')) {
          core.info(`Branch ${branch} already exists, continuing with updates`);
        } else {
          throw err; // Re-throw if it's a different error
        }
      }
    } else {
      core.info(`Using existing branch: ${branch} from PR #${existingPR.number}`);
    }

    for (const file of output.files) {
      const contentB64 = Buffer.from(file.content, "utf8").toString("base64");
      let sha;
      try {
        // First try to get SHA from the target branch
        const existing = await octokit.repos.getContent({
          owner: repo.owner,
          repo: repo.repo,
          path: file.path,
          ref: branch, // Use the target branch instead of defaultBranch
        });
        sha = existing.data.sha;
      } catch (err) {
        // If file doesn't exist in target branch, try default branch
        try {
          const existing = await octokit.repos.getContent({
            owner: repo.owner,
            repo: repo.repo,
            path: file.path,
            ref: defaultBranch,
          });
          sha = existing.data.sha;
        } catch {
          // If file doesn't exist in either branch, it's a new file
          sha = undefined;
        }
      }

      core.info(`Updating file ${file.path} in branch ${branch} (SHA: ${sha || 'new file'})`);
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
    const timestamp = new Date().toISOString();
    const newChangeSection = `\n\n### Update (${timestamp})\n\n${output.summary}\n\n<details><summary>Model Output for this update</summary>\n\n${"```json\n" + JSON.stringify(output, null, 2) + "\n```"}\n\n</details>`;

    if (existingPR) {
      // Get current PR body to append to it
      const { data: currentPR } = await octokit.pulls.get({
        owner: repo.owner,
        repo: repo.repo,
        pull_number: existingPR.number
      });

      const updatedBody = currentPR.body + newChangeSection;

      // Update existing PR
      pr = await octokit.pulls.update({
        owner: repo.owner,
        repo: repo.repo,
        pull_number: existingPR.number,
        title: `Agentic PR: ${currentPR.title.includes('Agentic PR:') ? currentPR.title.split('Agentic PR:')[1].trim() : output.summary}`,
        body: updatedBody,
      });
      core.notice(`PR updated: ${pr.data.html_url}`);
    } else {
      // Create new PR with initial content
      const initialBody = `### Proposed by Agentic Ollama AI\n\n${output.summary}${newChangeSection}`;
      pr = await octokit.pulls.create({
        owner: repo.owner,
        repo: repo.repo,
        title: `Agentic PR: ${output.summary}`,
        head: branch,
        base: defaultBranch,
        draft: true,
        headers: { "X-GitHub-Api-Version": "2022-11-28" },
        body: initialBody,
      });
      core.notice(`PR created: ${pr.data.html_url}`);
    }
  } catch (error) {
    core.setFailed(error.message);
  }
}

run();
