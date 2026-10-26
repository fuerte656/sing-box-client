# Stops sing-box when the app goes away without stopping it (crash, hang, killed from Task Manager).
# The app starts one detached copy per sing-box run; it exits as soon as that sing-box exits.
# Graceful first (CTRL_BREAK, as in interrupt.ps1) so sing-box restores the system proxy.
#   powershell -ExecutionPolicy Bypass -File watch-core.ps1 -AppPid 1234 -CorePid 5678
param([int]$AppPid, [int]$CorePid, [int]$TimeoutMs = 5000, [string]$ConsoleSource)

$core = Get-Process -Id $CorePid -ErrorAction SilentlyContinue
if (-not $core) { exit 0 }
$app = Get-Process -Id $AppPid -ErrorAction SilentlyContinue
while ($app -and -not $app.WaitForExit(1000)) {
  if ($core.HasExited) { exit 0 }
}
if ($core.HasExited) { exit 0 }

if (-not $ConsoleSource) {
  $ConsoleSource = Get-Content -Raw (Join-Path $PSScriptRoot 'SingBoxClientConsole.cs')
}
Add-Type -TypeDefinition $ConsoleSource
[void][SingBoxClientConsole]::Interrupt([uint32]$CorePid)
if (-not $core.WaitForExit($TimeoutMs)) { Stop-Process -Id $CorePid -Force }
exit 0
