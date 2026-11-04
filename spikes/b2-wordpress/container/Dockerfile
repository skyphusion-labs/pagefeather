# Checkout Container for WooCommerce (issue #20). PHP's built-in server with
# worker processes (Apache crashed in the Cloudflare runtime while the port was
# checked), the same WordPress tree as the Worker (build/wordpress), 256 MB for
# PHP. D1, R2 and Images stay in the Worker: PHP reaches them at
# http://worker.internal/ through a Container outbound handler (WooCheckout).
FROM php:8.3-cli
RUN docker-php-ext-enable opcache \
 && { echo 'memory_limit=256M'; \
      echo 'opcache.enable_cli=1'; \
      echo 'opcache.memory_consumption=128'; \
      echo 'opcache.validate_timestamps=0'; \
      echo 'expose_php=Off'; \
      echo 'display_errors=Off'; \
      echo 'log_errors=On'; } > /usr/local/etc/php/conf.d/wordpress.ini
COPY build/wordpress/ /var/www/html/
COPY container/ping /var/www/html/ping
COPY container/router.php /var/www/html/router.php
COPY container/diag.php /var/www/html/_diag.php
WORKDIR /var/www/html
ENV PHP_CLI_SERVER_WORKERS=4
EXPOSE 80
CMD ["php", "-S", "0.0.0.0:80", "-t", "/var/www/html", "/var/www/html/router.php"]
