#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "macOS Release 只能在 macOS 上构建。" >&2
  exit 1
fi

: "${APPLE_SIGNING_IDENTITY:?请设置 APPLE_SIGNING_IDENTITY，例如 Developer ID Application: Name (TEAMID)}"
: "${APPLE_TEAM_ID:?请设置 APPLE_TEAM_ID}"

if [[ -z "${APPLE_API_ISSUER:-}" || ( -z "${APPLE_API_KEY_PATH:-}" && -z "${APPLE_API_KEY:-}" ) ]]; then
  : "${APPLE_ID:?未配置 App Store Connect API Key 时，请设置 APPLE_ID}"
  : "${APPLE_PASSWORD:?请设置 APPLE_PASSWORD 为 app-specific password}"
fi

npm run build:desktop
