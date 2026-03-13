/**
 * 日志模块。
 *
 * 功能入口：
 * - 接管 console.log / warn / error，把日志写入 ~/.codex-skill/logs/bridge.log。
 * 输入输出：
 * - 输入为运行时各模块打印的任意日志参数。
 * - 输出为脱敏后的日志文本，并在达到阈值后自动轮转。
 * 边界与异常：
 * - 只保留有限轮转文件，避免日志无限增长；常见 token / secret 会在写入前被掩码处理。
 */

import fs from "node:fs";
import path from "node:path";
import { CTI_HOME } from "./config.js";

const MASK_PATTERNS: RegExp[] = [
  /(?:token|secret|password|api_key)["']?\s*[:=]\s*["']?([^\s"',]+)/gi,
  /bot\d+:[A-Za-z0-9_-]{35}/g,
  /Bearer\s+[A-Za-z0-9._-]+/g,
];

export function maskSecrets(text: string): string {
  let result = text;
  for (const pattern of MASK_PATTERNS) {
    pattern.lastIndex = 0;
    // 关键逻辑：匹配到疑似密钥时只保留末尾少量字符，便于定位问题但不泄露完整凭据。
    result = result.replace(pattern, (match) => {
      if (match.length <= 4) return match;
      return "*".repeat(match.length - 4) + match.slice(-4);
    });
  }
  return result;
}

const LOG_DIR = path.join(CTI_HOME, "logs");
const LOG_PATH = path.join(LOG_DIR, "bridge.log");
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_ROTATED = 3;

let logStream: fs.WriteStream | null = null;

function openLogStream(): fs.WriteStream {
  return fs.createWriteStream(LOG_PATH, { flags: "a" });
}

function rotateIfNeeded(): void {
  try {
    const stat = fs.statSync(LOG_PATH);
    if (stat.size < MAX_LOG_SIZE) return;
  } catch {
    return; // 边界与异常：日志文件还不存在时无需轮转。
  }

  // 关键逻辑：先关闭当前流，再执行滚动重命名，避免 Windows 上文件句柄被占用。
  if (logStream) {
    logStream.end();
    logStream = null;
  }

  // 关键逻辑：固定保留 3 份历史日志，当前文件滚到 .1。
  const path3 = `${LOG_PATH}.${MAX_ROTATED}`;
  if (fs.existsSync(path3)) fs.unlinkSync(path3);

  for (let i = MAX_ROTATED - 1; i >= 1; i--) {
    const src = `${LOG_PATH}.${i}`;
    const dst = `${LOG_PATH}.${i + 1}`;
    if (fs.existsSync(src)) fs.renameSync(src, dst);
  }

  fs.renameSync(LOG_PATH, `${LOG_PATH}.1`);
  logStream = openLogStream();
}

export function setupLogger(): void {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  logStream = openLogStream();

  const write = (level: string, args: unknown[]) => {
    const timestamp = new Date().toISOString();
    const message = args
      .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
      .join(" ");
    const formatted = `[${timestamp}] [${level}] ${message}`;
    const masked = maskSecrets(formatted);

    rotateIfNeeded();
    logStream?.write(masked + "\n");
  };

  // 功能入口：统一劫持 console，避免各模块重复关心日志脱敏和轮转细节。
  console.log = (...args: unknown[]) => write("INFO", args);
  console.error = (...args: unknown[]) => write("ERROR", args);
  console.warn = (...args: unknown[]) => write("WARN", args);
}
