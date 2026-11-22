#!/usr/bin/env bash
# [opencloud-fork] Live OpenCloud layer: `pnpm test:oc [jest args]`.
#
# Needs the dev server from compose.yml running (`podman-compose up -d`). For each run this script
#   1. creates a short-lived app token for the test user (podman exec … opencloud auth-app create),
#   2. creates a fresh project space, so runs never see each other's files,
#   3. runs jest with jest.opencloud.config.js,
#   4. disables and purges the space again, however the run ends.
#
# Exit codes: 0 pass, 1 test failure, 3 prerequisite missing (server not running, no podman).
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

OC_URL="${OC_URL:-http://localhost:8080}"
OC_USER="${OC_USER:-admin}"
CONTAINER="${OC_CONTAINER:-opencloud-dev}"

command -v podman >/dev/null || { echo "test:oc: podman is not installed." >&2; exit 3; }
if [ "$(curl -sk -o /dev/null -w '%{http_code}' "$OC_URL/status.php" || true)" != "200" ]; then
  echo "test:oc: no OpenCloud server answers at $OC_URL. Start it with: podman-compose up -d" >&2
  exit 3
fi

# compose.yml serves plain HTTP. Against an https:// server with a self-signed certificate (OC_URL=https://…), trust
# exactly the certificate it serves now, for this run only, instead of switching certificate checks off.
CERT_DIR="$(mktemp -d)"
case "$OC_URL" in
  https://*)
    command -v openssl >/dev/null || { echo "test:oc: openssl is needed for an https:// server." >&2; exit 3; }
    HOSTPORT="$(node -e 'const u=new URL(process.argv[1]);process.stdout.write(`${u.hostname}:${u.port||443}`)' "$OC_URL")"
    echo | openssl s_client -connect "$HOSTPORT" -servername "${HOSTPORT%%:*}" 2>/dev/null | openssl x509 > "$CERT_DIR/server.pem" \
      || { echo "test:oc: could not read the server certificate from $HOSTPORT." >&2; exit 3; }
    export NODE_EXTRA_CA_CERTS="$CERT_DIR/server.pem"
    curl() { command curl --cacert "$CERT_DIR/server.pem" "$@"; }
    ;;
esac

OC_TOKEN="$(podman exec "$CONTAINER" opencloud auth-app create --user-name="$OC_USER" --expiration=2h 2>/dev/null \
  | sed -n 's/^ *token: //p')"
[ -n "$OC_TOKEN" ] || { echo "test:oc: could not create an app token in container $CONTAINER." >&2; exit 3; }

SPACE_NAME="ocs-live-$(date +%Y%m%d-%H%M%S)"
SPACE_JSON="$(curl -s -u "$OC_USER:$OC_TOKEN" -X POST -H 'Content-Type: application/json' \
  -d "{\"name\":\"$SPACE_NAME\"}" "$OC_URL/graph/v1.0/drives")"
read_json() { node -e 'const d=JSON.parse(process.argv[1]);const v=process.argv[2].split(".").reduce((o,k)=>o?.[k],d);if(typeof v!=="string")process.exit(1);process.stdout.write(v)' "$SPACE_JSON" "$1"; }
OC_SPACE_ID="$(read_json id)" || { echo "test:oc: could not create a project space: $SPACE_JSON" >&2; exit 3; }
OC_SPACE_DAV="$(read_json root.webDavUrl)"

cleanup() {
  # A project space is disabled first, then purged.
  curl -s -o /dev/null -u "$OC_USER:$OC_TOKEN" -X DELETE "$OC_URL/graph/v1.0/drives/$OC_SPACE_ID" || true
  curl -s -o /dev/null -u "$OC_USER:$OC_TOKEN" -X DELETE -H 'Purge: T' "$OC_URL/graph/v1.0/drives/$OC_SPACE_ID" || true
}
trap 'cleanup; rm -rf "$CERT_DIR"' EXIT

echo "test:oc: space $SPACE_NAME ($OC_SPACE_ID)"
export OC_URL OC_USER OC_TOKEN OC_SPACE_ID OC_SPACE_DAV
export OC_SPACE_NAME="$SPACE_NAME"
node_modules/.bin/jest --config jest.opencloud.config.js "$@"
