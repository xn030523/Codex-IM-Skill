<#
.SYNOPSIS
  Windows bridge supervisor.

.DESCRIPTION
  管理 Windows 平台上的 bridge 进程。
  优先使用 Windows Service，找不到服务管理器时退回后台进程模式。
  日常使用请走外层入口：
    powershell -File scripts\daemon.ps1 start|stop|status
#>

param(
    [Parameter(Position=0)]
    [ValidateSet('start','stop','status','install-service','uninstall-service','help')]
    [string]$Command = 'help'
)

$ErrorActionPreference = 'Stop'

# ── Paths ──
$CtiHome    = if ($env:CTI_HOME) { $env:CTI_HOME } else { Join-Path $env:USERPROFILE '.codex-skill' }
$SkillDir   = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$RuntimeDir = Join-Path $CtiHome 'runtime'
$PidFile    = Join-Path $RuntimeDir 'bridge.pid'
$StatusFile = Join-Path $RuntimeDir 'status.json'
$LogFile    = Join-Path $CtiHome 'logs' 'bridge.log'
$ErrLogFile = Join-Path $CtiHome 'logs' 'bridge.err.log'
$DaemonMjs  = Join-Path $SkillDir 'dist' 'daemon.mjs'

$ServiceName = 'CodexSkillBridge'

# ── Helpers ──

function Ensure-Dirs {
    @('data','logs','runtime','data/messages') | ForEach-Object {
        $dir = Join-Path $CtiHome $_
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    }
}

function Get-Runtime {
    $configPath = Join-Path $CtiHome 'config.env'
    if (-not (Test-Path $configPath)) { return 'claude' }
    $line = Get-Content $configPath | Where-Object { $_ -match '^CTI_RUNTIME=' } | Select-Object -First 1
    if (-not $line) { return 'claude' }
    return (($line -split '=', 2)[1]).Trim().Trim('"').Trim("'")
}

function Ensure-Dependencies {
    $npmPath = (Get-Command npm -ErrorAction SilentlyContinue).Source
    if (-not $npmPath) {
        Write-Error "npm not found in PATH. Install Node.js/npm first."
        exit 1
    }

    $runtime = Get-Runtime
    $needInstall = $false

    if (-not (Test-Path (Join-Path $SkillDir 'node_modules'))) {
        $needInstall = $true
    }
    if (-not $needInstall -and -not (Test-Path (Join-Path $SkillDir 'node_modules\\claude-to-im'))) {
        $needInstall = $true
    }
    if (-not $needInstall -and -not (Test-Path (Join-Path $SkillDir 'node_modules\\@anthropic-ai\\claude-agent-sdk'))) {
        $needInstall = $true
    }
    if (-not $needInstall -and ($runtime -eq 'codex' -or $runtime -eq 'auto') -and -not (Test-Path (Join-Path $SkillDir 'node_modules\\@openai\\codex-sdk'))) {
        $needInstall = $true
    }

    if ($needInstall) {
        Write-Host "Installing skill dependencies..."
        Push-Location $SkillDir
        if (Test-Path (Join-Path $SkillDir 'package-lock.json')) {
            npm ci --include=dev
        } else {
            npm install --include=dev
        }
        Pop-Location
    }
}

function Ensure-Built {
    if (-not (Test-Path $DaemonMjs)) {
        Write-Host "Building daemon bundle..."
        Push-Location $SkillDir
        npm run build
        Pop-Location
    } else {
        $srcFiles = Get-ChildItem -Path (Join-Path $SkillDir 'src') -Filter '*.ts' -Recurse
        $bundleTime = (Get-Item $DaemonMjs).LastWriteTime
        $stale = $srcFiles | Where-Object { $_.LastWriteTime -gt $bundleTime } | Select-Object -First 1
        if ($stale) {
            # 关键逻辑：源码比 bundle 新时自动重建，避免启动旧版本守护进程。
            Write-Host "Rebuilding daemon bundle (source changed)..."
            Push-Location $SkillDir
            npm run build
            Pop-Location
        }
    }
}

function Read-Pid {
    if (Test-Path $PidFile) { return (Get-Content $PidFile -Raw).Trim() }
    return $null
}

function Test-PidAlive {
    param([string]$ProcessId)
    if (-not $ProcessId) { return $false }
    try { $null = Get-Process -Id ([int]$ProcessId) -ErrorAction Stop; return $true }
    catch { return $false }
}

function Test-StatusRunning {
    if (-not (Test-Path $StatusFile)) { return $false }
    $json = Get-Content $StatusFile -Raw | ConvertFrom-Json
    return $json.running -eq $true
}

function Show-LastExitReason {
    if (Test-Path $StatusFile) {
        $json = Get-Content $StatusFile -Raw | ConvertFrom-Json
        if ($json.lastExitReason) {
            Write-Host "Last exit reason: $($json.lastExitReason)"
        }
    }
}

function Show-FailureHelp {
    Write-Host ""
    Write-Host "Recent logs:"
    if (Test-Path $LogFile) {
        Get-Content $LogFile -Tail 20
    } else {
        Write-Host "  (no log file)"
    }
    Write-Host ""
    Write-Host "Next steps:"
    Write-Host "  1. Check status:     powershell -File `"$SkillDir\scripts\daemon.ps1`" status"
    Write-Host "  2. Check log file:   $LogFile"
    Write-Host "  3. Rebuild bundle:   cd `"$SkillDir`"; npm run build"
}

function Get-NodePath {
    $nodePath = (Get-Command node -ErrorAction SilentlyContinue).Source
    if (-not $nodePath) {
        Write-Error "Node.js not found in PATH. Install Node.js >= 20."
        exit 1
    }
    return $nodePath
}

# ── WinSW / NSSM detection ──

function Find-ServiceManager {
    # Prefer WinSW, then NSSM
    $winsw = Get-Command 'WinSW.exe' -ErrorAction SilentlyContinue
    if ($winsw) { return @{ type = 'winsw'; path = $winsw.Source } }

    $nssm = Get-Command 'nssm.exe' -ErrorAction SilentlyContinue
    if ($nssm) { return @{ type = 'nssm'; path = $nssm.Source } }

    return $null
}

function Install-WinSWService {
    param([string]$WinSWPath)
    $nodePath = Get-NodePath
    $xmlPath = Join-Path $SkillDir "$ServiceName.xml"

    # Run as current user so the service can access ~/.codex-skill and Codex login state
    $currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    Write-Host "Service will run as: $currentUser"
    $cred = Get-Credential -UserName $currentUser -Message "Enter password for '$currentUser' (required for Windows Service logon)"
    $plainPwd = $cred.GetNetworkCredential().Password

    # Generate WinSW config XML
    @"
<service>
  <id>$ServiceName</id>
  <name>Codex Skill Bridge</name>
  <description>Codex Skill bridge daemon</description>
  <executable>$nodePath</executable>
  <arguments>$DaemonMjs</arguments>
  <workingdirectory>$SkillDir</workingdirectory>
  <serviceaccount>
    <username>$currentUser</username>
    <password>$([System.Security.SecurityElement]::Escape($plainPwd))</password>
    <allowservicelogon>true</allowservicelogon>
  </serviceaccount>
  <env name="USERPROFILE" value="$env:USERPROFILE"/>
  <env name="APPDATA" value="$env:APPDATA"/>
  <env name="LOCALAPPDATA" value="$env:LOCALAPPDATA"/>
  <env name="PATH" value="$env:PATH"/>
  <env name="CTI_HOME" value="$CtiHome"/>
  <logpath>$(Join-Path $CtiHome 'logs')</logpath>
  <log mode="append">
    <logfile>bridge-service.log</logfile>
  </log>
  <onfailure action="restart" delay="10 sec"/>
  <onfailure action="restart" delay="30 sec"/>
  <onfailure action="none"/>
</service>
"@ | Set-Content -Path $xmlPath -Encoding UTF8

    # Copy WinSW next to the XML with matching name
    $winswCopy = Join-Path $SkillDir "$ServiceName.exe"
    Copy-Item $WinSWPath $winswCopy -Force

    & $winswCopy install
    Write-Host "Service '$ServiceName' installed via WinSW."
    Write-Host "  Service account: $currentUser"
    Write-Host "Start with:  & `"$winswCopy`" start"
    Write-Host "Or:          sc.exe start $ServiceName"
}

function Install-NSSMService {
    param([string]$NSSMPath)
    $nodePath = Get-NodePath

    # Run as current user so the service can access ~/.codex-skill and Codex login state
    $currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    Write-Host "Service will run as: $currentUser"
    $cred = Get-Credential -UserName $currentUser -Message "Enter password for '$currentUser' (required for Windows Service logon)"
    $plainPwd = $cred.GetNetworkCredential().Password

    & $NSSMPath install $ServiceName $nodePath $DaemonMjs
    & $NSSMPath set $ServiceName AppDirectory $SkillDir
    & $NSSMPath set $ServiceName ObjectName $currentUser $plainPwd
    & $NSSMPath set $ServiceName AppStdout $LogFile
    & $NSSMPath set $ServiceName AppStderr $LogFile
    & $NSSMPath set $ServiceName AppStdoutCreationDisposition 4
    & $NSSMPath set $ServiceName AppStderrCreationDisposition 4
    & $NSSMPath set $ServiceName Description "Codex Skill bridge daemon"
    & $NSSMPath set $ServiceName AppRestartDelay 10000
    & $NSSMPath set $ServiceName AppEnvironmentExtra "USERPROFILE=$env:USERPROFILE" "APPDATA=$env:APPDATA" "LOCALAPPDATA=$env:LOCALAPPDATA" "CTI_HOME=$CtiHome"

    Write-Host "Service '$ServiceName' installed via NSSM."
    Write-Host "  Service account: $currentUser"
    Write-Host "Start with:  nssm start $ServiceName"
    Write-Host "Or:          sc.exe start $ServiceName"
}

# ── Fallback: Start-Process (no service manager) ──

function Start-Fallback {
    $nodePath = Get-NodePath

    # 边界与异常：移除可能污染 Claude CLI 的变量，保持后台进程环境更稳定。
    $envClone = [System.Collections.Hashtable]::new()
    foreach ($key in [System.Environment]::GetEnvironmentVariables().Keys) {
        $envClone[$key] = [System.Environment]::GetEnvironmentVariable($key)
    }
    # Remove CLAUDECODE
    [System.Environment]::SetEnvironmentVariable('CLAUDECODE', $null)

    $proc = Start-Process -FilePath $nodePath `
        -ArgumentList $DaemonMjs `
        -WorkingDirectory $SkillDir `
        -WindowStyle Hidden `
        -RedirectStandardOutput $LogFile `
        -RedirectStandardError $ErrLogFile `
        -PassThru

    # Write initial PID (main.ts will overwrite with real PID)
    Set-Content -Path $PidFile -Value $proc.Id
    return $proc.Id
}

# ── Commands ──

switch ($Command) {
    'start' {
        Ensure-Dirs
        Ensure-Dependencies
        Ensure-Built

        $existingPid = Read-Pid
        if ($existingPid -and (Test-PidAlive $existingPid)) {
            Write-Host "Bridge already running (PID: $existingPid)"
            if (Test-Path $StatusFile) { Get-Content $StatusFile -Raw }
            exit 1
        }

        # 关键逻辑：优先复用已安装的 Windows Service；没有服务管理器时再退回后台进程模式。
        $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
        if ($svc) {
            Write-Host "Starting bridge via Windows Service..."
            Start-Service -Name $ServiceName
            Start-Sleep -Seconds 3

            $newPid = Read-Pid
            if ($newPid -and (Test-PidAlive $newPid) -and (Test-StatusRunning)) {
                Write-Host "Bridge started (PID: $newPid, managed by Windows Service)"
                if (Test-Path $StatusFile) { Get-Content $StatusFile -Raw }
            } else {
                Write-Host "Failed to start bridge via service."
                Show-LastExitReason
                Show-FailureHelp
                exit 1
            }
        } else {
            Write-Host "Starting bridge (background process)..."
            $bridgePid = Start-Fallback
            Start-Sleep -Seconds 3

            $newPid = Read-Pid
            if ($newPid -and (Test-PidAlive $newPid) -and (Test-StatusRunning)) {
                Write-Host "Bridge started (PID: $newPid)"
                if (Test-Path $StatusFile) { Get-Content $StatusFile -Raw }
            } else {
                Write-Host "Failed to start bridge."
                if (-not $newPid -or -not (Test-PidAlive $newPid)) {
                    Write-Host "  Process exited immediately."
                }
                Show-LastExitReason
                Show-FailureHelp
                exit 1
            }
        }
    }

    'stop' {
        $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
        if ($svc -and $svc.Status -eq 'Running') {
            Write-Host "Stopping bridge via Windows Service..."
            Stop-Service -Name $ServiceName -Force
            Write-Host "Bridge stopped"
            if (Test-Path $PidFile) { Remove-Item $PidFile -Force }
        } else {
            $bridgePid = Read-Pid
            if (-not $bridgePid) { Write-Host "No bridge running"; exit 0 }
            if (Test-PidAlive $bridgePid) {
                Stop-Process -Id ([int]$bridgePid) -Force
                Write-Host "Bridge stopped"
            } else {
                Write-Host "Bridge was not running (stale PID file)"
            }
            if (Test-Path $PidFile) { Remove-Item $PidFile -Force }
        }
    }

    'status' {
        $bridgePid = Read-Pid

        # Check Windows Service
        $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
        if ($svc) {
            Write-Host "Windows Service '$ServiceName': $($svc.Status)"
        }

        if ($bridgePid -and (Test-PidAlive $bridgePid)) {
            Write-Host "Bridge process is running (PID: $bridgePid)"
            if (Test-StatusRunning) {
                Write-Host "Bridge status: running"
            } else {
                Write-Host "Bridge status: process alive but status.json not reporting running"
            }
            if (Test-Path $StatusFile) { Get-Content $StatusFile -Raw }
        } else {
            Write-Host "Bridge is not running"
            if (Test-Path $PidFile) { Remove-Item $PidFile -Force }
            Show-LastExitReason
        }
    }

    'install-service' {
        Ensure-Dirs
        Ensure-Dependencies
        Ensure-Built

        $mgr = Find-ServiceManager
        if (-not $mgr) {
            Write-Host "No service manager found. Install one of:"
            Write-Host "  WinSW:  https://github.com/winsw/winsw/releases"
            Write-Host "  NSSM:   https://nssm.cc/download"
            Write-Host ""
        Write-Host "After installing, use the advanced Windows service flow if needed."
        exit 1
        }

        switch ($mgr.type) {
            'winsw' { Install-WinSWService -WinSWPath $mgr.path }
            'nssm'  { Install-NSSMService  -NSSMPath  $mgr.path }
        }
    }

    'uninstall-service' {
        $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
        if (-not $svc) {
            Write-Host "Service '$ServiceName' is not installed."
            exit 0
        }

        if ($svc.Status -eq 'Running') {
            Stop-Service -Name $ServiceName -Force
        }

        $mgr = Find-ServiceManager
        if ($mgr -and $mgr.type -eq 'nssm') {
            & $mgr.path remove $ServiceName confirm
        } else {
            # WinSW or generic
            $winswExe = Join-Path $SkillDir "$ServiceName.exe"
            if (Test-Path $winswExe) {
                & $winswExe uninstall
                Remove-Item $winswExe -Force -ErrorAction SilentlyContinue
                Remove-Item (Join-Path $SkillDir "$ServiceName.xml") -Force -ErrorAction SilentlyContinue
            } else {
                sc.exe delete $ServiceName
            }
        }
        Write-Host "Service '$ServiceName' uninstalled."
    }

    'help' {
        Write-Host "Usage: daemon.ps1 {start|stop|status}"
        Write-Host ""
        Write-Host "Commands:"
        Write-Host "  start             Start the bridge daemon"
        Write-Host "  stop              Stop the bridge daemon"
        Write-Host "  status            Show bridge status"
    }
}
