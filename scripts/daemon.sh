#!/usr/bin/env bash
# 功能入口：
# - Unix 平台统一命令入口，根据系统类型分发给 macOS / Linux / Windows 对应 supervisor。
# 输入输出：
# - 输入为 start/stop/status 进程管理命令。
# - 输出为后台进程控制结果、状态文件内容和失败提示。
# 边界与异常：
# - 如果 bundle 不存在或过期会自动重建；启动失败时会给出最近日志和修复建议。
set -euo pipefail
CTI_HOME="${CTI_HOME:-$HOME/.codex-skill}"
SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="$CTI_HOME/runtime/bridge.pid"
STATUS_FILE="$CTI_HOME/runtime/status.json"
LOG_FILE="$CTI_HOME/logs/bridge.log"

# ── Common helpers ──

ensure_dirs() { mkdir -p "$CTI_HOME"/{data,logs,runtime,data/messages}; }

read_runtime() {
  local runtime
  runtime=$(grep "^CTI_RUNTIME=" "$CTI_HOME/config.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d "'" | tr -d '"' || true)
  echo "${runtime:-claude}"
}

ensure_dependencies() {
  if ! command -v npm >/dev/null 2>&1; then
    echo "npm not found in PATH. Install Node.js/npm first."
    exit 1
  fi

  local runtime
  runtime=$(read_runtime)
  local need_install=0

  if [ ! -d "$SKILL_DIR/node_modules" ]; then
    need_install=1
  fi
  if [ "$need_install" = "0" ] && [ ! -d "$SKILL_DIR/node_modules/claude-to-im" ]; then
    need_install=1
  fi
  if [ "$need_install" = "0" ] && [ ! -d "$SKILL_DIR/node_modules/@anthropic-ai/claude-agent-sdk" ]; then
    need_install=1
  fi
  if [ "$need_install" = "0" ] && { [ "$runtime" = "codex" ] || [ "$runtime" = "auto" ]; } && [ ! -d "$SKILL_DIR/node_modules/@openai/codex-sdk" ]; then
    need_install=1
  fi

  if [ "$need_install" = "1" ]; then
    echo "Installing skill dependencies..."
    if [ -f "$SKILL_DIR/package-lock.json" ]; then
      (cd "$SKILL_DIR" && npm ci --include=dev)
    else
      (cd "$SKILL_DIR" && npm install --include=dev)
    fi
  fi
}

ensure_built() {
  local need_build=0
  if [ ! -f "$SKILL_DIR/dist/daemon.mjs" ]; then
    need_build=1
  else
    # 关键逻辑：源码有更新就强制重建，避免 dist/daemon.mjs 与 src 脱节。
    local newest_src
    newest_src=$(find "$SKILL_DIR/src" -name '*.ts' -newer "$SKILL_DIR/dist/daemon.mjs" 2>/dev/null | head -1)
    if [ -n "$newest_src" ]; then
      need_build=1
    fi
    # 边界与异常：上游 claude-to-im 依赖被更新后，bundle 也必须重建，否则会运行旧逻辑。
    if [ "$need_build" = "0" ] && [ -d "$SKILL_DIR/node_modules/claude-to-im/src" ]; then
      local newest_dep
      newest_dep=$(find "$SKILL_DIR/node_modules/claude-to-im/src" -name '*.ts' -newer "$SKILL_DIR/dist/daemon.mjs" 2>/dev/null | head -1)
      if [ -n "$newest_dep" ]; then
        need_build=1
      fi
    fi
  fi
  if [ "$need_build" = "1" ]; then
    echo "Building daemon bundle..."
    (cd "$SKILL_DIR" && npm run build)
  fi
}

# 为守护进程启动前清理环境变量，减少不同运行时之间的互相污染。
clean_env() {
  unset CLAUDECODE 2>/dev/null || true

  local runtime
  runtime=$(grep "^CTI_RUNTIME=" "$CTI_HOME/config.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d "'" | tr -d '"' || true)
  runtime="${runtime:-claude}"

  local mode="${CTI_ENV_ISOLATION:-inherit}"
  if [ "$mode" = "strict" ]; then
    case "$runtime" in
      codex)
        while IFS='=' read -r name _; do
          case "$name" in ANTHROPIC_*) unset "$name" 2>/dev/null || true ;; esac
        done < <(env)
        ;;
      claude)
        # 关键逻辑：Claude 模式保留 ANTHROPIC_*，但移除 OPENAI_*，避免误把 Codex 凭据带进去。
        while IFS='=' read -r name _; do
          case "$name" in OPENAI_*) unset "$name" 2>/dev/null || true ;; esac
        done < <(env)
        ;;
      auto)
        # Keep both ANTHROPIC_* and OPENAI_* for auto mode
        ;;
    esac
  fi
}

read_pid() {
  [ -f "$PID_FILE" ] && cat "$PID_FILE" 2>/dev/null || echo ""
}

pid_alive() {
  local pid="$1"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

status_running() {
  [ -f "$STATUS_FILE" ] && grep -q '"running"[[:space:]]*:[[:space:]]*true' "$STATUS_FILE" 2>/dev/null
}

show_last_exit_reason() {
  if [ -f "$STATUS_FILE" ]; then
    local reason
    reason=$(grep -o '"lastExitReason"[[:space:]]*:[[:space:]]*"[^"]*"' "$STATUS_FILE" 2>/dev/null | head -1 | sed 's/.*: *"//;s/"$//')
    [ -n "$reason" ] && echo "Last exit reason: $reason"
  fi
}

show_failure_help() {
  echo ""
  echo "Recent logs:"
  tail -20 "$LOG_FILE" 2>/dev/null || echo "  (no log file)"
  echo ""
  echo "Next steps:"
  echo "  1. Check status:     bash \"$SKILL_DIR/scripts/daemon.sh\" status"
  echo "  2. Check log file:   $LOG_FILE"
  echo "  3. Rebuild bundle:   cd \"$SKILL_DIR\" && npm run build"
}

# 按平台加载不同 supervisor；Windows 下直接转交给 PowerShell 版本。

case "$(uname -s)" in
  Darwin)
    # shellcheck source=supervisor-macos.sh
    source "$SKILL_DIR/scripts/supervisor-macos.sh"
    ;;
  MINGW*|MSYS*|CYGWIN*)
    # Windows detected via Git Bash / MSYS2 / Cygwin — delegate to PowerShell
    echo "Windows detected. Delegating to supervisor-windows.ps1..."
    powershell.exe -ExecutionPolicy Bypass -File "$SKILL_DIR/scripts/supervisor-windows.ps1" "$@"
    exit $?
    ;;
  *)
    # shellcheck source=supervisor-linux.sh
    source "$SKILL_DIR/scripts/supervisor-linux.sh"
    ;;
esac

# ── Commands ──

case "${1:-help}" in
  start)
    ensure_dirs
    ensure_dependencies
    ensure_built

    # 关键逻辑：启动前先检测平台级 supervisor 或 PID，避免重复拉起多个 bridge 实例。
    if supervisor_is_running; then
      EXISTING_PID=$(read_pid)
      echo "Bridge already running${EXISTING_PID:+ (PID: $EXISTING_PID)}"
      cat "$STATUS_FILE" 2>/dev/null
      exit 1
    fi

    # 关键逻辑：先加载 config.env，再做环境清理，让清理逻辑能读到 CTI_* 控制开关。
    [ -f "$CTI_HOME/config.env" ] && set -a && source "$CTI_HOME/config.env" && set +a

    clean_env
    echo "Starting bridge..."
    supervisor_start

    # 边界与异常：启动后轮询 status.json，防止脚本误把“瞬间退出”的进程当成启动成功。
    STARTED=false
    for _ in $(seq 1 10); do
      sleep 1
      if status_running; then
        STARTED=true
        break
      fi
      # If supervisor process already died, stop waiting
      if ! supervisor_is_running; then
        break
      fi
    done

    if [ "$STARTED" = "true" ]; then
      NEW_PID=$(read_pid)
      echo "Bridge started${NEW_PID:+ (PID: $NEW_PID)}"
      cat "$STATUS_FILE" 2>/dev/null
    else
      echo "Failed to start bridge."
      supervisor_is_running || echo "  Process not running."
      status_running || echo "  status.json not reporting running=true."
      show_last_exit_reason
      show_failure_help
      exit 1
    fi
    ;;

  stop)
    if supervisor_is_managed; then
      echo "Stopping bridge..."
      supervisor_stop
      echo "Bridge stopped"
    else
      PID=$(read_pid)
      if [ -z "$PID" ]; then echo "No bridge running"; exit 0; fi
      if pid_alive "$PID"; then
        kill "$PID"
        for _ in $(seq 1 10); do
          pid_alive "$PID" || break
          sleep 1
        done
        pid_alive "$PID" && kill -9 "$PID"
        echo "Bridge stopped"
      else
        echo "Bridge was not running (stale PID file)"
      fi
      rm -f "$PID_FILE"
    fi
    ;;

  status)
    # Platform-specific status info (prints launchd/service state)
    supervisor_status_extra

    # Process status: supervisor-aware (launchctl on macOS, PID on Linux)
    if supervisor_is_running; then
      PID=$(read_pid)
      echo "Bridge process is running${PID:+ (PID: $PID)}"
      # Business status from status.json
      if status_running; then
        echo "Bridge status: running"
      else
        echo "Bridge status: process alive but status.json not reporting running"
      fi
      cat "$STATUS_FILE" 2>/dev/null
    else
      echo "Bridge is not running"
      [ -f "$PID_FILE" ] && rm -f "$PID_FILE"
      show_last_exit_reason
    fi
    ;;

  *)
    echo "Usage: daemon.sh {start|stop|status}"
    ;;
esac
