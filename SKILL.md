---
name: codex-skill
description: |
  Bridge THIS Claude Code session to Telegram so the
  user can chat with Claude from their phone. Use for: setting up, starting, stopping,
  or diagnosing the codex-skill bridge daemon; forwarding Claude replies to a messaging
  app; any phrase like "codex-skill", "codex skill", "bridge", "消息推送", "消息转发", "桥接",
  "手机上看claude", "启动后台服务", "配置".
  Subcommands: setup, start, stop, status.
  Do NOT use for: building standalone bots, webhook integrations, or coding with IM
  platform SDKs — those are regular programming tasks.
argument-hint: "setup | start | stop | status"
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - AskUserQuestion
  - Grep
  - Glob
---

# Codex Skill Bridge

You are managing the codex-skill bridge.
User data is stored at `~/.codex-skill/`.

The skill directory (SKILL_DIR) is at `~/.claude/skills/codex-skill`.
If that path doesn't exist, fall back to Glob with pattern `**/skills/**/codex-skill/SKILL.md` and derive the root from the result.

## Command parsing

Parse the user's intent from `$ARGUMENTS` into one of these subcommands:

| User says (examples)                                                       | Subcommand  |
| -------------------------------------------------------------------------- | ----------- |
| `setup`, `configure`, `配置`, `我想在 Telegram 上用 Claude`, `帮我连接 Telegram` | setup       |
| `start`, `start bridge`, `启动`, `启动桥接`                                | start       |
| `stop`, `stop bridge`, `停止`, `停止桥接`                                  | stop        |
| `status`, `bridge status`, `状态`, `运行状态`, `怎么看桥接的运行状态`      | status      |
| `修改配置`, `重新配置`, `帮我改一下 token`, `换个 bot`, `挂了`, `没反应了`, `bot 没反应`, `出问题了` | status       |

Before asking users for any platform credentials, first read the Telegram setup section in `SKILL_DIR/README.md` to get the detailed step-by-step guidance. Present the relevant guide text to the user via AskUserQuestion — users often don't know where to find bot tokens or chat IDs, so showing the guide upfront saves back-and-forth.

## Runtime detection

Before executing any subcommand, detect which environment you are running in:

1. **Claude Code** — `AskUserQuestion` tool is available. Use it for interactive setup wizards.
2. **Codex / other** — `AskUserQuestion` is NOT available. Collect the needed values conversationally, then use the bundled Telegram setup helper to write `~/.codex-skill/config.env` automatically.

You can test this by checking if AskUserQuestion is in your available tools list.

## Config check (applies to `start`, `stop`, `status`)

Before running any subcommand other than `setup`, check if `~/.codex-skill/config.env` exists:

- **If it does NOT exist:**
  - In Claude Code: tell the user "No configuration found" and automatically start the `setup` wizard using AskUserQuestion.
  - In Codex: tell the user "No configuration found" and continue into the conversational `setup` flow so the bundled helper can write `~/.codex-skill/config.env` automatically.
- **If it exists:** proceed with the requested subcommand.

## Subcommands

### `setup`

Run an interactive setup wizard. In Claude Code, use `AskUserQuestion`. In Codex or other environments without `AskUserQuestion`, collect the same fields conversationally, then run the bundled Telegram setup helper to write the config automatically.

When AskUserQuestion IS available, collect input **one field at a time**. After each answer, confirm the value back to the user (masking secrets to last 4 chars only) before moving to the next question.

**Step 1 — Choose channels**

This fork supports **Telegram only**. Do not ask the user to choose channels.

**Step 2 — Collect tokens per channel**

Read the Telegram setup section in `SKILL_DIR/README.md` and present it. Collect one credential at a time:

- **Telegram**: Bot Token → confirm (masked) → tell the user to send any message to the bot → run the bundled helper to auto-detect Chat ID and write config → confirm → if auto-detect fails, fall back to manual Chat ID entry or Allowed User IDs. **Important:** At least one of Chat ID or Allowed User IDs must be set, otherwise the bot will reject all messages.

**Step 3 — General settings**

Ask for runtime, default working directory, model, and mode:

- **Runtime**: `claude` (default), `codex`, `auto`
  - `claude` — uses Claude Code CLI + Claude Agent SDK (requires `claude` CLI installed)
  - `codex` — uses OpenAI Codex SDK (requires `codex` CLI; auth via `codex auth login` or `OPENAI_API_KEY`)
  - `auto` — tries Claude first, falls back to Codex if Claude CLI not found
- **Working Directory**: default `$CWD`
- **Model** (optional): Leave blank to inherit the runtime's own default model. If the user wants to override, ask them to enter a model name. Do NOT hardcode or suggest specific model names — the available models change over time.
- **Mode**: `code` (default), `plan`, `ask`

**Step 4 — Write config and validate**

1. Show a final summary table with all settings (secrets masked to last 4 chars)
2. Ask user to confirm before writing
3. Use Bash to create directory structure: `mkdir -p ~/.codex-skill/{data,logs,runtime,data/messages}`
4. Prefer `npm run tg:setup -- --token <BOT_TOKEN> --runtime <RUNTIME> --workdir <WORKDIR> --mode <MODE> [--model <MODEL>] [--chat-id <ID>] [--allowed-users <CSV>] [--auto-approve true]` to create `~/.codex-skill/config.env`
5. If the helper is unavailable, use Write to create `~/.codex-skill/config.env`; then use Bash to set permissions: `chmod 600 ~/.codex-skill/config.env`
6. Validate tokens — use the Telegram check described in `SKILL_DIR/README.md` (`https://api.telegram.org/bot<TOKEN>/getMe`) before the user tries to start the daemon.
7. Report results with a summary table. If any validation fails, explain what might be wrong and how to fix it.
8. On success, tell the user: "Setup complete! Run `/codex-skill start` to start the bridge."

### `start`

**Pre-check:** Verify `~/.codex-skill/config.env` exists (see "Config check" above). Without it, the daemon will crash immediately and leave a stale PID file.

Run: `bash "SKILL_DIR/scripts/daemon.sh" start`

Show the output to the user. If it fails, tell the user:

- Run `status`: `/codex-skill status`
- Check the log file: `~/.codex-skill/logs/bridge.log`

### `stop`

Run: `bash "SKILL_DIR/scripts/daemon.sh" stop`

### `status`

Run: `bash "SKILL_DIR/scripts/daemon.sh" status`

## Notes

- Always mask secrets in output (show only last 4 characters) — users often share terminal output in bug reports, so exposed tokens would be a security incident.
- Always check for config.env before starting the daemon — without it the process crashes on startup and leaves a stale PID file that blocks future starts (requiring manual cleanup).
- The daemon runs as a background Node.js process managed by platform supervisor (launchd on macOS, setsid on Linux, WinSW/NSSM on Windows).
- Config persists at `~/.codex-skill/config.env` — survives across sessions.
