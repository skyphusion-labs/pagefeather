#!/bin/bash
# Setup two WP installs (plain + woo) on the LAMP box and measure server-side time from localhost.
set -uo pipefail
W=/private/tmp/claude-501/-Users-conrad-dev/fe5eb5a2-eaf4-4025-bb27-73921fdcf1aa/scratchpad/wfp
IP=$(grep '^IP=' "$W/lamp-ready.txt" | cut -d= -f2)
[ -z "$IP" ] && { echo "no LAMP IP yet"; exit 1; }
SSHO="-i /Users/conrad/.ssh/id_ed25519.mackaye -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20"
LOG="$W/lamp-run.log"; RESULT="$W/lamp-result.txt"
scp $SSHO "$W/woo.py" "$W/break_lib.py" root@"$IP":/root/ >/dev/null 2>&1
ssh $SSHO root@"$IP" 'bash -s' >"$LOG" 2>&1 <<'REMOTE'
set -uo pipefail
DBPW=$(openssl rand -hex 16); APW=$(openssl rand -hex 16); echo "$APW" > /root/.benchpw; chmod 600 /root/.benchpw /root/.benchpw
mysql -e "CREATE DATABASE IF NOT EXISTS wp_plain; CREATE DATABASE IF NOT EXISTS wp_woo; CREATE USER IF NOT EXISTS 'wp'@'localhost' IDENTIFIED BY '$DBPW'; GRANT ALL ON wp_plain.* TO 'wp'@'localhost'; GRANT ALL ON wp_woo.* TO 'wp'@'localhost'; FLUSH PRIVILEGES;"
WPVER=7.1.4
setup_wp(){ # dir db url
  mkdir -p "$1"; cd "$1"
  wp core download --version="$WPVER" --allow-root 2>/tmp/wpdl.log || { wp core download --allow-root; echo "NOTE: WP $WPVER unavailable, used latest $(wp core version --allow-root)"; }
  wp config create --dbname="$2" --dbuser=wp --dbpass="$DBPW" --allow-root --force
  wp core install --url="$3" --title="bench" --admin_user=admin --admin_password="$APW" --admin_email=a@b.com --skip-email --allow-root
  wp rewrite structure '/%postname%/' --allow-root; wp rewrite flush --hard --allow-root
}
echo "== wp-plain =="; setup_wp /var/www/wp-plain wp_plain http://localhost:8081
wp --path=/var/www/wp-plain post create --post_title='Hello Bench' --post_status=publish --post_content='Benchmark post body.' --allow-root
echo "== wp-woo =="; setup_wp /var/www/wp-woo wp_woo http://localhost:8082
cd /var/www/wp-woo; wp plugin install woocommerce --version=11.2.1 --activate --allow-root 2>/tmp/wcinstall.log || { wp plugin install woocommerce --activate --allow-root; echo "NOTE: WC 11.2.1 unavailable, used $(wp plugin get woocommerce --field=version --allow-root)"; }
echo "WP: $(wp --path=/var/www/wp-plain core version --allow-root)  WC: $(wp --path=/var/www/wp-woo plugin get woocommerce --field=version --allow-root)"
chown -R www-data:www-data /var/www/wp-plain /var/www/wp-woo
grep -q 'Listen 8081' /etc/apache2/ports.conf || printf 'Listen 8081\nListen 8082\n' >> /etc/apache2/ports.conf
for p in plain:8081 woo:8082; do n=${p%:*}; port=${p#*:}; cat > /etc/apache2/sites-available/wp-$n.conf <<V
<VirtualHost *:$port>
  DocumentRoot /var/www/wp-$n
  <Directory /var/www/wp-$n>
    AllowOverride All
    Require all granted
  </Directory>
</VirtualHost>
V
a2ensite wp-$n >/dev/null 2>&1; done
systemctl reload apache2; sleep 2
med(){ python3 -c 'import sys;v=sorted(float(x) for x in sys.stdin.read().split());print("median=%.3fs min=%.3fs n=%d"%(v[len(v)//2],v[0],len(v)))'; }
echo "== PLAIN WORDPRESS server time (localhost, warm, 15 samples) =="
for i in $(seq 1 5); do curl -s -o /dev/null http://localhost:8081/; done
echo -n "  home / : "; for i in $(seq 1 15); do curl -s -o /dev/null -w '%{time_total}\n' http://localhost:8081/; done | med
echo -n "  post   : "; for i in $(seq 1 15); do curl -s -o /dev/null -w '%{time_total}\n' http://localhost:8081/hello-bench/; done | med
echo "== WOOCOMMERCE via woo.py (localhost:8082, server time) =="
B=http://localhost:8082 ADMIN_PASSWORD="$APW" python3 /root/woo.py 2>&1 | grep -E '^(PASS|FAIL)|pass,'
echo "== WOO page server time (warm, 15) =="
for i in $(seq 1 5); do curl -s -o /dev/null http://localhost:8082/shop/; done
echo -n "  shop   : "; for i in $(seq 1 15); do curl -s -o /dev/null -w '%{time_total}\n' http://localhost:8082/shop/; done | med
REMOTE
{ echo "LAMP BENCHMARK (lamp-bench vc2-2c-4gb, server-side localhost) $(date -u +%H:%M:%SZ)"; grep -E 'WP:|NOTE:|home /|post|shop|^(PASS|FAIL)|pass,|median' "$LOG"; } > "$RESULT"
cat "$RESULT"
