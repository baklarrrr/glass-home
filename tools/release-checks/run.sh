#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
export NODE_PATH="$PWD/tools/release-checks/node_modules"
node --test tests/*.test.cjs drive/tests/*.test.cjs
node tests/app-menu.cjs
node drive/tests/gps-entry.cjs
node drive/tests/running-build.cjs
node tools/release-checks/release-identity.cjs
