#!/bin/sh

parent_pid="$1"
shift

"$@" &
service_pid=$!

stop_service() {
  trap - EXIT HUP INT TERM
  kill "$service_pid" 2>/dev/null || true
  wait "$service_pid" 2>/dev/null || true
}

trap 'stop_service; exit 0' HUP INT TERM
trap stop_service EXIT

while kill -0 "$parent_pid" 2>/dev/null && kill -0 "$service_pid" 2>/dev/null; do
  sleep 1
done

stop_service
