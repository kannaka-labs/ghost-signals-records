#!/bin/sh
# gsr-cover-tick.sh: the cron entry for the Ghost Signals Records cover runner on debain2.
#   */10 * * * * $HOME/gsr-covers/gsr-cover-tick.sh
# One tick at a time (flock -n). A tick that finds the lock held is NOT silence: a GPU session
# can legitimately run 30-60 min, so the held case sends an ok heartbeat while the session is
# young and its cutoff took; past GSR_COVER_HELD_MAX_MIN, or with a watch alarm, `ping ok held`
# turns into a fail naming the instance. A runner that crashed sends a fail heartbeat itself; a non-zero
# exit here sends one too. No wall-clock kill: a SIGKILL would skip qbraid_run.sh's EXIT trap,
# the only thing that terminates the pod.
PATH=/usr/local/bin:/usr/bin:/bin
export PATH
D="$HOME/gsr-covers"
PY="$HOME/qbraid-venv2/bin/python"
R="$D/gsr_cover_runner.py"
mkdir -p "$D"
cd "$D" || exit 0
flock -n -E 75 "$D/lock" "$PY" "$R" tick >> "$D/runner.log" 2>&1
rc=$?
case "$rc" in
  0)  ;;
  75) "$PY" "$R" ping ok held >> "$D/runner.log" 2>&1 ;;
  *)  "$PY" "$R" ping fail "rc-$rc" >> "$D/runner.log" 2>&1 ;;
esac
exit 0
