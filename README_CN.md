# Codex Skill

只保留 Telegram 的 Claude Code / Codex 桥接。

[English](README.md)

## 安装

推荐：

```bash
npx skills add xn030523/Codex-IM-Skill
```

本地开发安装：

```bash
git clone https://github.com/xn030523/Codex-IM-Skill.git ~/.claude/skills/codex-skill
cd ~/.claude/skills/codex-skill
npm install
npm run build
```

如果你直接在 Codex 里用 skills：

```bash
bash scripts/install-codex.sh
```

## 快速开始

1. 运行 `codex-skill setup`
2. 粘贴 Telegram bot token
3. 给 bot 发一条消息
4. 让 setup 自动检测 `Chat ID` 并写入 `~/.codex-skill/config.env`
5. 运行 `codex-skill start`

## Telegram

获取 bot token：
- 打开 `@BotFather`
- 执行 `/newbot`
- 复制 token

默认推荐：
- 个人使用优先配 `Chat ID`
- 不要一开始就折腾用户白名单

如果 setup 没自动拿到 `Chat ID`，手动兜底：

```bash
npm run tg:chat-id -- YOUR_BOT_TOKEN
```

如果你想在仓库里一条命令直接写配置：

```bash
npm run tg:setup -- --token YOUR_BOT_TOKEN --runtime codex --workdir "C:\path\to\project" --mode code
```

说明：
- `CTI_TG_CHAT_ID` 和 `CTI_TG_ALLOWED_USERS` 至少要配一个
- 如果 bridge 已经在运行，先停掉再用 `tg:chat-id`
- 群聊的 `Chat ID` 一般是负数

## 常用命令

- `codex-skill setup`：创建或更新 Telegram 配置
- `codex-skill start`：启动守护进程
- `codex-skill stop`：停止守护进程
- `codex-skill status`：查看运行状态
- `codex-skill logs`：查看最近日志
- `codex-skill doctor`：运行诊断

## 故障排查

`启动失败`
- 运行 `codex-skill doctor`
- 检查 `node --version`
- 检查 `codex-skill logs`

`收不到消息`
- 重新检查 Telegram bot token
- 确认你已经给 bot 发过消息
- 如果配置了 `CTI_TG_ALLOWED_USERS`，确认当前用户在白名单里

`自动检测 Chat ID 失败`
- 如果 bridge 正在运行，先停掉
- 再给 bot 发一条新消息
- 运行 `npm run tg:chat-id -- YOUR_BOT_TOKEN`

## 结构

- `src/main.ts`：守护进程入口
- `src/config.ts`：配置加载和 bridge settings
- `src/file-store.ts`：JSON 存储
- `src/claude-provider.ts`：Claude 运行时适配
- `src/codex-provider.ts`：Codex 运行时适配
- `scripts/daemon.sh`：跨平台守护进程入口
- `scripts/supervisor-windows.ps1`：Windows 进程管理
- `scripts/telegram-cli.js`：Telegram 辅助命令

## 开发

```bash
npm install
npm run build
npm run typecheck
```
