#!/bin/sh
# Starts Loki, Prometheus, nginx and Grafana in one container. If any of them stops, the container exits so Render restarts it.
set -eu

: "${PORT:=10000}"
: "${APP_HOST:?APP_HOST is required: the host of the app to scrape, for example seat-reservation-xxxx.onrender.com}"
: "${LOKI_TOKEN:?LOKI_TOKEN is required}"
: "${GF_SECURITY_ADMIN_PASSWORD:?GF_SECURITY_ADMIN_PASSWORD is required}"
export PORT APP_HOST LOKI_TOKEN
export APP_SCHEME="${APP_SCHEME:-https}"
export GF_SERVER_ROOT_URL="${RENDER_EXTERNAL_URL:-http://localhost:${PORT}}/"

mkdir -p /tmp/loki /tmp/prometheus /tmp/nginx
envsubst '${PORT} ${LOKI_TOKEN}' < /etc/monitoring/nginx.conf.template > /tmp/nginx/nginx.conf
envsubst '${APP_HOST} ${APP_SCHEME}' < /etc/monitoring/prometheus.yml.template > /tmp/prometheus/prometheus.yml

loki -config.file=/etc/monitoring/loki-config.yml &
pids="$!"
prometheus \
  --config.file=/tmp/prometheus/prometheus.yml \
  --storage.tsdb.path=/tmp/prometheus/data \
  --storage.tsdb.retention.time=12h \
  --web.listen-address=127.0.0.1:9090 &
pids="$pids $!"
nginx -c /tmp/nginx/nginx.conf -g 'daemon off;' &
pids="$pids $!"
su-exec grafana /run.sh &
pids="$pids $!"

trap 'kill $pids 2>/dev/null || true; exit 0' TERM INT

while :; do
  for pid in $pids; do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "a monitoring process (pid $pid) exited; stopping" >&2
      kill $pids 2>/dev/null || true
      exit 1
    fi
  done
  sleep 5
done
