#!/bin/bash
# Runs ON THE SOURCE SERVER, sent over SSH by deploy/import.sh (issue #31):
#
#   ssh <host> bash -s -- <wordpress dir> db|content [exclude list] < remote-export.sh > out
#
# It only reads. It writes nothing on the server: no file, no temp file, no
# lock (the dump uses --single-transaction --skip-lock-tables, so InnoDB
# tables stay writable). Its only output is stdout.
#
#   db       the database as SQL: mysqldump (or mariadb-dump) --hex-blob
#            --single-transaction --skip-lock-tables --no-tablespaces. The DB_*
#            values come from WP-CLI when the server has it (wp config get:
#            it reads wp-config.php without booting WordPress, and it handles
#            a constant that is not a plain string), else from wp-config.php
#            read as text (the file is not run). WP-CLI's own "db export" is
#            not used: it reads "--no-tablespaces" as a negation and passes
#            "--tablespaces=" to the dump, which mariadb-dump refuses (measured
#            2026-11-06 on the #83 test source, WP-CLI 2.12.0, MariaDB 10.11),
#            and a MySQL 8 dump needs --no-tablespaces without the PROCESS
#            privilege. The password goes to the dump in a defaults file on a
#            pipe (process substitution): it is not in the arguments, not on
#            disk, and never leaves the server.
#   content  wp-content as a gzip tar, without cache-like folders (cache,
#            upgrade, backups of backup plugins). An optional third argument
#            (a space list of paths under wp-content) replaces that list.
set -euo pipefail
WP=${1:?wordpress dir} MODE=${2:?db or content}
[ -f "$WP/wp-config.php" ] || { echo "remote-export: no wp-config.php in $WP" >&2; exit 2; }
DUMP_FLAGS=(--hex-blob --single-transaction --skip-lock-tables --no-tablespaces)
case "$MODE" in
db)
  DUMP=$(command -v mysqldump || command -v mariadb-dump || true)
  [ -n "$DUMP" ] || { echo "remote-export: no mysqldump or mariadb-dump on the server" >&2; exit 2; }
  if command -v wp >/dev/null 2>&1; then
    # The values through WP-CLI; the [client] section is built here.
    wpv() { wp --path="$WP" --skip-plugins --skip-themes config get "$1"; }
    q() { printf '"%s"' "$(printf '%s' "$1" | sed 's/[\\"]/\\&/g')"; }
    client() {
      local h port="" sock=""
      h=$(wpv DB_HOST)
      case "$h" in
        *:/*) sock=${h#*:}; h=${h%%:*} ;;
        *:[0-9]*) port=${h##*:}; h=${h%:*} ;;
      esac
      printf '[client]\nuser=%s\npassword=%s\nhost=%s\n' "$(q "$(wpv DB_USER)")" "$(q "$(wpv DB_PASSWORD)")" "$(q "${h:-localhost}")"
      [ -z "$port" ] || printf 'port=%s\n' "$port"
      [ -z "$sock" ] || printf 'socket=%s\n' "$(q "$sock")"
    }
    name=$(wpv DB_NAME)
    exec "$DUMP" --defaults-extra-file=<(client) "${DUMP_FLAGS[@]}" "$name"
  fi
  command -v php >/dev/null 2>&1 || { echo "remote-export: no wp and no php on the server" >&2; exit 2; }
  # The DB_* constants, read from wp-config.php as text (the file is not run).
  # what=name prints DB_NAME; what=client prints a mysqldump [client] section
  # (user, password, host, and port or socket from DB_HOST).
  # shellcheck disable=SC2016 # PHP code, not shell
  config() {
    php -r '
$s = file_get_contents($argv[1]);
$v = array();
foreach (array("DB_NAME", "DB_USER", "DB_PASSWORD", "DB_HOST") as $k) {
  if (!preg_match("/define\\(\\s*([\x27\"])" . $k . "\\1\\s*,\\s*([\x27\"])(.*?)(?<!\\\\)\\2\\s*\\)/s", $s, $m)) { fwrite(STDERR, "remote-export: $k not found as a string in wp-config.php\n"); exit(2); }
  // Single-quoted: only a doubled backslash and backslash-quote are escapes. Double-quoted: C escapes.
  $v[$k] = $m[2] === "\x27" ? strtr($m[3], array("\\\\" => "\\", "\\\x27" => "\x27")) : stripcslashes($m[3]);
}
if ($argv[2] === "name") { echo $v["DB_NAME"]; exit(0); }
$q = function ($x) { return "\"" . addcslashes($x, "\"\\") . "\""; };
$h = $v["DB_HOST"]; $port = ""; $sock = "";
if (preg_match("#^(.*?):(/.*)$#", $h, $m)) { $h = $m[1]; $sock = $m[2]; }
elseif (preg_match("#^(.*):([0-9]+)$#", $h, $m)) { $h = $m[1]; $port = $m[2]; }
echo "[client]\nuser=", $q($v["DB_USER"]), "\npassword=", $q($v["DB_PASSWORD"]), "\nhost=", $q($h === "" ? "localhost" : $h), "\n";
if ($port !== "") echo "port=$port\n";
if ($sock !== "") echo "socket=", $q($sock), "\n";
' "$WP/wp-config.php" "$1"
  }
  name=$(config name)
  exec "$DUMP" --defaults-extra-file=<(config client) "${DUMP_FLAGS[@]}" "$name"
  ;;
content)
  ex=()
  for p in ${3:-cache upgrade ai1wm-backups updraft backups-dup-lite wflogs}; do ex+=(--exclude="wp-content/$p"); done
  # ${ex[@]+...}: an empty list is fine under set -u on bash 3.2 too.
  exec tar -czf - -C "$WP" ${ex[@]+"${ex[@]}"} wp-content
  ;;
*) echo "remote-export: mode is db or content" >&2; exit 2 ;;
esac
