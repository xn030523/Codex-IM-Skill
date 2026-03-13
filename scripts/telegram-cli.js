#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function parseArgs(argv) {
  const args = new Map();
  const positional = [];

  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    if (!current.startsWith("--")) {
      positional.push(current);
      continue;
    }

    const key = current.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args.set(key, "true");
      continue;
    }

    args.set(key, next);
    i += 1;
  }

  return { positional, args };
}

function parseEnvFile(content) {
  const entries = new Map();
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    entries.set(key, value);
  }
  return entries;
}

function readExistingConfig(configPath) {
  try {
    return parseEnvFile(fs.readFileSync(configPath, "utf-8"));
  } catch {
    return new Map();
  }
}

function formatEnvLine(key, value) {
  if (value === undefined || value === "") return "";
  return `${key}=${value}\n`;
}

function readBool(value, fallback = false) {
  if (value === undefined) return fallback;
  return value === "true";
}

function maskSecret(value) {
  if (!value) return "****";
  if (value.length <= 4) return "****";
  return `${"*".repeat(value.length - 4)}${value.slice(-4)}`;
}

function formatChatLabel(chat) {
  if (!chat || typeof chat !== "object") return "unknown";
  if (chat.type === "private") {
    return chat.username || chat.first_name || "private chat";
  }
  return chat.title || chat.username || chat.type || "chat";
}

async function fetchTelegramUpdates(token) {
  const url = `https://api.telegram.org/bot${token}/getUpdates`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Telegram API returned HTTP ${response.status}`);
  }

  const data = await response.json();
  if (!data.ok) {
    throw new Error(data.description || "Telegram API request failed");
  }

  return Array.isArray(data.result) ? data.result : [];
}

async function detectLatestTelegramChat(token) {
  const updates = await fetchTelegramUpdates(token);
  const entries = updates
    .map((update) => update.message || update.edited_message || update.channel_post)
    .filter((message) => message && message.chat && message.chat.id !== undefined);

  if (entries.length === 0) {
    return null;
  }

  const preferred =
    [...entries].reverse().find((message) => message.chat?.type === "private") ||
    entries[entries.length - 1];

  return {
    chat: preferred.chat,
    from: preferred.from || {},
  };
}

function printNoChatFound() {
  console.error("No chat found in getUpdates.");
  console.error("Send a message to your bot first, then run this command again.");
  console.error(
    "If your bridge is already running, stop it first so updates are not consumed.",
  );
}

async function runChatIdCommand(token) {
  const detected = await detectLatestTelegramChat(token);
  if (!detected) {
    printNoChatFound();
    process.exit(2);
  }

  const { chat, from } = detected;
  console.log(`Chat ID: ${chat.id}`);
  console.log(`Chat Type: ${chat.type || "unknown"}`);
  console.log(`Chat Name: ${formatChatLabel(chat)}`);
  if (from.id !== undefined) {
    console.log(`Sender ID: ${from.id}`);
  }
  console.log("");
  console.log("Use this value as CTI_TG_CHAT_ID.");
}

async function runSetupCommand(args) {
  const token = args.get("token");
  if (!token) {
    console.error(
      "Usage: npm run tg:setup -- --token <BOT_TOKEN> [--runtime codex] [--workdir PATH] [--mode code] [--model MODEL] [--chat-id ID] [--allowed-users CSV] [--auto-approve true|false]",
    );
    process.exit(1);
  }

  const ctiHome = process.env.CTI_HOME || path.join(os.homedir(), ".codex-skill");
  const configPath = path.join(ctiHome, "config.env");
  const existing = readExistingConfig(configPath);

  const runtime = args.get("runtime") || existing.get("CTI_RUNTIME") || "claude";
  const workdir =
    args.get("workdir") || existing.get("CTI_DEFAULT_WORKDIR") || process.cwd();
  const mode = args.get("mode") || existing.get("CTI_DEFAULT_MODE") || "code";
  const model = args.get("model") || existing.get("CTI_DEFAULT_MODEL") || undefined;
  const autoApprove = readBool(
    args.get("auto-approve"),
    existing.get("CTI_AUTO_APPROVE") === "true",
  );

  const allowedUsers =
    args.get("allowed-users") || existing.get("CTI_TG_ALLOWED_USERS") || undefined;
  let chatId = args.get("chat-id") || existing.get("CTI_TG_CHAT_ID") || undefined;
  let detectedChat = null;

  if (!chatId && !allowedUsers) {
    detectedChat = await detectLatestTelegramChat(token);
    if (!detectedChat) {
      console.error("Unable to auto-detect Telegram Chat ID.");
      console.error("Send a message to your bot first, then rerun this command.");
      console.error(
        "If your bridge is already running, stop it first so updates are not consumed.",
      );
      process.exit(2);
    }
    chatId = String(detectedChat.chat.id);
  }

  if (!chatId && !allowedUsers) {
    console.error("At least one of Chat ID or allowed users must be configured.");
    process.exit(1);
  }

  fs.mkdirSync(path.join(ctiHome, "data", "messages"), { recursive: true });
  fs.mkdirSync(path.join(ctiHome, "logs"), { recursive: true });
  fs.mkdirSync(path.join(ctiHome, "runtime"), { recursive: true });

  let out = "";
  out += formatEnvLine("CTI_RUNTIME", runtime);
  out += formatEnvLine("CTI_ENABLED_CHANNELS", "telegram");
  out += formatEnvLine("CTI_DEFAULT_WORKDIR", workdir);
  out += formatEnvLine("CTI_DEFAULT_MODEL", model);
  out += formatEnvLine("CTI_DEFAULT_MODE", mode);
  out += formatEnvLine("CTI_TG_BOT_TOKEN", token);
  out += formatEnvLine("CTI_TG_CHAT_ID", chatId);
  out += formatEnvLine("CTI_TG_ALLOWED_USERS", allowedUsers);
  if (autoApprove) {
    out += formatEnvLine("CTI_AUTO_APPROVE", "true");
  }

  const passthroughKeys = [
    "CTI_CLAUDE_CODE_EXECUTABLE",
    "CTI_CODEX_API_KEY",
    "CTI_CODEX_BASE_URL",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
  ];
  for (const key of passthroughKeys) {
    out += formatEnvLine(key, existing.get(key));
  }

  const tmpPath = `${configPath}.tmp`;
  fs.writeFileSync(tmpPath, out, { mode: 0o600 });
  fs.renameSync(tmpPath, configPath);

  console.log("Telegram config written:");
  console.log(`  CTI_RUNTIME=${runtime}`);
  console.log(`  CTI_DEFAULT_WORKDIR=${workdir}`);
  console.log(`  CTI_DEFAULT_MODE=${mode}`);
  if (model) {
    console.log(`  CTI_DEFAULT_MODEL=${model}`);
  }
  console.log(`  CTI_TG_BOT_TOKEN=${maskSecret(token)}`);
  if (chatId) {
    console.log(`  CTI_TG_CHAT_ID=${chatId}`);
  }
  if (allowedUsers) {
    console.log(`  CTI_TG_ALLOWED_USERS=${allowedUsers}`);
  }
  if (autoApprove) {
    console.log("  CTI_AUTO_APPROVE=true");
  }
  if (detectedChat) {
    console.log("");
    console.log("Auto-detected chat:");
    console.log(`  Chat Type: ${detectedChat.chat.type || "unknown"}`);
    console.log(`  Chat Name: ${formatChatLabel(detectedChat.chat)}`);
  }
}

async function main() {
  const { positional, args } = parseArgs(process.argv.slice(2));
  const command = positional[0];

  if (command === "chat-id") {
    const token = positional[1] || args.get("token");
    if (!token) {
      console.error(
        "Usage: npm run tg:chat-id -- <BOT_TOKEN> or node scripts/telegram-cli.js chat-id <BOT_TOKEN>",
      );
      process.exit(1);
    }
    await runChatIdCommand(token);
    return;
  }

  if (command === "setup") {
    await runSetupCommand(args);
    return;
  }

  console.error("Usage:");
  console.error("  npm run tg:chat-id -- <BOT_TOKEN>");
  console.error(
    "  npm run tg:setup -- --token <BOT_TOKEN> [--runtime codex] [--workdir PATH] [--mode code]",
  );
  process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
