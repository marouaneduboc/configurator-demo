#!/bin/zsh

set -u

PROJECT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
HOST="127.0.0.1"
PORT="8765"
URL="http://${HOST}:${PORT}/index.html"
LOG_FILE="${TMPDIR:-/tmp}/configurator-demo-server.log"
PID_FILE="${TMPDIR:-/tmp}/configurator-demo-server.pid"

serves_configurator() {
  /usr/bin/curl --silent --fail --max-time 1 \
    "http://${HOST}:${PORT}/model.glb" \
    --output /dev/null
}

if ! serves_configurator; then
  if /usr/sbin/lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
    /usr/bin/osascript -e \
      'display alert "Configurator could not start" message "Port 8765 is already used by another application." as critical'
    exit 1
  fi

  cd "${PROJECT_DIR}" || exit 1
  /usr/bin/nohup /usr/bin/python3 -m http.server "${PORT}" \
    --bind "${HOST}" --directory "${PROJECT_DIR}" \
    >"${LOG_FILE}" 2>&1 &
  echo $! >"${PID_FILE}"

  for _ in {1..30}; do
    serves_configurator && break
    /bin/sleep 0.1
  done
fi

if serves_configurator; then
  /usr/bin/open "${URL}"
else
  /usr/bin/osascript -e \
    'display alert "Configurator could not start" message "The local web server failed to start. See the server log in the temporary folder." as critical'
  exit 1
fi
