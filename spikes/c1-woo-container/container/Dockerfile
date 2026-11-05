# Spike C1: stock WordPress + WooCommerce, SQLite on local disk, Litestream to R2.
# Debian 13 (trixie), named: the php:8.3-cli tag moves with the Debian release,
# and package names change with it (seen on ggc, 2026-11-05).
FROM php:8.3-cli-trixie
ARG LITESTREAM_VERSION=0.5.18
ARG LITESTREAM_SHA256=d3687b9fd0f2e9426bbd3da828429ff3f1dfc5c9b74d54fdf028e4ee510e7dea
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
# Own layer, with retries: GitHub release downloads return 504 at times (seen
# on ggc, 2026-11-05), and a failure here must not discard the layer above.
RUN curl -sfL --retry 5 --retry-all-errors -o /tmp/ls.tgz "https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/litestream-${LITESTREAM_VERSION}-linux-x86_64.tar.gz" \
 && echo "${LITESTREAM_SHA256}  /tmp/ls.tgz" | sha256sum -c - \
 && tar -xzf /tmp/ls.tgz -C /usr/local/bin litestream && rm /tmp/ls.tgz \
 && docker-php-ext-enable opcache \
 && { echo 'memory_limit=256M'; echo 'upload_max_filesize=20M'; echo 'post_max_size=24M'; \
      echo 'opcache.enable_cli=1'; echo 'opcache.memory_consumption=128'; echo 'opcache.validate_timestamps=0'; \
      echo 'expose_php=Off'; echo 'display_errors=Off'; echo 'log_errors=On'; } > /usr/local/etc/php/conf.d/wordpress.ini
COPY build/wordpress/ /var/www/html/
COPY container/kill.php /var/www/html/_kill.php
COPY container/stats.php /var/www/html/_stats.php
COPY container/litestream.yml /etc/litestream.yml
COPY container/entrypoint.sh /usr/local/bin/entrypoint.sh
WORKDIR /var/www/html
# PHP worker count comes from the Worker (PHP_WORKERS); 2 by default. At 256 MB
# each, 4 could pass the 1 GiB of a basic instance.
ENV PHP_CLI_SERVER_WORKERS=2
EXPOSE 80
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
