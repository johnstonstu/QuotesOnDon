#!/usr/bin/env bash
# Serve the rebuilt site and the review dashboard locally, detached so they survive
# the session that started them.
#
#   scripts/local.sh start | stop | status | logs
#
# Ports are loopback-only and deliberately avoid 8787, which the Grok Bot app uses for
# its X OAuth callback. Override with DASH_PORT / SITE_PORT.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/quotesondon"
SITE_PORT="${SITE_PORT:-4321}"
DASH_PORT="${DASH_PORT:-8799}"
SITE_PID="$STATE/site.pid"
DASH_PID="$STATE/dash.pid"

mkdir -p "$STATE"

alive() { # pidfile
  local pid_file="$1"
  [ -f "$pid_file" ] && kill -0 "$(cat "$pid_file")" 2>/dev/null
}

up() { curl -s -o /dev/null --max-time 3 "http://127.0.0.1:$1/"; }

start_one() { # name pidfile port command...
  local name="$1" pid_file="$2" port="$3"; shift 3
  if alive "$pid_file"; then
    echo "$name already running (pid $(cat "$pid_file"))"
    return
  fi
  if up "$port"; then
    echo "$name: port $port already answers — refusing to double-bind" >&2
    return 1
  fi
  cd "$ROOT"
  setsid nohup "$@" >>"$STATE/$name.log" 2>&1 < /dev/null &
  echo $! > "$pid_file"
  for _ in $(seq 1 25); do up "$port" && break; sleep 0.4; done
  if up "$port"; then
    echo "$name up → http://127.0.0.1:$port/  (pid $(cat "$pid_file"), log $STATE/$name.log)"
  else
    echo "$name FAILED — see $STATE/$name.log" >&2
    tail -5 "$STATE/$name.log" >&2 || true
    return 1
  fi
}

case "${1:-start}" in
  start)
    if [ ! -d "$ROOT/dist" ] || [ -z "$(ls -A "$ROOT/dist" 2>/dev/null)" ]; then
      echo "no build in dist/ — running npm run build first"
      ( cd "$ROOT" && npm run build >/dev/null )
    fi
    start_one site "$SITE_PID" "$SITE_PORT" "$ROOT/node_modules/.bin/astro" preview --host 127.0.0.1 --port "$SITE_PORT"
    start_one dashboard "$DASH_PID" "$DASH_PORT" node "$ROOT/tools/dashboard.mjs"
    echo
    echo "site      http://127.0.0.1:$SITE_PORT/"
    echo "dashboard http://127.0.0.1:$DASH_PORT/"
    ;;
  stop)
    for pair in "site:$SITE_PID" "dashboard:$DASH_PID"; do
      name="${pair%%:*}"; pid_file="${pair#*:}"
      if alive "$pid_file"; then
        pid="$(cat "$pid_file")"
        # kill the whole session leader group so the astro/node children go too
        kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
        sleep 1
        kill -KILL "-$pid" 2>/dev/null || true
        echo "$name stopped (pid $pid)"
      else
        echo "$name not running"
      fi
      rm -f "$pid_file"
    done
    ;;
  status)
    alive "$SITE_PID" && echo "site      up  (pid $(cat "$SITE_PID"))  http://127.0.0.1:$SITE_PORT/" || echo "site      down"
    alive "$DASH_PID" && echo "dashboard up  (pid $(cat "$DASH_PID"))  http://127.0.0.1:$DASH_PORT/" || echo "dashboard down"
    ;;
  logs)
    tail -n 20 "$STATE/site.log" 2>/dev/null || echo "(no site log)"
    echo "---"
    tail -n 20 "$STATE/dash.log" 2>/dev/null || echo "(no dashboard log)"
    ;;
  *)
    echo "usage: scripts/local.sh start|stop|status|logs" >&2
    exit 2
    ;;
esac