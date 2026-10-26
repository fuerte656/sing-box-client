# Asks a console process to shut down: attaches to the target's (hidden) console, installs a
# handler so this helper survives the event itself, and broadcasts CTRL_BREAK. Go maps
# CTRL_BREAK to os.Interrupt, so sing-box exits cleanly and restores the system proxy.
# CTRL_BREAK is used rather than CTRL_C because CTRL_C can be disabled for a process group.
# Exit codes: 0 = exited, 1 = cannot attach, 2 = event not sent, 3 = still running after timeout.
#
# The app passes the C# helper as -ConsoleSource; run by hand, the script reads the .cs file:
#   powershell -ExecutionPolicy Bypass -File interrupt.ps1 -TargetPid 1234
param([int]$TargetPid, [int]$TimeoutMs = 5000, [string]$ConsoleSource)

if (-not $ConsoleSource) {
  $ConsoleSource = Get-Content -Raw (Join-Path $PSScriptRoot 'SingBoxClientConsole.cs')
}
Add-Type -TypeDefinition $ConsoleSource

$code = [SingBoxClientConsole]::Interrupt([uint32]$TargetPid)
if ($code -ne 0) { exit $code }
$process = Get-Process -Id $TargetPid -ErrorAction SilentlyContinue
if ($process -and -not $process.WaitForExit($TimeoutMs)) { exit 3 }
exit 0
