#!/bin/bash
# Local spike for issue 1258. See README.md.
set -euo pipefail
cd "$(dirname "$0")"
exec python3 measure.py "$@"
