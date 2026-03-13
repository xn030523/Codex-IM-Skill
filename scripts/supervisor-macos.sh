#!/usr/bin/env bash
# macOS supervisor。
# 功能入口：
# - 使用 launchd 托管 bridge 进程，解决 macOS 后台进程易丢环境变量或退出的问题。
# 输入输出：
# - 输入依赖 daemon.sh 准备好的 CTI_HOME、SKILL_DIR 等路径变量。
# - 输出为 launchd plist、bridge 进程与相关状态信息。
# 边界与异常：
# - 运行时环境变量需要显式写入 plist，否则后台进程无法继承当前 shell 的配置。

LAUNCHD_LABEL="com.codex-skill.bridge"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_FILE="$PLIST_DIR/$LAUNCHD_LABEL.plist"

# launchd 辅助函数。

# 关键逻辑：在 clean_env 之后收集环境变量，保证写入 launchd 的内容和实际守护进程一致。
build_env_dict() {
  local indent="            "
  local dict=""

  # 始终透传最基本的运行环境。
  for var in HOME PATH USER SHELL LANG TMPDIR; do
    local val="${!var:-}"
    [ -z "$val" ] && continue
    dict+="${indent}<key>${var}</key>\n${indent}<string>${val}</string>\n"
  done

  # CTI_* 是 Skill 自己的控制面变量，必须完整进入 launchd。
  while IFS='=' read -r name val; do
    case "$name" in CTI_*)
      dict+="${indent}<key>${name}</key>\n${indent}<string>${val}</string>\n"
      ;; esac
  done < <(env)

  # 边界与异常：不同运行时只透传自己真正需要的凭据，避免跨运行时变量污染。
  local runtime
  runtime=$(grep "^CTI_RUNTIME=" "$CTI_HOME/config.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d "'" | tr -d '"' || true)
  runtime="${runtime:-claude}"

  case "$runtime" in
    codex|auto)
      for var in OPENAI_API_KEY CODEX_API_KEY CTI_CODEX_API_KEY CTI_CODEX_BASE_URL; do
        local val="${!var:-}"
        [ -z "$val" ] && continue
        dict+="${indent}<key>${var}</key>\n${indent}<string>${val}</string>\n"
      done
      ;;
  esac
  case "$runtime" in
    claude|auto)
      # Auto-forward all ANTHROPIC_* env vars (sourced from config.env by daemon.sh).
      # Third-party API providers need these to reach the CLI subprocess.
      while IFS='=' read -r name val; do
        case "$name" in ANTHROPIC_*)
          dict+="${indent}<key>${name}</key>\n${indent}<string>${val}</string>\n"
          ;; esac
      done < <(env)
      ;;
  esac

  echo -e "$dict"
}

generate_plist() {
  local node_path
  node_path=$(command -v node)

  mkdir -p "$PLIST_DIR"
  local env_dict
  env_dict=$(build_env_dict)

  cat > "$PLIST_FILE" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LAUNCHD_LABEL}</string>

    <key>ProgramArguments</key>
    <array>
        <string>${node_path}</string>
        <string>${SKILL_DIR}/dist/daemon.mjs</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${SKILL_DIR}</string>

    <key>StandardOutPath</key>
    <string>${LOG_FILE}</string>
    <key>StandardErrorPath</key>
    <string>${LOG_FILE}</string>

    <key>RunAtLoad</key>
    <false/>

    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>

    <key>ThrottleInterval</key>
    <integer>10</integer>

    <key>EnvironmentVariables</key>
    <dict>
${env_dict}    </dict>
</dict>
</plist>
PLIST
}

# ── Public interface (called by daemon.sh) ──

supervisor_start() {
  launchctl bootout "gui/$(id -u)/$LAUNCHD_LABEL" 2>/dev/null || true
  generate_plist
  launchctl bootstrap "gui/$(id -u)" "$PLIST_FILE"
  launchctl kickstart -k "gui/$(id -u)/$LAUNCHD_LABEL"
}

supervisor_stop() {
  launchctl bootout "gui/$(id -u)/$LAUNCHD_LABEL" 2>/dev/null || true
  rm -f "$PID_FILE"
}

supervisor_is_managed() {
  launchctl print "gui/$(id -u)/$LAUNCHD_LABEL" &>/dev/null
}

supervisor_status_extra() {
  if supervisor_is_managed; then
    echo "Bridge is registered with launchd ($LAUNCHD_LABEL)"
    # 关键逻辑：优先信任 launchctl 报告的 PID，而不是 PID 文件。
    local lc_pid
    lc_pid=$(launchctl print "gui/$(id -u)/$LAUNCHD_LABEL" 2>/dev/null | grep -m1 'pid = ' | sed 's/.*pid = //' | tr -d ' ')
    if [ -n "$lc_pid" ] && [ "$lc_pid" != "0" ] && [ "$lc_pid" != "-" ]; then
      echo "launchd reports PID: $lc_pid"
    fi
  fi
}

# macOS 存活判断优先查 launchctl，再退回 PID 文件兜底。
supervisor_is_running() {
  # Primary: launchctl knows the process
  if supervisor_is_managed; then
    local lc_pid
    lc_pid=$(launchctl print "gui/$(id -u)/$LAUNCHD_LABEL" 2>/dev/null | grep -m1 'pid = ' | sed 's/.*pid = //' | tr -d ' ')
    if [ -n "$lc_pid" ] && [ "$lc_pid" != "0" ] && [ "$lc_pid" != "-" ]; then
      return 0
    fi
  fi
  # Fallback: PID file
  local pid
  pid=$(read_pid)
  pid_alive "$pid"
}
