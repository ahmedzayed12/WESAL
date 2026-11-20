#!/usr/bin/env bash
set -euo pipefail

export APP_ORIGIN="${APP_ORIGIN:-${RENDER_EXTERNAL_URL:?Render must provide a public URL}}"

# The web process and cleanup worker share the same persistent disk.
node src/migrate.js
node src/server.js &
web_pid=$!
node src/worker.js &
worker_pid=$!

stop_children() {
  kill -TERM "$web_pid" "$worker_pid" 2>/dev/null || true
  wait "$web_pid" "$worker_pid" 2>/dev/null || true
}

trap 'stop_children; exit 0' TERM INT
status=0
wait -n "$web_pid" "$worker_pid" || status=$?
stop_children
exit "$((status == 0 ? 1 : status))"
