# Asks a console process to shut down: attaches to the target's (hidden) console, installs a
# handler so this helper survives the event itself, and sends CTRL_BREAK to the target's process
# group only (the console may be shared with the app). Go maps CTRL_BREAK to os.Interrupt, so
# sing-box exits cleanly and restores the system proxy.
# CTRL_BREAK is used rather than CTRL_C because CTRL_C is disabled in a new process group.
# With -Standby the script starts ahead of time (PowerShell startup and compiling the helper take
# about 2 s) and waits for a line on stdin before sending the event; stdin closing cancels it.
# Exit codes: 0 = exited, 1 = cannot attach, 2 = event not sent, 3 = still running after timeout,
# 4 = the C# helper did not compile, 5 = cancelled in standby.
#
# The app passes the C# helper as -ConsoleSource; run by hand, the script reads the .cs file:
#   powershell -ExecutionPolicy Bypass -File interrupt.ps1 -TargetPid 1234
param([int]$TargetPid, [int]$TimeoutMs = 5000, [string]$ConsoleSource, [switch]$Standby)

if (-not $ConsoleSource) {
  $ConsoleSource = Get-Content -Raw (Join-Path $PSScriptRoot 'SingBoxClientConsole.cs')
}
# Fail loudly: with a failed Add-Type, $code would be $null and `exit $null` exits with 0.
try { Add-Type -TypeDefinition $ConsoleSource -ErrorAction Stop } catch { exit 4 }
if ($Standby -and $null -eq [Console]::In.ReadLine()) { exit 5 }

$code = [SingBoxClientConsole]::Interrupt([uint32]$TargetPid)
if ($code -ne 0) { exit $code }
$process = Get-Process -Id $TargetPid -ErrorAction SilentlyContinue
if ($process -and -not $process.WaitForExit($TimeoutMs)) { exit 3 }
exit 0
