# Watchdog that runs detached for the app's whole life:
# - kills the app when its UI has lost the connection to the Neutralino runtime (the tray icon
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

$app = Get-Process -Id $AppPid -ErrorAction SilentlyContinue
if (-not $app) { exit 0 }

$corePid = $null
$lostChecks = 0
while (-not $app.WaitForExit(2000)) {
  # Keep the last value when the lock is mid-write, or owned by a newer copy that took over.
  try {
    $lock = Get-Content -Raw $LockPath -ErrorAction Stop | ConvertFrom-Json
    if ($lock.pid -eq $AppPid) { $corePid = $lock.corePid }
  } catch {}
  if (-not $AppPort) { continue }
  if (Get-NetTCPConnection -LocalPort $AppPort -State Established -ErrorAction SilentlyContinue) {
    $lostChecks = 0
  } elseif (++$lostChecks -ge 5) {
    Stop-Process -Id $AppPid -Force -ErrorAction SilentlyContinue
    break
  }
}

if (-not $corePid) { exit 0 }
$core = Get-Process -Id $corePid -ErrorAction SilentlyContinue
if (-not $core -or $core.ProcessName -ne $CoreName) { exit 0 }

if (-not $ConsoleSource) {
  $ConsoleSource = Get-Content -Raw (Join-Path $PSScriptRoot 'SingBoxClientConsole.cs')
}
Add-Type -TypeDefinition $ConsoleSource
[void][SingBoxClientConsole]::Interrupt([uint32]$corePid)
if (-not $core.WaitForExit($TimeoutMs)) { Stop-Process -Id $corePid -Force }
exit 0
