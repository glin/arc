#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
exec node node_modules/vitest/vitest.mjs run test/hooks-smoke.test.js
