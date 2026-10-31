#!/bin/sh
# Install the real MCP servers behind the summit-local eval tier into
# vendor/servers-real, exactly as pinned: the npm memory server from its
# lockfile, and the Python servers from hash-pinned requirements into two
# venvs (the archived reference SQLite server needs the 1.x Python MCP SDK,
# the others the 2.x one). Needs npm and uv (https://docs.astral.sh/uv/);
# uv fetches Python 3.12 if it is not installed.
set -eu
cd "$(dirname "$0")/../vendor/servers-real"
if ! command -v uv >/dev/null 2>&1; then
  echo "setup:servers-real needs uv (https://docs.astral.sh/uv/getting-started/installation/)" >&2
  exit 1
fi
npm ci --no-audit --no-fund --ignore-scripts
uv venv --quiet --allow-existing --python 3.12 .venv
uv pip sync --quiet --python .venv/bin/python --require-hashes requirements.txt
uv venv --quiet --allow-existing --python 3.12 .venv-sqlite
uv pip sync --quiet --python .venv-sqlite/bin/python --require-hashes requirements-sqlite.txt
echo "summit-local servers installed in $(pwd)"
