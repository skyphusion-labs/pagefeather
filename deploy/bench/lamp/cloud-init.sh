#!/bin/bash
exec > /root/cloud-init.log 2>&1
set -x
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y apache2 mariadb-server php php-cli php-mysql php-gd php-curl php-mbstring php-xml php-zip php-intl php-bcmath php-soap unzip curl python3 jq libapache2-mod-php
PHPV=$(ls /etc/php 2>/dev/null | head -1)
# production-like OPcache (stock WP hosts run OPcache)
cat > /etc/php/$PHPV/apache2/conf.d/99-bench.ini <<INI
opcache.enable=1
opcache.memory_consumption=128
opcache.max_accelerated_files=10000
opcache.validate_timestamps=0
memory_limit=512M
INI
cp /etc/php/$PHPV/apache2/conf.d/99-bench.ini /etc/php/$PHPV/cli/conf.d/99-bench.ini 2>/dev/null || true
curl -fsSL https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar -o /usr/local/bin/wp && chmod +x /usr/local/bin/wp
a2enmod rewrite
# log request processing time (%D microseconds) for server-time measurement
sed -i 's#%O\\" combined#%O %D\\" benchtime#' /etc/apache2/apache2.conf 2>/dev/null || true
systemctl enable --now mariadb apache2
php -v > /root/versions.txt 2>&1; wp --version --allow-root >> /root/versions.txt 2>&1; mysql --version >> /root/versions.txt 2>&1; apache2 -v >> /root/versions.txt 2>&1
touch /root/.lamp-ready
