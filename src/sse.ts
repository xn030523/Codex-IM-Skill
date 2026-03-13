/**
 * SSE 事件格式化工具。
 *
 * 功能入口：
 * - 把 provider 产出的文本、工具结果、状态更新统一编码成 bridge 需要的 SSE 字符串。
 * 输入输出：
 * - 输入为事件类型和可序列化数据。
 * - 输出为单行 `data: ...` 文本。
 * 边界与异常：
 * - 非字符串数据会自动 JSON 序列化，减少各 provider 自己处理格式的重复代码。
 */

export function sseEvent(type: string, data: unknown): string {
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  return `data: ${JSON.stringify({ type, data: payload })}\n`;
}
