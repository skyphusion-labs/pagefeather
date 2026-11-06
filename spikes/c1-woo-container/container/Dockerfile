# Spike C1: stock WordPress + WooCommerce, SQLite on local disk, Litestream to R2.
# Debian 13 (trixie), named: the php:8.3 tags move with the Debian release,
# and package names change with it (seen on ggc, 2026-11-05).
# PHP-FPM behind nginx (issue #99): one request per child, so a slow request
# cannot hold a shopper the way it could under php -S.
FROM php:8.3-fpm-trixie
ARG LITESTREAM_VERSION=0.5.18
ARG LITESTREAM_SHA256=d3687b9fd0f2e9426bbd3da828429ff3f1dfc5c9b74d54fdf028e4ee510e7dea
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl nginx && rm -rf /var/lib/apt/lists/* \
 && rm -f /etc/nginx/sites-enabled/default
# Own layer, with retries: GitHub release downloads return 504 at times (seen
# on ggc, 2026-11-05), and a failure here must not discard the layer above.
RUN curl -sfL --retry 5 --retry-all-errors -o /tmp/ls.tgz "https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/litestream-${LITESTREAM_VERSION}-linux-x86_64.tar.gz" \
 && echo "${LITESTREAM_SHA256}  /tmp/ls.tgz" | sha256sum -c - \
 && tar -xzf /tmp/ls.tgz -C /usr/local/bin litestream && rm /tmp/ls.tgz \
 && docker-php-ext-enable opcache \
 && { echo 'memory_limit=256M'; echo 'upload_max_filesize=20M'; echo 'post_max_size=24M'; \
      echo 'opcache.memory_consumption=128'; echo 'opcache.validate_timestamps=0'; \
      echo 'expose_php=Off'; echo 'display_errors=Off'; echo 'log_errors=On'; } > /usr/local/etc/php/conf.d/wordpress.ini
# APCu (object cache, wp-content/object-cache.php): PECL source, pinned and
# checked. The build tools are removed again in the same layer.
ARG APCU_VERSION=5.1.28
ARG APCU_SHA256=ca9c1820810a168786f8048a4c3f8c9e3fd941407ad1553259fb2e30b5f057bf
RUN curl -sfL --retry 5 --retry-all-errors -o /tmp/apcu.tgz "https://pecl.php.net/get/apcu-${APCU_VERSION}.tgz" \
 && echo "${APCU_SHA256}  /tmp/apcu.tgz" | sha256sum -c - \
 && apt-get update && apt-get install -y --no-install-recommends $PHPIZE_DEPS \
 && mkdir -p /usr/src/php/ext/apcu && tar -xzf /tmp/apcu.tgz -C /usr/src/php/ext/apcu --strip-components=1 \
 && docker-php-ext-install apcu \
 && apt-get purge -y --auto-remove $PHPIZE_DEPS && rm -rf /var/lib/apt/lists/* /tmp/apcu.tgz /usr/src/php \
 && echo 'apc.shm_size=64M' > /usr/local/etc/php/conf.d/apcu-wordpress.ini
COPY build/wordpress/ /var/www/html/
# FPM children run as www-data (php -S ran as root): WordPress and its plugins
# write in wp-content.
RUN chown -R www-data:www-data /var/www/html/wp-content
COPY build/opt/object-cache.php /opt/wp/object-cache.php
COPY container/kill.php /var/www/html/_kill.php
COPY container/stats.php /var/www/html/_stats.php
COPY container/seed-counts.php /opt/wp/seed-counts.php
COPY container/seed.sh /opt/wp/seed.sh
COPY container/litestream.yml /etc/litestream.yml
COPY container/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY container/c1-serve.sh /usr/local/bin/c1-serve.sh
COPY container/bootlog.sh /usr/local/bin/bootlog.sh
COPY container/nginx.conf /etc/nginx/nginx.conf
COPY container/php-fpm-c1.conf /usr/local/etc/php-fpm.d/zzz-c1.conf
COPY container/c1-prepend.php /var/www/html/c1-prepend.php
RUN chmod 755 /usr/local/bin/c1-serve.sh /usr/local/bin/entrypoint.sh && nginx -t && PHP_WORKERS=2 php-fpm -t
WORKDIR /var/www/html
# PHP-FPM children come from the Worker (PHP_WORKERS); 2 by default. At 256 MB
# each, 4 could pass the 1 GiB of a basic instance.
ENV PHP_WORKERS=2
EXPOSE 80
# The php-fpm image sets STOPSIGNAL SIGQUIT (for php-fpm as PID 1). Here PID 1
# is entrypoint.sh, which handles SIGTERM: with SIGQUIT, docker stop sent a
# signal that PID 1 ignored, then SIGKILL (exit 137, no Litestream final sync;
# found in the smoke test, issue #99). SIGTERM is what php:8.3-cli had.
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
# The php-fpm image sets CMD ["php-fpm"]; the entrypoint ignores it.
CMD []
