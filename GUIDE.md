# Agent Usage Guide

## Running the Agent

To run this agent, you need to:

1. Install the required dependencies:
   ```bash
   pip install -r requirements.txt
   ```

2. Set up your environment variables in a `.env` file:
   ```bash
   API_KEY=your_api_key_here
   MODEL_NAME=gpt-4
   ```

3. Run the agent:
   ```bash
   python agent.py
   ```

## Configuration

The agent can be configured via environment variables or a config file. See `config.py` for available options.

## Testing

Run tests with:
```bash
python -m pytest tests/
```