# Watchdog that runs detached for the app's whole life, the POSIX counterpart of
# windows/scripts/watch-app.ps1 (without its lost-UI check, which is a Windows problem):
# once the app is gone without stopping sing-box (crash, kill), stops sing-box: SIGINT first,
# as Ctrl+C would, so it restores the system proxy, then SIGKILL after 5 s.
# sing-box's PID comes from the instance lock, which the app keeps current.
#   sh watch-app.sh <app pid> <lock path> [core name]
app_pid=$1
lock_path=$2
core_name=${3:-sing-box}
log_path="$(dirname "$lock_path")/events.log"

log() {
  echo "$(date +%Y-%m-%dT%H:%M:%S) [watchdog $$] $*" >>"$log_path" 2>/dev/null
}

# A numeric field of the lock file ("pid": 1234); empty when missing or null.
field() {
  sed -n "s/.*\"$1\": *\([0-9]*\).*/\1/p" "$lock_path" 2>/dev/null
}

kill -0 "$app_pid" 2>/dev/null || { log "app $app_pid not found"; exit 0; }
log "watching app $app_pid"

core=
while kill -0 "$app_pid" 2>/dev/null; do
  # Keep the last value while the lock is mid-write, or owned by a newer copy that took over.
  [ "$(field pid)" = "$app_pid" ] && core=$(field corePid)
  sleep 2
done
log "app $app_pid exited"

[ -n "$core" ] || exit 0
ps -p "$core" -o args= 2>/dev/null | grep -q "$core_name" || exit 0
log "stopping leftover sing-box $core"
kill -INT "$core" 2>/dev/null || exit 0
i=0
while [ $i -lt 25 ]; do
  kill -0 "$core" 2>/dev/null || exit 0
  sleep 0.2
  i=$((i + 1))
done
log "sing-box $core did not stop, killing it"
kill -KILL "$core" 2>/dev/null
exit 0
