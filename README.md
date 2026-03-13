# Codex Skill

Telegram-only bridge for Claude Code or Codex.

[中文文档](README_CN.md)

## Install

Recommended:

```bash
npx skills add xn030523/Codex-IM-Skill
```

For local development:

```bash
git clone https://github.com/xn030523/Codex-IM-Skill.git ~/.claude/skills/codex-skill
cd ~/.claude/skills/codex-skill
npm install
npm run build
```

If you use Codex skills directly:

```bash
bash scripts/install-codex.sh
```

## Quick Start

1. Run `codex-skill setup`.
2. Paste your Telegram bot token.
3. Send one message to the bot.
4. Let setup auto-detect `Chat ID` and write `~/.codex-skill/config.env`.
5. Run `codex-skill start`.

## Telegram

Get a bot token:
- Message `@BotFather`
- Run `/newbot`
- Copy the token

Recommended default:
- Use `Chat ID`, not allowed user IDs
- `Chat ID` is easier for personal use

Manual fallback if setup cannot auto-detect `Chat ID`:

```bash
npm run tg:chat-id -- YOUR_BOT_TOKEN
```

Write config directly from the repo if needed:

```bash
npm run tg:setup -- --token YOUR_BOT_TOKEN --runtime codex --workdir "C:\path\to\project" --mode code
```

Notes:
- At least one of `CTI_TG_CHAT_ID` or `CTI_TG_ALLOWED_USERS` must be set
- If the bridge is already running, stop it before using `tg:chat-id`
- Group `Chat ID` values are negative numbers

## Commands

- `codex-skill setup`: create or update Telegram config
- `codex-skill start`: start the bridge daemon
- `codex-skill stop`: stop the bridge daemon
- `codex-skill status`: show process status
- `codex-skill logs`: show recent logs
- `codex-skill doctor`: run diagnostics

## Troubleshooting

`Bridge won't start`
- Run `codex-skill doctor`
- Check `node --version`
- Check `codex-skill logs`

`No messages received`
- Re-check the Telegram bot token
- Make sure you sent `/start` or another message to the bot
- Check `CTI_TG_ALLOWED_USERS` if you configured it

`Chat ID auto-detect failed`
- Stop the bridge if it is already running
- Send a fresh message to the bot
- Run `npm run tg:chat-id -- YOUR_BOT_TOKEN`

## Structure

- `src/main.ts`: daemon entry
- `src/config.ts`: config loading and bridge settings
- `src/file-store.ts`: JSON-backed bridge store
- `src/claude-provider.ts`: Claude runtime adapter
- `src/codex-provider.ts`: Codex runtime adapter
- `scripts/daemon.sh`: cross-platform daemon entry
- `scripts/supervisor-windows.ps1`: Windows process manager
- `scripts/telegram-cli.js`: Telegram helper CLI

## Development

```bash
npm install
npm run build
npm run typecheck
```
