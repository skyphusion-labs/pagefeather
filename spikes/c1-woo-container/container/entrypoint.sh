#!/bin/sh
# Spike C1 container start:
# 1. Restore the SQLite file from R2 if a replica exists (a sleeping container
#    loses its disk).
# 2. Otherwise install WordPress and WooCommerce.
# 3. Run PHP's server under Litestream, which replicates every change to R2
#    while PHP runs.
set -e
mkdir -p /data
litestream restore -config /etc/litestream.yml -if-db-not-exists -if-replica-exists /data/wordpress.sqlite
if [ ! -f /data/wordpress.sqlite ]; then
	echo "no replica: installing"
	php /var/www/html/install.php
fi
chown -R www-data:www-data /data 2>/dev/null || true
exec litestream replicate -config /etc/litestream.yml -exec "php -S 0.0.0.0:80 -t /var/www/html /var/www/html/router.php"
