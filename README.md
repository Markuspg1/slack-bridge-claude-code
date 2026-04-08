# Slack Bridge for Claude Code

Turn Claude Code into an autonomous AI agent you control from Slack — on any device, for $20/month.

Send a message from your phone. Get a deployed app back. No API costs.

![Node.js](https://img.shields.io/badge/Node.js-18+-green)
![License](https://img.shields.io/badge/license-MIT-blue)

## What it does

This is a ~150-line Node.js bridge that connects Slack to [Claude Code](https://docs.anthropic.com/en/docs/claude-code) running on your machine. Claude Code uses your Pro/Max subscription (not the API), so there are no per-token costs.

- **Send a Slack message** → Claude Code runs on your Mac/Linux box
- **Full agent capabilities** — shell, file system, deployments, databases, web search
- **Conversation continuity** — each Slack channel maintains its own session
- **File transfers** — attach files in Slack, get output files back
- **Socket Mode** — no public URL or tunneling required
- **Heartbeat updates** — shows "Working... (30s)" so you know it's alive

## Architecture

```
Phone/Laptop → Slack → Socket Mode → Bridge (Node.js) → Claude Code CLI → Your Machine
                                                              ↓
                                                         CLAUDE.md
                                                    (agent instructions)
```

## Quick Start

### 1. Create a Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From scratch**
2. Enable **Socket Mode** (Settings → Socket Mode → toggle on) — save the `xapp-` token
3. Add **Bot Token Scopes** (OAuth & Permissions):
   - `chat:write`
   - `files:read`
   - `files:write`
   - `im:history`
   - `im:read`
   - `im:write`
   - `app_mentions:read`
4. **Subscribe to Events** (Event Subscriptions → toggle on):
   - `message.im`
   - `app_mention`
5. Install the app to your workspace — save the `xoxb-` token

### 2. Install Claude Code

```bash
npm install -g @anthropic-ai/claude-code
claude  # authenticate with your Pro/Max account
```

### 3. Clone and configure

```bash
git clone https://github.com/Markuspg1/slack-bridge-claude-code.git
cd slack-bridge-claude-code
cp .env.example .env
```

Edit `.env` with your tokens:

```env
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_APP_TOKEN=xapp-your-app-token
ALLOWED_USERS=U01ABCDEF   # your Slack user ID (optional)
CLAUDE_WORKING_DIR=/Users/you/workspace
```

### 4. Customize CLAUDE.md

Edit `CLAUDE.md` to describe your machine, tools, and conventions. Claude Code reads this at the start of every session. The included file is a template — make it yours.

### 5. Run it

```bash
# One-off
npm start

# Persistent (survives reboots)
npm install -g pm2
pm2 start start.sh --name claude-bridge
pm2 save
pm2 startup
```

### 6. Use it

DM your bot in Slack or @mention it in a channel:

> "Deploy the CRM app to production"

> "Create a new React project with Tailwind and Supabase auth"

> "Check my calendar for tomorrow and summarize it"

## How it works

| Component | Purpose |
|-----------|---------|
| `src/index.js` | Slack listener + Claude Code spawner |
| `start.sh` | Startup script with dependency checks |
| `CLAUDE.md` | Agent instructions (customize this) |
| `.env` | Secrets (Slack tokens, config) |
| `sessions.json` | Auto-managed session store for conversation continuity |

The bridge spawns `claude -p <prompt> --output-format json` as a child process. Key flags:

- `--output-format json` — structured output with session IDs
- `--max-turns 25` — caps agentic loops
- `--resume <session_id>` — continues previous conversations
- `--allowedTools` — restricts which tools Claude can use

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `SLACK_BOT_TOKEN` | required | Bot token (`xoxb-...`) |
| `SLACK_APP_TOKEN` | required | App-level token (`xapp-...`) for Socket Mode |
| `ALLOWED_USERS` | `""` (everyone) | Comma-separated Slack user IDs |
| `CLAUDE_WORKING_DIR` | `$HOME` | Where Claude Code runs |
| `MAX_TURNS` | `25` | Max agentic turns per request |
| `HEARTBEAT_SEC` | `15` | Seconds between "Working..." updates |

## What you get vs. what you give up

**You get:**
- Full Claude Code agent from any device via Slack
- $20/month flat — no API costs
- Shell, file system, git, deployments, databases
- Conversation memory within channels

**You give up:**
- Rate limits on Pro (less restrictive on Max)
- No streaming — you get the full response when done
- Single agent (no parallel multi-agent orchestration)

For most workflows — "build this", "deploy that", "check my calendar" — the bridge covers it.

## Background

This project was born when Anthropic removed third-party tool access from subscription plans on April 4th, 2026. Read the full story: [Anthropic Killed My AI Agent Platform — Here's How I Rebuilt It for $20/month](https://blog-deploy-sepia.vercel.app/blog/replacing-api-costs-claude-code-slack-bridge)

## License

MIT
