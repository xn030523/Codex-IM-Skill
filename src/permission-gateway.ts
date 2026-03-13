/**
 * 权限等待网关。
 *
 * 功能入口：
 * - 把 provider 的 canUseTool 审批请求转成“等待 IM 用户同意/拒绝”的 Promise。
 * 输入输出：
 * - 输入为 permissionRequestId 与最终审批结果。
 * - 输出为 SDK 可直接消费的 PermissionResult。
 * 边界与异常：
 * - 超时未处理会自动拒绝；bridge 关闭时会统一拒绝所有挂起请求。
 */

export interface PermissionResult {
  behavior: "allow" | "deny";
  message?: string;
}

export interface PermissionResolution {
  behavior: "allow" | "deny";
  message?: string;
}

export class PendingPermissions {
  private pending = new Map<
    string,
    {
      resolve: (r: PermissionResult) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private timeoutMs = 5 * 60 * 1000; // 5 minutes

  waitFor(toolUseID: string): Promise<PermissionResult> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(toolUseID);
        // 边界与异常：超时后必须主动 reject，避免 provider 永远卡在等待审批状态。
        resolve({ behavior: "deny", message: "Permission request timed out" });
      }, this.timeoutMs);
      this.pending.set(toolUseID, { resolve, timer });
    });
  }

  resolve(
    permissionRequestId: string,
    resolution: PermissionResolution,
  ): boolean {
    const entry = this.pending.get(permissionRequestId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    // 关键逻辑：网关只负责把聊天层的 allow / deny 结果回传给 provider，不做业务扩展。
    if (resolution.behavior === "allow") {
      entry.resolve({ behavior: "allow" });
    } else {
      entry.resolve({
        behavior: "deny",
        message: resolution.message || "Denied by user",
      });
    }
    this.pending.delete(permissionRequestId);
    return true;
  }

  denyAll(): void {
    // 边界与异常：守护进程退出时统一清空挂起审批，避免遗留悬挂 Promise。
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve({ behavior: "deny", message: "Bridge shutting down" });
    }
    this.pending.clear();
  }

  get size(): number {
    return this.pending.size;
  }
}
