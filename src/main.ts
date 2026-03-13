/**
 * 守护进程入口文件。
 *
 * 功能入口：
 * - 负责装配配置、日志、存储、权限网关和运行时 provider，并启动 bridge。
 * 输入输出：
 * - 输入来自 ~/.codex-skill/config.env 与当前进程环境变量。
 * - 输出为后台 bridge 进程，以及 runtime/status/logs 等运行产物。
 * 边界与异常：
 * - 如果 Claude CLI 或 Codex 运行时不可用，会在启动阶段直接退出，避免后台进程以异常状态运行。
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { initBridgeContext } from "claude-to-im/src/lib/bridge/context.js";
import * as bridgeManager from "claude-to-im/src/lib/bridge/bridge-manager.js";
// Only register the Telegram adapter for this fork.
import "claude-to-im/src/lib/bridge/adapters/telegram-adapter.js";

import type { LLMProvider } from "claude-to-im/src/lib/bridge/host.js";
import { loadConfig, buildBridgeSettings, CTI_HOME } from "./config.js";
import type { Config } from "./config.js";
import { JsonBridgeStore } from "./file-store.js";
import {
  SDKLLMProvider,
  resolveClaudeCliPath,
  preflightCheck,
} from "./claude-provider.js";
import { PendingPermissions } from "./permission-gateway.js";
import { setupLogger } from "./logger.js";

const RUNTIME_DIR = path.join(CTI_HOME, "runtime");
const STATUS_FILE = path.join(RUNTIME_DIR, "status.json");
const PID_FILE = path.join(RUNTIME_DIR, "bridge.pid");

/**
 * Resolve the LLM provider based on the runtime setting.
 * - 'claude' (default): uses Claude Code SDK via SDKLLMProvider
 * - 'codex': uses @openai/codex-sdk via CodexProvider
 * - 'auto': tries Claude first, falls back to Codex
 */
async function resolveProvider(
  config: Config,
  pendingPerms: PendingPermissions,
): Promise<LLMProvider> {
  const runtime = config.runtime;

  if (runtime === "codex") {
    // 关键逻辑：显式指定 codex 时不再探测 Claude，避免混用运行时导致会话恢复错误。
    const { CodexProvider } = await import("./codex-provider.js");
    return new CodexProvider(pendingPerms);
  }

  if (runtime === "auto") {
    const cliPath = resolveClaudeCliPath();
    if (cliPath) {
      // 关键逻辑：auto 模式先做预检，只有 Claude CLI 真能启动才选用它。
      const check = preflightCheck(cliPath);
      if (check.ok) {
        console.log(
          `[codex-skill] Auto: using Claude CLI at ${cliPath} (${check.version})`,
        );
        return new SDKLLMProvider(pendingPerms, cliPath, config.autoApprove);
      }
      // 边界与异常：预检失败时回退到 Codex，而不是让错误拖到第一条消息时才暴露。
      console.warn(
        `[codex-skill] Auto: Claude CLI at ${cliPath} failed preflight: ${check.error}\n` +
          `  Falling back to Codex.`,
      );
    } else {
      console.log(
        "[codex-skill] Auto: Claude CLI not found, falling back to Codex",
      );
    }
    const { CodexProvider } = await import("./codex-provider.js");
    return new CodexProvider(pendingPerms);
  }

  // 默认模式是 Claude；此时缺少 CLI 视为致命问题。
  const cliPath = resolveClaudeCliPath();
  if (!cliPath) {
    console.error(
      "[codex-skill] FATAL: Cannot find the `claude` CLI executable.\n" +
        "  Tried: CTI_CLAUDE_CODE_EXECUTABLE env, /usr/local/bin/claude, /opt/homebrew/bin/claude, ~/.npm-global/bin/claude, ~/.local/bin/claude\n" +
        "  Fix: Install Claude Code CLI (https://docs.anthropic.com/en/docs/claude-code) or set CTI_CLAUDE_CODE_EXECUTABLE=/path/to/claude\n" +
        "  Or: Set CTI_RUNTIME=codex to use Codex instead",
    );
    process.exit(1);
  }

  // 关键逻辑：claude 模式会在启动阶段做完整预检，避免启动一个注定不可用的桥接进程。
  const check = preflightCheck(cliPath);
  if (check.ok) {
    console.log(
      `[codex-skill] CLI preflight OK: ${cliPath} (${check.version})`,
    );
  } else {
    console.error(
      `[codex-skill] FATAL: Claude CLI preflight check failed.\n` +
        `  Path: ${cliPath}\n` +
        `  Error: ${check.error}\n` +
        `  Fix:\n` +
        `    1. Install Claude Code CLI >= 2.x: https://docs.anthropic.com/en/docs/claude-code\n` +
        `    2. Or set CTI_CLAUDE_CODE_EXECUTABLE=/path/to/correct/claude\n` +
        `    3. Or set CTI_RUNTIME=auto to fall back to Codex`,
    );
    process.exit(1);
  }

  return new SDKLLMProvider(pendingPerms, cliPath, config.autoApprove);
}

interface StatusInfo {
  running: boolean;
  pid?: number;
  runId?: string;
  startedAt?: string;
  channels?: string[];
  lastExitReason?: string;
}

function writeStatus(info: StatusInfo): void {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  // 关键逻辑：保留旧状态中的 lastExitReason 等字段，便于 status/doctor 诊断。
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(fs.readFileSync(STATUS_FILE, "utf-8"));
  } catch {
    /* first write */
  }
  const merged = { ...existing, ...info };
  const tmp = STATUS_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), "utf-8");
  fs.renameSync(tmp, STATUS_FILE);
}

async function main(): Promise<void> {
  // 功能入口：先初始化配置与日志，后续 console 输出都会写入脱敏日志文件。
  const config = loadConfig();
  setupLogger();

  const runId = crypto.randomUUID();
  console.log(`[codex-skill] Starting bridge (run_id: ${runId})`);

  // 关键逻辑：把 Skill 自己的配置翻译成上游 claude-to-im bridge 的 settings。
  const settings = buildBridgeSettings(config);
  const store = new JsonBridgeStore(settings);
  const pendingPerms = new PendingPermissions();
  const llm = await resolveProvider(config, pendingPerms);
  console.log(`[codex-skill] Runtime: ${config.runtime}`);

  const gateway = {
    resolvePendingPermission: (
      id: string,
      resolution: { behavior: "allow" | "deny"; message?: string },
    ) => pendingPerms.resolve(id, resolution),
  };

  initBridgeContext({
    store,
    llm,
    permissions: gateway,
    lifecycle: {
      onBridgeStart: () => {
        // 关键逻辑：使用真实 Node 进程 PID 覆盖脚本层临时 PID，保证 stop/status 判断准确。
        fs.mkdirSync(RUNTIME_DIR, { recursive: true });
        fs.writeFileSync(PID_FILE, String(process.pid), "utf-8");
        writeStatus({
          running: true,
          pid: process.pid,
          runId,
          startedAt: new Date().toISOString(),
          channels: config.enabledChannels,
        });
        console.log(
          `[codex-skill] Bridge started (PID: ${process.pid}, channels: ${config.enabledChannels.join(", ")})`,
        );
      },
      onBridgeStop: () => {
        writeStatus({ running: false });
        console.log("[codex-skill] Bridge stopped");
      },
    },
  });

  await bridgeManager.start();

  // 边界与异常：退出时先拒绝所有挂起权限请求，避免 canUseTool 永久阻塞。
  let shuttingDown = false;
  const shutdown = async (signal?: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const reason = signal ? `signal: ${signal}` : "shutdown requested";
    console.log(`[codex-skill] Shutting down (${reason})...`);
    pendingPerms.denyAll();
    await bridgeManager.stop();
    writeStatus({ running: false, lastExitReason: reason });
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGHUP", () => shutdown("SIGHUP"));

  // 边界与异常：把未捕获错误写入日志和 status.json，方便后续排障。
  process.on("unhandledRejection", (reason) => {
    console.error(
      "[codex-skill] unhandledRejection:",
      reason instanceof Error ? reason.stack || reason.message : reason,
    );
    writeStatus({
      running: false,
      lastExitReason: `unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}`,
    });
  });
  process.on("uncaughtException", (err) => {
    console.error(
      "[codex-skill] uncaughtException:",
      err.stack || err.message,
    );
    writeStatus({
      running: false,
      lastExitReason: `uncaughtException: ${err.message}`,
    });
    process.exit(1);
  });
  process.on("beforeExit", (code) => {
    console.log(`[codex-skill] beforeExit (code: ${code})`);
  });
  process.on("exit", (code) => {
    console.log(`[codex-skill] exit (code: ${code})`);
  });

  // 边界与异常：bridge 空闲时可能没有活跃事件，这里用心跳防止 Node 进程提前退出。
  setInterval(() => {
    /* keepalive */
  }, 45_000);
}

main().catch((err) => {
  console.error(
    "[codex-skill] Fatal error:",
    err instanceof Error ? err.stack || err.message : err,
  );
  try {
    writeStatus({
      running: false,
      lastExitReason: `fatal: ${err instanceof Error ? err.message : String(err)}`,
    });
  } catch {
    /* ignore */
  }
  process.exit(1);
});
