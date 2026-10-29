# Watchdog that runs detached for the app's whole life:
# - kills the app when its UI has lost the connection to the Neutralino runtime for 30 s (the tray icon
#   stays but nothing responds, so Quit cannot work);
# - once the app is gone without stopping sing-box (crash, kill), stops sing-box: CTRL_BREAK first,
#   as in interrupt.ps1, so it restores the system proxy, then by force.
# sing-box's PID comes from the instance lock, which the app keeps current.
#   powershell -ExecutionPolicy Bypass -File watch-app.ps1 -AppPid 1234 -AppPort 5678 -LockPath ...\instance.json
param(
  [int]$AppPid,
  [int]$AppPort,
  [string]$LockPath,
  [string]$CoreName = 'sing-box',
  [int]$TimeoutMs = 5000,
  [string]$ConsoleSource
)

$logPath = Join-Path (Split-Path $LockPath) 'events.log'
function Write-Log([string]$message) {
  "$(Get-Date -Format s) [watchdog $PID] $message" | Add-Content -Path $logPath -ErrorAction SilentlyContinue
}

$app = Get-Process -Id $AppPid -ErrorAction SilentlyContinue
if (-not $app) { Write-Log "app $AppPid not found"; exit 0 }
# Opens the process handle now, so the exit code can still be read after the app is gone.
[void]$app.Handle
Write-Log "watching app $AppPid (port $AppPort)"

# $true: UI connected; $false: the app's listener is up but nothing is connected to it;
# $null: unknown (snapshot failed or the listener is missing from it), which never counts as lost.
# Uses the IP Helper tables directly: Get-NetTCPConnection goes through WMI, which can take
# seconds and returns nothing while network adapters change (e.g. the TUN adapter on stop).
function Test-UiConnected {
  try {
    $tcp = [Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties()
    if (-not ($tcp.GetActiveTcpListeners() | Where-Object Port -eq $AppPort)) { return $null }
    $connected = $tcp.GetActiveTcpConnections() |
      Where-Object { $_.LocalEndPoint.Port -eq $AppPort -and $_.State -eq 'Established' }
    return [bool]$connected
  } catch {
    return $null
  }
}

$corePid = $null
$lostChecks = 0
while (-not $app.WaitForExit(2000)) {
  # Keep the last value when the lock is mid-write, or owned by a newer copy that took over.
  try {
    $lock = Get-Content -Raw $LockPath -ErrorAction Stop | ConvertFrom-Json
    if ($lock.pid -eq $AppPid) { $corePid = $lock.corePid }
  } catch {}
  if (-not $AppPort) { continue }
  $ui = Test-UiConnected
  if ($ui -ne $false) {
    $lostChecks = 0
  } elseif (++$lostChecks -ge 15) {
    Write-Log "killing app $AppPid`: no UI connected to port $AppPort for 30 s"
    Stop-Process -Id $AppPid -Force -ErrorAction SilentlyContinue
    break
  }
}
# 0: app.exit(); 1: taskkill /F; -1073741510 (0xC000013A): Ctrl+C / Ctrl+Break.
Write-Log "app $AppPid exited with code $(try { $app.ExitCode } catch { '?' })"

if (-not $corePid) { exit 0 }
$core = Get-Process -Id $corePid -ErrorAction SilentlyContinue
if (-not $core -or $core.ProcessName -ne $CoreName) { exit 0 }
Write-Log "stopping leftover sing-box $corePid"

if (-not $ConsoleSource) {
  $ConsoleSource = Get-Content -Raw (Join-Path $PSScriptRoot 'SingBoxClientConsole.cs')
}
try {
  Add-Type -TypeDefinition $ConsoleSource -ErrorAction Stop
  [void][SingBoxClientConsole]::Interrupt([uint32]$corePid)
} catch {
  Write-Log "graceful stop unavailable: $_"
}
if (-not $core.WaitForExit($TimeoutMs)) { Stop-Process -Id $corePid -Force }
exit 0
