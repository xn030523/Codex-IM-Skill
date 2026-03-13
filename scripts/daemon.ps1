<#
.SYNOPSIS
  Windows entry point — delegates to supervisor-windows.ps1.
.DESCRIPTION
  功能入口：
  - 作为 Windows 下最外层命令入口，只负责参数接收并转交给真正的 supervisor。
  输入输出：
  - 输入为 start/stop/status/logs 等命令参数。
  - 输出为 supervisor-windows.ps1 的执行结果。
  边界与异常：
  - 自身不做业务判断，所有进程控制与错误处理都在 supervisor-windows.ps1 内完成。
  Usage:  powershell -File scripts\daemon.ps1 start|stop|status|logs|install-service|uninstall-service
#>
param(
    [Parameter(Position=0)]
    [string]$Command = 'help',

    [Parameter(Position=1)]
    [int]$LogLines = 50
)

$supervisorScript = Join-Path (Split-Path -Parent $PSCommandPath) 'supervisor-windows.ps1'
& $supervisorScript $Command $LogLines
