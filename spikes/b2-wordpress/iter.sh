#!/bin/bash
# Rebuild, run the install route, and summarise.
cd "$(dirname "$0")"
php -l php/d1-pdo.php >/dev/null && ./build.sh >/dev/null && ./run.sh "${1:-_install}" >/dev/null; python3 show.py
