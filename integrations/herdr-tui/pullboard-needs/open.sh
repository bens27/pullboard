#!/bin/sh
# The pullboard.needs "open" action: opens the popup and tells it which workspace the person was in,
# since a popup cannot otherwise know where a step's new tab belongs.
set -eu
herdr="${HERDR_BIN_PATH:-herdr}"
exec "$herdr" plugin pane open --plugin "${HERDR_PLUGIN_ID:-pullboard.needs}" --entrypoint needs --focus \
  --env "PULLBOARD_NEEDS_WORKSPACE=${HERDR_WORKSPACE_ID:-}"
