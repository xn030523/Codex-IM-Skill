#!/usr/bin/env bash
# Linux supervisor。
# 功能入口：
# - 在 Linux 上使用 setsid/nohup 以非服务方式管理 bridge 后台进程。
# 输入输出：
# - 输入依赖 daemon.sh 提供的路径变量与命令调用。
# - 输出为进程 PID 文件和标准日志追加内容。
# 边界与异常：
# - 该实现没有系统级服务管理器，所有存活判断都依赖 PID 文件和 kill -0 检测。

# ── Public interface (called by daemon.sh) ──

supervisor_start() {
  if command -v setsid >/dev/null 2>&1; then
    setsid node "$SKILL_DIR/dist/daemon.mjs" >> "$LOG_FILE" 2>&1 < /dev/null &
  else
    nohup node "$SKILL_DIR/dist/daemon.mjs" >> "$LOG_FILE" 2>&1 < /dev/null &
  fi
  # 关键逻辑：先写 shell 侧 PID 兜底，真正 PID 会在 main.ts 启动后覆盖。
  echo $! > "$PID_FILE"
}

supervisor_stop() {
  local pid
  pid=$(read_pid)
  if [ -z "$pid" ]; then echo "No bridge running"; return 0; fi
  if pid_alive "$pid"; then
    kill "$pid"
    for _ in $(seq 1 10); do
      pid_alive "$pid" || break
      sleep 1
    done
    pid_alive "$pid" && kill -9 "$pid"
    echo "Bridge stopped"
  else
    echo "Bridge was not running (stale PID file)"
  fi
  rm -f "$PID_FILE"
}

supervisor_is_managed() {
  # Linux fallback 不接 systemd，始终视为“非托管进程”。
  return 1
}

supervisor_status_extra() {
  # No extra status for Linux fallback
  :
}

supervisor_is_running() {
  local pid
  pid=$(read_pid)
  pid_alive "$pid"
}
