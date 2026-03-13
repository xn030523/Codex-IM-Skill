/**
 * Claude 运行时 provider。
 *
 * 功能入口：
 * - 基于 @anthropic-ai/claude-agent-sdk 的 query() 调用 Claude CLI，并把结果转换成 bridge 可消费的 SSE 流。
 * 输入输出：
 * - 输入为 bridge 层整理好的 prompt、会话 ID、工作目录、权限模式和附件。
 * - 输出为标准化 ReadableStream<SSE>，供上游 bridge 转发给 IM 平台。
 * 边界与异常：
 * - 对 CLI 版本、参数兼容性、认证失败、模型跨运行时污染等问题都做了提前保护和错误翻译。
 */

import fs from "node:fs";
import { execSync } from "node:child_process";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  SDKMessage,
  PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  LLMProvider,
  StreamChatParams,
  FileAttachment,
} from "claude-to-im/src/lib/bridge/host.js";
import type { PendingPermissions } from "./permission-gateway.js";

import { sseEvent } from "./sse.js";

// 环境隔离：守护进程会清理敏感或跨运行时变量，避免 Claude/Codex 互相污染。

/** 始终透传给 Claude CLI 子进程的环境变量。 */
const ENV_WHITELIST = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "TEMP",
  "TMP",
  "TERM",
  "COLORTERM",
  "NODE_PATH",
  "NODE_EXTRA_CA_CERTS",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "SSH_AUTH_SOCK",
]);

/** 无论何种隔离模式都要剔除的变量前缀。 */
const ENV_ALWAYS_STRIP = ["CLAUDECODE"];

// 认证错误识别：把 CLI 登录问题和 API 凭据问题区分开，便于给用户更准确的修复建议。

/** Patterns indicating the local CLI is not logged in (fixable via `claude auth login`). */
const CLI_AUTH_PATTERNS = [
  /not logged in/i,
  /please run \/login/i,
  /loggedIn['":\s]*false/i,
];

/**
 * Patterns indicating an API-level credential failure (wrong key, expired token, org restriction).
 * Must be specific to API/auth context — avoid matching local file permissions, tool denials,
 * or generic HTTP 403s that may have non-auth causes.
 */
const API_AUTH_PATTERNS = [
  /unauthorized/i,
  /invalid.*api.?key/i,
  /authentication.*failed/i,
  /does not have access/i,
  /401\b/,
];

export type AuthErrorKind = "cli" | "api" | false;

/**
 * Classify an error message as a CLI login issue, an API credential issue, or neither.
 * Returns 'cli' for local auth problems, 'api' for remote credential problems, false otherwise.
 */
export function classifyAuthError(text: string): AuthErrorKind {
  if (CLI_AUTH_PATTERNS.some((re) => re.test(text))) return "cli";
  if (API_AUTH_PATTERNS.some((re) => re.test(text))) return "api";
  return false;
}

/** Backwards-compatible: returns true for any auth/credential error. */
export function isAuthError(text: string): boolean {
  return classifyAuthError(text) !== false;
}

const CLI_AUTH_USER_MESSAGE =
  "Claude CLI is not logged in. Run `claude auth login`, then restart the bridge.";

const API_AUTH_USER_MESSAGE =
  "API credential error. Check your ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN in config.env, " +
  "or verify your organization has access to the requested model.";

// ── Cross-runtime model guard ──

const NON_CLAUDE_MODEL_RE =
  /^(gpt-|o[1-9][-_]|codex[-_]|davinci|text-|openai\/)/i;

/** 判断模型名是否明显属于非 Claude 运行时，用于清理跨运行时残留会话数据。 */
export function isNonClaudeModel(model?: string): boolean {
  return !!model && NON_CLAUDE_MODEL_RE.test(model);
}

/**
 * 为 Claude CLI 子进程构建干净环境。
 *
 * CTI_ENV_ISOLATION (default "inherit"):
 *   "inherit" — full parent env minus CLAUDECODE (recommended; daemon
 *               already runs in a clean launchd/setsid environment)
 *   "strict"  — only whitelist + CTI_* + ANTHROPIC_* from config.env
 */
export function buildSubprocessEnv(): Record<string, string> {
  const mode = process.env.CTI_ENV_ISOLATION || "inherit";
  const out: Record<string, string> = {};

  if (mode === "inherit") {
    // 关键逻辑：inherit 模式尽量保留当前环境，只移除已知会污染 CLI 的变量。
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined) continue;
      if (ENV_ALWAYS_STRIP.includes(k)) continue;
      out[k] = v;
    }
  } else {
    // 关键逻辑：strict 模式只保留白名单和必要前缀，适合排查环境泄漏问题。
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined) continue;
      if (ENV_WHITELIST.has(k)) {
        out[k] = v;
        continue;
      }
      // Pass through CTI_* so skill config is available
      if (k.startsWith("CTI_")) {
        out[k] = v;
        continue;
      }
    }
    // 第三方 API 提供商依赖 ANTHROPIC_* 变量，这里必须显式透传。
    const runtime = process.env.CTI_RUNTIME || "claude";
    if (runtime === "claude" || runtime === "auto") {
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined && k.startsWith("ANTHROPIC_")) out[k] = v;
      }
    }

    // In codex/auto mode, pass through OPENAI_* / CODEX_* env vars
    if (runtime === "codex" || runtime === "auto") {
      for (const [k, v] of Object.entries(process.env)) {
        if (
          v !== undefined &&
          (k.startsWith("OPENAI_") || k.startsWith("CODEX_"))
        )
          out[k] = v;
      }
    }
  }

  return out;
}

// Claude CLI 预检：在真正发消息前确认 CLI 版本、参数兼容性与可执行性。

/** Minimum major version of Claude CLI required by the SDK. */
const MIN_CLI_MAJOR = 2;

/**
 * Parse a version string like "2.3.1" or "claude 2.3.1" into a major number.
 * Returns undefined if parsing fails.
 */
export function parseCliMajorVersion(
  versionOutput: string,
): number | undefined {
  const m = versionOutput.match(/(\d+)\.\d+/);
  return m ? parseInt(m[1], 10) : undefined;
}

/**
 * Run `claude --version` at a given path and return the version string.
 * Returns undefined on failure.
 */
function getCliVersion(
  cliPath: string,
  env?: Record<string, string>,
): string | undefined {
  try {
    return execSync(`"${cliPath}" --version`, {
      encoding: "utf-8",
      timeout: 10_000,
      env: env || buildSubprocessEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return undefined;
  }
}

/**
 * Flags that the SDK passes to the CLI subprocess.
 * If `claude --help` doesn't mention these, the CLI build is incompatible.
 */
const REQUIRED_CLI_FLAGS = [
  "output-format",
  "input-format",
  "permission-mode",
  "setting-sources",
];

/**
 * Check `claude --help` for required flags.
 * Returns the list of missing flags (empty = all present).
 */
function checkRequiredFlags(
  cliPath: string,
  env?: Record<string, string>,
): string[] {
  let helpText: string;
  try {
    helpText = execSync(`"${cliPath}" --help`, {
      encoding: "utf-8",
      timeout: 10_000,
      env: env || buildSubprocessEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    // Can't run --help; don't block on this — version check is primary
    return [];
  }
  return REQUIRED_CLI_FLAGS.filter((flag) => !helpText.includes(flag));
}

/**
 * Check if a CLI path points to a compatible (>= 2.x) Claude CLI
 * with the required flags for SDK integration.
 * Returns { compatible, version, ... } or undefined if the CLI cannot run at all.
 */
export function checkCliCompatibility(
  cliPath: string,
  env?: Record<string, string>,
):
  | {
      compatible: boolean;
      version: string;
      major: number | undefined;
      missingFlags?: string[];
    }
  | undefined {
  const version = getCliVersion(cliPath, env);
  if (!version) return undefined;
  const major = parseCliMajorVersion(version);
  if (major === undefined || major < MIN_CLI_MAJOR) {
    return { compatible: false, version, major };
  }
  // Version OK — verify required flags exist
  const missing = checkRequiredFlags(cliPath, env);
  return {
    compatible: missing.length === 0,
    version,
    major,
    missingFlags: missing.length > 0 ? missing : undefined,
  };
}

/**
 * Run a lightweight preflight check to verify the claude CLI can start
 * and supports the flags required by the SDK.
 * Returns { ok, version?, error? }.
 */
export function preflightCheck(cliPath: string): {
  ok: boolean;
  version?: string;
  error?: string;
} {
  const cleanEnv = buildSubprocessEnv();
  const compat = checkCliCompatibility(cliPath, cleanEnv);
  if (!compat) {
    return { ok: false, error: `claude CLI at "${cliPath}" failed to execute` };
  }
  if (compat.major !== undefined && compat.major < MIN_CLI_MAJOR) {
    return {
      ok: false,
      version: compat.version,
      error:
        `claude CLI version ${compat.version} is too old (need >= ${MIN_CLI_MAJOR}.x). ` +
        `This is likely an npm-installed 1.x CLI. Install the native CLI: https://docs.anthropic.com/en/docs/claude-code`,
    };
  }
  if (compat.missingFlags) {
    return {
      ok: false,
      version: compat.version,
      error:
        `claude CLI ${compat.version} is missing required flags: ${compat.missingFlags.join(", ")}. ` +
        `Update the CLI: npm update -g @anthropic-ai/claude-code`,
    };
  }
  return { ok: true, version: compat.version };
}

// ── Claude CLI path resolution ──

function isExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 找出 PATH 中所有 `claude` 可执行文件。
 * Returns an array of absolute paths.
 */
function findAllInPath(): string[] {
  if (process.platform === "win32") {
    try {
      return execSync("where claude", { encoding: "utf-8", timeout: 3000 })
        .trim()
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }
  try {
    // `which -a` lists all matches, not just the first
    return execSync("which -a claude", { encoding: "utf-8", timeout: 3000 })
      .trim()
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * 解析 Claude CLI 路径。
 *
 * Priority:
 *   1. CTI_CLAUDE_CODE_EXECUTABLE env var (explicit override)
 *   2. All `claude` executables in PATH — pick first compatible (>= 2.x)
 *   3. Common install locations — pick first compatible (>= 2.x)
 *
 * This multi-candidate approach handles the common scenario where
 * nvm/npm puts an old 1.x claude in PATH before the native 2.x CLI.
 */
export function resolveClaudeCliPath(): string | undefined {
  // 关键逻辑：显式指定的 CTI_CLAUDE_CODE_EXECUTABLE 优先级最高。
  const fromEnv = process.env.CTI_CLAUDE_CODE_EXECUTABLE;
  if (fromEnv && isExecutable(fromEnv)) return fromEnv;

  // 候选来源包括 PATH 和常见安装位置，专门处理 1.x / 2.x CLI 并存的问题。
  const isWindows = process.platform === "win32";
  const pathCandidates = findAllInPath();
  const wellKnown = isWindows
    ? [
        process.env.LOCALAPPDATA
          ? `${process.env.LOCALAPPDATA}\\Programs\\claude\\claude.exe`
          : "",
        "C:\\Program Files\\claude\\claude.exe",
      ].filter(Boolean)
    : [
        `${process.env.HOME}/.claude/local/claude`,
        `${process.env.HOME}/.local/bin/claude`,
        "/usr/local/bin/claude",
        "/opt/homebrew/bin/claude",
        `${process.env.HOME}/.npm-global/bin/claude`,
      ];

  // Deduplicate while preserving order
  const seen = new Set<string>();
  const allCandidates: string[] = [];
  for (const p of [...pathCandidates, ...wellKnown]) {
    if (p && !seen.has(p)) {
      seen.add(p);
      allCandidates.push(p);
    }
  }

  // 关键逻辑：只接受“可执行 + 版本兼容 + 参数兼容”的候选项。
  let firstUnverifiable: string | undefined;
  for (const p of allCandidates) {
    if (!isExecutable(p)) continue;

    const compat = checkCliCompatibility(p);
    if (compat?.compatible) {
      if (p !== pathCandidates[0] && pathCandidates.length > 0) {
        console.log(
          `[claude-provider] Skipping incompatible CLI at "${pathCandidates[0]}", using "${p}" (${compat.version})`,
        );
      }
      return p;
    }
    if (compat) {
      // 边界与异常：已知版本过旧的 CLI 直接跳过，避免误选后在运行时崩溃。
      console.warn(
        `[claude-provider] CLI at "${p}" is version ${compat.version} (need >= ${MIN_CLI_MAJOR}.x), skipping`,
      );
    } else if (!firstUnverifiable) {
      // Executable exists but --version failed (timeout, crash, etc.)
      // Keep as last-resort fallback only if NO candidate had a parseable version
      firstUnverifiable = p;
    }
  }

  // Only fall back to an unverifiable executable — never to a known-old one.
  // This avoids silently using a 1.x CLI that will crash on first message.
  return firstUnverifiable;
}

// 多模态输入构建：把文本与图片附件整理成 Claude SDK 可接受的消息结构。

type ImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

const SUPPORTED_IMAGE_TYPES = new Set<string>([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
]);

/**
 * Build a prompt for query(). When files are present, returns an async
 * iterable that yields a single SDKUserMessage with multi-modal content
 * (image blocks + text). Otherwise returns the plain text string.
 */
function buildPrompt(
  text: string,
  files?: FileAttachment[],
):
  | string
  | AsyncIterable<{
      type: "user";
      message: { role: "user"; content: unknown[] };
      parent_tool_use_id: null;
      session_id: string;
    }> {
  const imageFiles = files?.filter((f) => SUPPORTED_IMAGE_TYPES.has(f.type));
  if (!imageFiles || imageFiles.length === 0) return text;

  const contentBlocks: unknown[] = [];

  for (const file of imageFiles) {
    contentBlocks.push({
      type: "image",
      source: {
        type: "base64",
        media_type: (file.type === "image/jpg"
          ? "image/jpeg"
          : file.type) as ImageMediaType,
        data: file.data,
      },
    });
  }

  if (text.trim()) {
    contentBlocks.push({ type: "text", text });
  }

  const msg = {
    type: "user" as const,
    message: { role: "user" as const, content: contentBlocks },
    parent_tool_use_id: null,
    session_id: "",
  };

  return (async function* () {
    yield msg;
  })();
}

/**
 * 流式状态容器。
 *
 * Key distinction:
 *   hasReceivedResult — set when the SDK delivers a `result` message
 *     (success OR structured error). This means the CLI completed its
 *     business logic; any subsequent "process exited with code 1" is
 *     just the transport tearing down and should be suppressed.
 *
 *   hasStreamedText — set when at least one text_delta was emitted.
 *     Used to distinguish "partial output + crash" (real failure, must
 *     emit error) from "business error only in assistant block" (use
 *     lastAssistantText instead of generic error).
 */
export interface StreamState {
  /** 收到 result 后置为 true，用于抑制后续仅属于传输层的“进程退出”噪声。 */
  hasReceivedResult: boolean;
  /** 只要流式文本开始输出就置为 true，用于识别“输出半截就崩了”的情况。 */
  hasStreamedText: boolean;
  /** 最终 assistant 文本的完整缓存，用于在 CLI 崩溃时尽量保留更有价值的业务错误信息。 */
  lastAssistantText: string;
}

export class SDKLLMProvider implements LLMProvider {
  private cliPath: string | undefined;
  private autoApprove: boolean;

  constructor(
    private pendingPerms: PendingPermissions,
    cliPath?: string,
    autoApprove = false,
  ) {
    this.cliPath = cliPath;
    this.autoApprove = autoApprove;
  }

  streamChat(params: StreamChatParams): ReadableStream<string> {
    const pendingPerms = this.pendingPerms;
    const cliPath = this.cliPath;
    const autoApprove = this.autoApprove;

    return new ReadableStream({
      start(controller) {
        (async () => {
          // Ring-buffer for recent stderr output (max 4 KB)
          const MAX_STDERR = 4096;
          let stderrBuf = "";
          const state: StreamState = {
            hasReceivedResult: false,
            hasStreamedText: false,
            lastAssistantText: "",
          };

          try {
            const cleanEnv = buildSubprocessEnv();

            // 关键逻辑：清理之前 Codex 会话残留的模型名，避免 Claude CLI 因模型不兼容而退出。
            let model = params.model;
            if (isNonClaudeModel(model)) {
              console.warn(
                `[claude-provider] Ignoring non-Claude model "${model}", using CLI default`,
              );
              model = undefined;
            }

            // 边界与异常：默认让 CLI 自己选模型，减少“当前账号无权限访问该模型”导致的启动失败。
            const passModel = !!process.env.CTI_DEFAULT_MODEL;
            if (model && !passModel) {
              console.log(
                `[claude-provider] Skipping model "${model}", using CLI default (set CTI_DEFAULT_MODEL to override)`,
              );
              model = undefined;
            }

            const queryOptions: Record<string, unknown> = {
              cwd: params.workingDirectory,
              model,
              resume: params.sdkSessionId || undefined,
              abortController: params.abortController,
              permissionMode:
                (params.permissionMode as "default" | "acceptEdits" | "plan") ||
                undefined,
              includePartialMessages: true,
              env: cleanEnv,
              stderr: (data: string) => {
                stderrBuf += data;
                if (stderrBuf.length > MAX_STDERR) {
                  stderrBuf = stderrBuf.slice(-MAX_STDERR);
                }
              },
              canUseTool: async (
                toolName: string,
                input: Record<string, unknown>,
                opts: { toolUseID: string; suggestions?: string[] },
              ): Promise<PermissionResult> => {
                // 关键逻辑：某些平台没有交互式按钮时，可以通过 autoApprove 走全自动模式。
                if (autoApprove) {
                  return { behavior: "allow" as const, updatedInput: input };
                }

                // 把权限请求抛回 bridge，再由 bridge 转发到 IM 平台让用户审批。
                controller.enqueue(
                  sseEvent("permission_request", {
                    permissionRequestId: opts.toolUseID,
                    toolName,
                    toolInput: input,
                    suggestions: opts.suggestions || [],
                  }),
                );

                // 关键逻辑：这里会阻塞等待用户审批结果，形成“工具调用前确认”的闭环。
                const result = await pendingPerms.waitFor(opts.toolUseID);

                if (result.behavior === "allow") {
                  return { behavior: "allow" as const, updatedInput: input };
                }
                return {
                  behavior: "deny" as const,
                  message: result.message || "Denied by user",
                };
              },
            };
            if (cliPath) {
              queryOptions.pathToClaudeCodeExecutable = cliPath;
            }

            const prompt = buildPrompt(params.prompt, params.files);
            const q = query({
              prompt: prompt as Parameters<typeof query>[0]["prompt"],
              options: queryOptions as Parameters<typeof query>[0]["options"],
            });

            for await (const msg of q) {
              handleMessage(msg, controller, state);
            }

            controller.close();
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(
              "[claude-provider] SDK query error:",
              err instanceof Error ? err.stack || err.message : err,
            );
            if (stderrBuf) {
              console.error(
                "[claude-provider] stderr from CLI:",
                stderrBuf.trim(),
              );
            }

            const isTransportExit = message.includes(
              "process exited with code",
            );

            // 边界与异常：如果业务结果已经收到，再出现的退出码通常只是传输层收尾噪声。
            if (state.hasReceivedResult && isTransportExit) {
              console.log(
                "[claude-provider] Suppressing transport error — result already received",
              );
              controller.close();
              return;
            }

            // 关键逻辑：如果 assistant 文本里已经给出了明确业务错误，优先把这段信息返回给用户。
            if (
              state.lastAssistantText &&
              classifyAuthError(state.lastAssistantText)
            ) {
              controller.enqueue(sseEvent("text", state.lastAssistantText));
              controller.close();
              return;
            }

            // 边界与异常：若只输出了部分内容就崩溃，必须明确告诉用户本次响应不完整。
            const authKind =
              classifyAuthError(message) || classifyAuthError(stderrBuf);
            let userMessage: string;
            if (authKind === "cli") {
              userMessage = CLI_AUTH_USER_MESSAGE;
            } else if (authKind === "api") {
              userMessage = API_AUTH_USER_MESSAGE;
            } else if (isTransportExit) {
              const stderrSummary = stderrBuf.trim();
              const lines = [message];
              if (stderrSummary) {
                lines.push("", "CLI stderr:", stderrSummary.slice(-1024));
              }
              lines.push(
                "",
                "Possible causes:",
                "• Claude CLI not authenticated — run: claude auth login",
                "• Claude CLI version too old (need >= 2.x) — run: claude --version",
                "• Missing ANTHROPIC_* env vars in daemon — check config.env",
                "",
                "Run `/codex-skill status` and check ~/.codex-skill/logs/bridge.log.",
              );
              userMessage = lines.join("\n");
            } else {
              userMessage = message;
            }

            controller.enqueue(sseEvent("error", userMessage));
            controller.close();
          }
        })();
      },
    });
  }
}

/** @internal 导出给测试使用，同时也是 Claude SDK 消息到 bridge SSE 的核心转换器。 */
export function handleMessage(
  msg: SDKMessage,
  controller: ReadableStreamDefaultController<string>,
  state: StreamState,
): void {
  switch (msg.type) {
    case "stream_event": {
      const event = msg.event;
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        // 关键逻辑：只输出增量文本，完整答案由 bridge 侧自行累计。
        controller.enqueue(sseEvent("text", event.delta.text));
        state.hasStreamedText = true;
      }
      if (
        event.type === "content_block_start" &&
        event.content_block.type === "tool_use"
      ) {
        controller.enqueue(
          sseEvent("tool_use", {
            id: event.content_block.id,
            name: event.content_block.name,
            input: {},
          }),
        );
      }
      break;
    }

    case "assistant": {
      // 关键逻辑：assistant 完整文本只缓存不重复下发，避免把整段回复发两次。
      if (msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === "text" && block.text) {
            state.lastAssistantText +=
              (state.lastAssistantText ? "\n" : "") + block.text;
          } else if (block.type === "tool_use") {
            controller.enqueue(
              sseEvent("tool_use", {
                id: block.id,
                name: block.name,
                input: block.input,
              }),
            );
          }
        }
      }
      break;
    }

    case "user": {
      // Claude SDK 会把工具结果包装在 user 消息里，这里要把它重新还原成 tool_result 事件。
      const content = msg.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (
            typeof block === "object" &&
            block !== null &&
            "type" in block &&
            block.type === "tool_result"
          ) {
            const rb = block as {
              tool_use_id: string;
              content?: unknown;
              is_error?: boolean;
            };
            const text =
              typeof rb.content === "string"
                ? rb.content
                : JSON.stringify(rb.content ?? "");
            controller.enqueue(
              sseEvent("tool_result", {
                tool_use_id: rb.tool_use_id,
                content: text,
                is_error: rb.is_error || false,
              }),
            );
          }
        }
      }
      break;
    }

    case "result": {
      state.hasReceivedResult = true;
      if (msg.subtype === "success") {
        controller.enqueue(
          sseEvent("result", {
            session_id: msg.session_id,
            is_error: msg.is_error,
            usage: {
              input_tokens: msg.usage.input_tokens,
              output_tokens: msg.usage.output_tokens,
              cache_read_input_tokens: msg.usage.cache_read_input_tokens ?? 0,
              cache_creation_input_tokens:
                msg.usage.cache_creation_input_tokens ?? 0,
              cost_usd: msg.total_cost_usd,
            },
          }),
        );
      } else {
        // SDK 自己返回的业务错误，与 catch 中处理的传输层错误不是一类问题。
        const errors =
          "errors" in msg && Array.isArray(msg.errors)
            ? msg.errors.join("; ")
            : "Unknown error";
        controller.enqueue(sseEvent("error", errors));
      }
      break;
    }

    case "system": {
      if (msg.subtype === "init") {
        controller.enqueue(
          sseEvent("status", {
            session_id: msg.session_id,
            model: msg.model,
          }),
        );
      }
      break;
    }

    default:
      // 其余消息类型对 bridge 主流程没有影响，忽略即可。
      break;
  }
}
