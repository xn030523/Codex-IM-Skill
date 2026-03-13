/**
 * 配置加载与保存模块。
 *
 * 功能入口：
 * - 负责读取、保存 ~/.codex-skill/config.env，并把文本配置映射成 Config。
 * 输入输出：
 * - 输入为 KEY=VALUE 形式的 env 文件。
 * - 输出为强类型配置对象，以及上游 bridge 所需的 settings Map。
 * 边界与异常：
 * - 配置文件不存在时返回默认值，保证首次安装前也能安全读取配置结构。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface Config {
  runtime: "claude" | "codex" | "auto";
  enabledChannels: string[];
  defaultWorkDir: string;
  defaultModel?: string;
  defaultMode: string;
  // Telegram
  tgBotToken?: string;
  tgChatId?: string;
  tgAllowedUsers?: string[];
  // Auto-approve all tool permission requests without user confirmation
  autoApprove?: boolean;
}

export const CTI_HOME =
  process.env.CTI_HOME || path.join(os.homedir(), ".codex-skill");
export const CONFIG_PATH = path.join(CTI_HOME, "config.env");

function parseEnvFile(content: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    // 关键逻辑：兼容 "value" / 'value' 写法，避免引号被保留到真实配置值中。
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

function splitCsv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function readConfigEnv(): Map<string, string> {
  try {
    return parseEnvFile(fs.readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    // 边界与异常：首次安装还没有配置文件时，直接使用默认配置而不是抛错。
    return new Map<string, string>();
  }
}

function parseRuntime(rawRuntime: string | undefined): Config["runtime"] {
  return (
    ["claude", "codex", "auto"].includes(rawRuntime || "")
      ? rawRuntime
      : "claude"
  ) as Config["runtime"];
}

function buildConfigFromEnv(env: Map<string, string>): Config {
  const runtime = parseRuntime(env.get("CTI_RUNTIME"));

  return {
    runtime,
    enabledChannels: ["telegram"],
    defaultWorkDir: env.get("CTI_DEFAULT_WORKDIR") || process.cwd(),
    defaultModel: env.get("CTI_DEFAULT_MODEL") || undefined,
    defaultMode: env.get("CTI_DEFAULT_MODE") || "code",
    tgBotToken: env.get("CTI_TG_BOT_TOKEN") || undefined,
    tgChatId: env.get("CTI_TG_CHAT_ID") || undefined,
    tgAllowedUsers: splitCsv(env.get("CTI_TG_ALLOWED_USERS")),
    autoApprove: env.get("CTI_AUTO_APPROVE") === "true",
  };
}

export function loadConfig(): Config {
  return buildConfigFromEnv(readConfigEnv());
}

function formatEnvLine(key: string, value: string | undefined): string {
  if (value === undefined || value === "") return "";
  return `${key}=${value}\n`;
}

export function saveConfig(config: Config): void {
  let out = "";
  out += formatEnvLine("CTI_RUNTIME", config.runtime);
  out += formatEnvLine("CTI_ENABLED_CHANNELS", "telegram");
  out += formatEnvLine("CTI_DEFAULT_WORKDIR", config.defaultWorkDir);
  if (config.defaultModel)
    out += formatEnvLine("CTI_DEFAULT_MODEL", config.defaultModel);
  out += formatEnvLine("CTI_DEFAULT_MODE", config.defaultMode);
  out += formatEnvLine("CTI_TG_BOT_TOKEN", config.tgBotToken);
  out += formatEnvLine("CTI_TG_CHAT_ID", config.tgChatId);
  out += formatEnvLine(
    "CTI_TG_ALLOWED_USERS",
    config.tgAllowedUsers?.join(","),
  );

  fs.mkdirSync(CTI_HOME, { recursive: true });
  const tmpPath = CONFIG_PATH + ".tmp";
  // 关键逻辑：原子写入避免重配置过程中产生半截 config.env。
  fs.writeFileSync(tmpPath, out, { mode: 0o600 });
  fs.renameSync(tmpPath, CONFIG_PATH);
}

export function maskSecret(value: string): string {
  if (value.length <= 4) return "****";
  return "*".repeat(value.length - 4) + value.slice(-4);
}

function addSetting(
  settings: Map<string, string>,
  key: string,
  value: string | undefined,
): void {
  if (value !== undefined) {
    settings.set(key, value);
  }
}

export function buildBridgeSettings(config: Config): Map<string, string> {
  const settings = new Map<string, string>();
  settings.set("remote_bridge_enabled", "true");

  // 关键逻辑：Skill 配置字段与上游 bridge 的键名不同，这里负责做一层稳定映射。

  // ── Telegram ──
  // Upstream keys: telegram_bot_token, bridge_telegram_enabled,
  //   telegram_bridge_allowed_users, telegram_chat_id
  settings.set(
    "bridge_telegram_enabled",
    config.enabledChannels.includes("telegram") ? "true" : "false",
  );
  addSetting(settings, "telegram_bot_token", config.tgBotToken);
  if (config.tgAllowedUsers)
    settings.set(
      "telegram_bridge_allowed_users",
      config.tgAllowedUsers.join(","),
    );
  addSetting(settings, "telegram_chat_id", config.tgChatId);

  // Explicitly disable unsupported channels in this Telegram-only fork.
  settings.set("bridge_discord_enabled", "false");
  settings.set("bridge_feishu_enabled", "false");
  settings.set("bridge_qq_enabled", "false");

  // 默认值会影响新会话的工作目录、模型和权限模式。
  settings.set("bridge_default_work_dir", config.defaultWorkDir);
  if (config.defaultModel) {
    settings.set("bridge_default_model", config.defaultModel);
    settings.set("default_model", config.defaultModel);
  }
  settings.set("bridge_default_mode", config.defaultMode);

  return settings;
}
