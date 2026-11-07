#!/bin/sh
# Installs the pullboard.needs Herdr plugin; see README.md. Node runs the work so plugins.json is
# edited as JSON rather than by text substitution.
set -eu
exec node "$(cd "$(dirname "$0")" && pwd)/install.js" "$@"
