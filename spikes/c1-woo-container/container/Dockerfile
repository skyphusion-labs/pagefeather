# Spike C1: stock WordPress + WooCommerce, SQLite on local disk, Litestream to R2.
FROM php:8.3-cli
ARG LITESTREAM_VERSION=0.5.18
ARG LITESTREAM_SHA256=d3687b9fd0f2e9426bbd3da828429ff3f1dfc5c9b74d54fdf028e4ee510e7dea
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/* \
 && curl -sfL -o /tmp/ls.tgz "https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/litestream-${LITESTREAM_VERSION}-linux-x86_64.tar.gz" \
 && echo "${LITESTREAM_SHA256}  /tmp/ls.tgz" | sha256sum -c - \
 && tar -xzf /tmp/ls.tgz -C /usr/local/bin litestream && rm /tmp/ls.tgz \
 && docker-php-ext-enable opcache \
 && { echo 'memory_limit=256M'; echo 'upload_max_filesize=20M'; echo 'post_max_size=24M'; \
      echo 'opcache.enable_cli=1'; echo 'opcache.memory_consumption=128'; echo 'opcache.validate_timestamps=0'; \
      echo 'expose_php=Off'; echo 'display_errors=Off'; echo 'log_errors=On'; } > /usr/local/etc/php/conf.d/wordpress.ini
COPY build/wordpress/ /var/www/html/
COPY container/kill.php /var/www/html/_kill.php
COPY container/litestream.yml /etc/litestream.yml
COPY container/entrypoint.sh /usr/local/bin/entrypoint.sh
WORKDIR /var/www/html
# PHP worker count comes from the Worker (PHP_WORKERS); 2 by default. At 256 MB
# each, 4 could pass the 1 GiB of a basic instance.
ENV PHP_CLI_SERVER_WORKERS=2
EXPOSE 80
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
