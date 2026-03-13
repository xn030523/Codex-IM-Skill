/**
 * Codex 运行时 provider。
 *
 * 功能入口：
 * - 基于 @openai/codex-sdk 启动或恢复线程，并把线程事件映射成 bridge 可消费的 SSE 流。
 * 输入输出：
 * - 输入为 bridge 层传入的 prompt、工作目录、模型、权限模式和附件。
 * - 输出为 ReadableStream<SSE>，与 Claude provider 保持相同接口。
 * 边界与异常：
 * - SDK 采用懒加载；缺失依赖、会话恢复失败、模型跨运行时残留都会被转成更可诊断的错误。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  LLMProvider,
  StreamChatParams,
} from "claude-to-im/src/lib/bridge/host.js";
import type { PendingPermissions } from "./permission-gateway.js";
import { sseEvent } from "./sse.js";

/** MIME 到临时图片文件扩展名的映射。 */
const MIME_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

// 可选依赖在未安装时不能直接静态引用类型，因此这里保守使用 any。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CodexModule = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CodexInstance = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ThreadInstance = any;

/**
 * 把 bridge 权限模式映射成 Codex SDK 的 approvalPolicy。
 */
function toApprovalPolicy(permissionMode?: string): string {
  switch (permissionMode) {
    case "acceptEdits":
      return "on-failure";
    case "plan":
      return "on-request";
    case "default":
      return "on-request";
    default:
      return "on-request";
  }
}

/** 是否把 bridge 的模型名继续透传给 Codex；默认关闭，优先让 Codex 自己选择默认模型。 */
function shouldPassModelToCodex(): boolean {
  return process.env.CTI_CODEX_PASS_MODEL === "true";
}

function looksLikeClaudeModel(model?: string): boolean {
  return !!model && /^claude[-_]/i.test(model);
}

function shouldRetryFreshThread(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("resuming session with different model") ||
    lower.includes("no such session") ||
    (lower.includes("resume") && lower.includes("session"))
  );
}

export class CodexProvider implements LLMProvider {
  private sdk: CodexModule | null = null;
  private codex: CodexInstance | null = null;

  /** 把 bridge sessionId 映射到 Codex threadId，用于多次聊天恢复同一线程。 */
  private threadIds = new Map<string, string>();

  constructor(private pendingPerms: PendingPermissions) {}

  /**
   * 懒加载 Codex SDK。
   */
  private async ensureSDK(): Promise<{
    sdk: CodexModule;
    codex: CodexInstance;
  }> {
    if (this.sdk && this.codex) {
      return { sdk: this.sdk, codex: this.codex };
    }

    try {
      this.sdk = await (Function(
        'return import("@openai/codex-sdk")',
      )() as Promise<CodexModule>);
    } catch {
      throw new Error(
        "[CodexProvider] @openai/codex-sdk is not installed. " +
          "Install it with: npm install @openai/codex-sdk",
      );
    }

    // 关键逻辑：优先读取项目自己的 CTI_CODEX_API_KEY，再降级到通用 OpenAI/Codex 环境变量。
    const apiKey =
      process.env.CTI_CODEX_API_KEY ||
      process.env.CODEX_API_KEY ||
      process.env.OPENAI_API_KEY ||
      undefined;
    const baseUrl = process.env.CTI_CODEX_BASE_URL || undefined;

    const CodexClass = this.sdk.Codex;
    this.codex = new CodexClass({
      ...(apiKey ? { apiKey } : {}),
      ...(baseUrl ? { baseUrl } : {}),
    });

    return { sdk: this.sdk, codex: this.codex };
  }

  streamChat(params: StreamChatParams): ReadableStream<string> {
    const self = this;

    return new ReadableStream<string>({
      start(controller) {
        (async () => {
          const tempFiles: string[] = [];
          try {
            const { codex } = await self.ensureSDK();

            // 关键逻辑：优先恢复已有线程；没有 threadId 时再新建线程。
            let savedThreadId = params.sdkSessionId
              ? self.threadIds.get(params.sessionId) || params.sdkSessionId
              : undefined;

            // 边界与异常：如果历史会话带着 Claude 模型名切到 Codex，直接丢弃旧 threadId 重新建线程。
            if (savedThreadId && looksLikeClaudeModel(params.model)) {
              console.warn(
                "[codex-provider] Ignoring stale Claude-like sdkSessionId in Codex runtime; starting fresh thread",
              );
              savedThreadId = undefined;
            }

            const approvalPolicy = toApprovalPolicy(params.permissionMode);
            const passModel = shouldPassModelToCodex();

            const threadOptions: Record<string, unknown> = {
              ...(passModel && params.model ? { model: params.model } : {}),
              ...(params.workingDirectory
                ? { workingDirectory: params.workingDirectory }
                : {}),
              // Bridge sessions often start from a user home/workspace path that is
              // not itself a Git repo; allow Codex to run there instead of failing.
              skipGitRepoCheck: true,
              approvalPolicy,
            };

            // 关键逻辑：Codex SDK 只接收本地图片路径，因此这里把 base64 附件写入临时文件再传入。
            const imageFiles =
              params.files?.filter((f) => f.type.startsWith("image/")) ?? [];

            let input: string | Array<Record<string, string>>;
            if (imageFiles.length > 0) {
              const parts: Array<Record<string, string>> = [
                { type: "text", text: params.prompt },
              ];
              for (const file of imageFiles) {
                const ext = MIME_EXT[file.type] || ".png";
                const tmpPath = path.join(
                  os.tmpdir(),
                  `cti-img-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`,
                );
                fs.writeFileSync(tmpPath, Buffer.from(file.data, "base64"));
                tempFiles.push(tmpPath);
                parts.push({ type: "local_image", path: tmpPath });
              }
              input = parts;
            } else {
              input = params.prompt;
            }

            let retryFresh = false;

            while (true) {
              let thread: ThreadInstance;
              if (savedThreadId) {
                try {
                  thread = codex.resumeThread(savedThreadId, threadOptions);
                } catch {
                  // 边界与异常：恢复失败时直接退回新线程，避免整个请求因此中断。
                  thread = codex.startThread(threadOptions);
                }
              } else {
                thread = codex.startThread(threadOptions);
              }

              let sawAnyEvent = false;
              try {
                const { events } = await thread.runStreamed(input);

                for await (const event of events) {
                  sawAnyEvent = true;
                  if (params.abortController?.signal.aborted) {
                    break;
                  }

                  switch (event.type) {
                    case "thread.started": {
                      const threadId = event.thread_id as string;
                      self.threadIds.set(params.sessionId, threadId);

                      controller.enqueue(
                        sseEvent("status", {
                          session_id: threadId,
                        }),
                      );
                      break;
                    }

                    case "item.completed": {
                      const item = event.item as Record<string, unknown>;
                      self.handleCompletedItem(controller, item);
                      break;
                    }

                    case "turn.completed": {
                      const usage = event.usage as
                        | Record<string, unknown>
                        | undefined;
                      const threadId = self.threadIds.get(params.sessionId);

                      controller.enqueue(
                        sseEvent("result", {
                          usage: usage
                            ? {
                                input_tokens: usage.input_tokens ?? 0,
                                output_tokens: usage.output_tokens ?? 0,
                                cache_read_input_tokens:
                                  usage.cached_input_tokens ?? 0,
                              }
                            : undefined,
                          ...(threadId ? { session_id: threadId } : {}),
                        }),
                      );
                      break;
                    }

                    case "turn.failed": {
                      const error = (event as { message?: string }).message;
                      controller.enqueue(
                        sseEvent("error", error || "Turn failed"),
                      );
                      break;
                    }

                    case "error": {
                      const error = (event as { message?: string }).message;
                      controller.enqueue(
                        sseEvent("error", error || "Thread error"),
                      );
                      break;
                    }

                    // item.started, item.updated, turn.started — no action needed
                  }
                }
                break;
              } catch (err) {
                const message =
                  err instanceof Error ? err.message : String(err);
                if (
                  savedThreadId &&
                  !retryFresh &&
                  !sawAnyEvent &&
                  shouldRetryFreshThread(message)
                ) {
                  // 关键逻辑：恢复线程一旦因模型/会话错配失败，仅重试一次全新线程，避免死循环。
                  console.warn(
                    "[codex-provider] Resume failed, retrying with a fresh thread:",
                    message,
                  );
                  savedThreadId = undefined;
                  retryFresh = true;
                  continue;
                }
                throw err;
              }
            }

            controller.close();
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(
              "[codex-provider] Error:",
              err instanceof Error ? err.stack || err.message : err,
            );
            try {
              controller.enqueue(sseEvent("error", message));
              controller.close();
            } catch {
              // Controller already closed
            }
          } finally {
            // 边界与异常：无论成功失败都清理临时图片，避免系统临时目录持续堆积。
            for (const tmp of tempFiles) {
              try {
                fs.unlinkSync(tmp);
              } catch {
                /* ignore */
              }
            }
          }
        })();
      },
    });
  }

  /**
   * 把 Codex item.completed 事件映射成 bridge SSE。
   */
  private handleCompletedItem(
    controller: ReadableStreamDefaultController<string>,
    item: Record<string, unknown>,
  ): void {
    const itemType = item.type as string;

    switch (itemType) {
      case "agent_message": {
        const text = (item.text as string) || "";
        if (text) {
          controller.enqueue(sseEvent("text", text));
        }
        break;
      }

      case "command_execution": {
        const toolId = (item.id as string) || `tool-${Date.now()}`;
        const command = (item.command as string) || "";
        const output = (item.aggregated_output as string) || "";
        const exitCode = item.exit_code as number | undefined;
        const isError = exitCode != null && exitCode !== 0;

        controller.enqueue(
          sseEvent("tool_use", {
            id: toolId,
            name: "Bash",
            input: { command },
          }),
        );

        const resultContent =
          output || (isError ? `Exit code: ${exitCode}` : "Done");
        controller.enqueue(
          sseEvent("tool_result", {
            tool_use_id: toolId,
            content: resultContent,
            is_error: isError,
          }),
        );
        break;
      }

      case "file_change": {
        const toolId = (item.id as string) || `tool-${Date.now()}`;
        const changes =
          (item.changes as Array<{ path: string; kind: string }>) || [];
        const summary = changes.map((c) => `${c.kind}: ${c.path}`).join("\n");

        controller.enqueue(
          sseEvent("tool_use", {
            id: toolId,
            name: "Edit",
            input: { files: changes },
          }),
        );

        controller.enqueue(
          sseEvent("tool_result", {
            tool_use_id: toolId,
            content: summary || "File changes applied",
            is_error: false,
          }),
        );
        break;
      }

      case "mcp_tool_call": {
        const toolId = (item.id as string) || `tool-${Date.now()}`;
        const server = (item.server as string) || "";
        const tool = (item.tool as string) || "";
        const args = item.arguments as unknown;
        const result = item.result as
          | { content?: unknown; structured_content?: unknown }
          | undefined;
        const error = item.error as { message?: string } | undefined;

        const resultContent = result?.content ?? result?.structured_content;
        const resultText =
          typeof resultContent === "string"
            ? resultContent
            : resultContent
              ? JSON.stringify(resultContent)
              : undefined;

        controller.enqueue(
          sseEvent("tool_use", {
            id: toolId,
            name: `mcp__${server}__${tool}`,
            input: args,
          }),
        );

        controller.enqueue(
          sseEvent("tool_result", {
            tool_use_id: toolId,
            content: error?.message || resultText || "Done",
            is_error: !!error,
          }),
        );
        break;
      }

      case "reasoning": {
        // 推理文本不直接展示为正文，而是作为状态信息透出。
        const text = (item.text as string) || "";
        if (text) {
          controller.enqueue(sseEvent("status", { reasoning: text }));
        }
        break;
      }
    }
  }
}
