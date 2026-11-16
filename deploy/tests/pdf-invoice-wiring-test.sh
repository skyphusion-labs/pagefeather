#!/usr/bin/env bash
# #765: PDF order invoices (php/pdf-invoice.php) on EVERY deploy path, not only one-click. PDF_INVOICE=on binds
# Browser Rendering (BROWSER) and gives the site its own download-signing secret INVOICE_TOKEN (without it the PDF
# is stored but no link is made, index.js). b-dosql only (pdfInvoiceEnabled needs the PHP and DB objects).
# Off or unset renders nothing: byte-identical for every other site. No account, no network.
#   1. deploy/wfp: render_user, site_secrets_json, the recorded setting, the bindings allowlist, the workspace secret;
#   2. deploy/deploy.sh: render_conf, the refusals before any step, the secrets JSON, the workspace secret.
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
fails=0
ok() { if [ "$2" = 1 ]; then echo "  ok   $1"; else echo "  FAIL $1"; fails=$((fails+1)); fi; }
T=$(mktemp -d "${TMPDIR:-/tmp}/pdf-invoice-wiring-test.XXXXXX")
trap '[ -n "${KEEP_T:-}" ] || rm -rf "$T"' EXIT
# shellcheck source=SCRIPTDIR/lib.sh
. "$ROOT/deploy/tests/lib.sh"
FENCE="$T/fence"; fence_dir "$FENCE"
LIB="$ROOT/deploy/wfp/lib.sh"
R=https://wp-one.sub.workers.dev
ru() { env -i PATH="$PATH" HOME="$T" "$@" bash -c ". '$LIB' >/dev/null 2>&1; render_user one '$R'" 2> "$T/ru.err"; }
browser_count() { grep -cx 'binding = "BROWSER"' | tr -d ' '; }

echo "1. deploy/wfp"
o=$(ru); ok "unset: no [browser] in the user Worker config" "$([ $? = 0 ] && [ "$(printf '%s\n' "$o" | grep -c '^\[browser\]')" = 0 ] && echo 1 || echo 0)"
o=$(ru PDF_INVOICE=off); ok "off: no [browser]" "$([ $? = 0 ] && [ "$(printf '%s\n' "$o" | grep -c '^\[browser\]')" = 0 ] && echo 1 || echo 0)"
o=$(ru PDF_INVOICE=on); rc=$?
ok "on: exactly one [browser] binding BROWSER (rc $rc)" "$([ $rc = 0 ] && [ "$(printf '%s\n' "$o" | grep -c '^\[browser\]')" = 1 ] && [ "$(printf '%s\n' "$o" | sed -n '/^\[browser\]/,/^\[/p' | browser_count)" = 1 ] && echo 1 || echo 0)"
for bad in yes 1 ON true; do ru PDF_INVOICE=$bad >/dev/null; ok "PDF_INVOICE=$bad: the render fails, named" "$([ $? != 0 ] && grep -q 'PDF_INVOICE must be on, off or unset' "$T/ru.err" && echo 1 || echo 0)"; done
tf='{"wp_salt":{"value":"salt-1"},"spike_token":{"value":"tok-1"},"invoice_token":{"value":"inv-1"}}'
tf_old='{"wp_salt":{"value":"salt-1"},"spike_token":{"value":"tok-1"}}'
sj() { local out=$1 in=$2; shift 2; printf '%s' "$in" | env -i PATH="$PATH" HOME="$T" "$@" bash -c ". '$LIB' >/dev/null 2>&1; site_secrets_json '$out'" > "$T/sj.out" 2> "$T/sj.err"; }
sj "$T/a.json" "$tf"; ok "unset: no INVOICE_TOKEN in the secrets JSON" "$([ $? = 0 ] && python3 -I -c 'import json,sys; sys.exit(0 if "INVOICE_TOKEN" not in json.load(open(sys.argv[1])) else 1)' "$T/a.json" && echo 1 || echo 0)"
sj "$T/b.json" "$tf" PDF_INVOICE=on; ok "on: INVOICE_TOKEN is the workspace's invoice_token" "$([ $? = 0 ] && python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if d.get("INVOICE_TOKEN") == "inv-1" and d["WP_SALT"] == "salt-1" else 1)' "$T/b.json" && echo 1 || echo 0)"
ok "  and nothing is printed to stdout" "$([ ! -s "$T/sj.out" ] && echo 1 || echo 0)"
sj "$T/c.json" "$tf_old" PDF_INVOICE=on; ok "on, but the workspace has no invoice_token: refused, named (a PDF with no link is not a pass)" "$([ $? != 0 ] && grep -q "has no invoice_token output" "$T/sj.err" && echo 1 || echo 0)"
ok "PDF_INVOICE is a recorded setting (lib.sh SITE_SETTINGS)" "$(env -i PATH="$PATH" HOME="$T" bash -c ". '$LIB' >/dev/null 2>&1; echo \" \$SITE_SETTINGS \"" | grep -q ' PDF_INVOICE ' && echo 1 || echo 0)"
ok "  and site_settings.py SETTINGS" "$(python3 -I -c 'import sys; sys.path.insert(0, sys.argv[1]); import site_settings as s; print(int("PDF_INVOICE" in s.SETTINGS))' "$ROOT/deploy/wfp" 2>/dev/null)"
ok "bindings.py allows the secret INVOICE_TOKEN and the binding type browser" "$(python3 -I -c 'import sys; sys.path.insert(0, sys.argv[1]); import bindings as b; print(int("INVOICE_TOKEN" in b.SECRETS_OK and "browser" in b.USER_OK))' "$ROOT/deploy/wfp" 2>/dev/null)"
ok "the site workspace makes invoice_token and outputs it as sensitive" "$(python3 -I - "$ROOT/deploy/wfp/terraform/site/main.tf" <<'PY'
import re, sys
s = open(sys.argv[1]).read()
print(int(bool(re.search(r'resource "random_password" "invoice_token" \{', s)) and bool(re.search(r'output "invoice_token" \{\s*value\s*=\s*random_password\.invoice_token\.result\s*sensitive\s*=\s*true', s))))
PY
)"

echo "2. deploy/deploy.sh"
APP="$ROOT/spikes/b2-wordpress"
COMPAT=$(sed -n 's/^compatibility_date = "\(.*\)"/\1/p' "$APP/wrangler.toml" | head -1)
rc_() { # rc_ <out.toml> [VAR=value ...]: deploy.sh's b-dosql config, in a clean environment
  local dst=$1; shift
  # shellcheck disable=SC2016  # the script expands in the child shell
  env -i PATH="$PATH" HOME="$T" ROOT="$ROOT" APP="$APP" COMPAT="$COMPAT" NAME=pf-render VARIANT=b-dosql LOCATION=wnam \
    SITE_ORIGIN=https://pf-render.example.workers.dev BUCKET=MEDIA_BUCKET AI=0 "$@" bash -c '
      set -e
      . "$ROOT/deploy/a-settings.sh"; . "$ROOT/deploy/observability.sh"; . "$ROOT/deploy/render-conf.sh"
      out() { echo "STUB_$1"; }
      cd "$APP" && render_conf' > "$dst" 2> "$T/rc.err"
}
rc_ "$T/u.toml"; r=$?; ok "unset: render_conf ran and has no [browser] (rc $r)" "$([ $r = 0 ] && [ "$(grep -c '^\[browser\]' "$T/u.toml")" = 0 ] && echo 1 || echo 0)"; [ $r = 0 ] || cat "$T/rc.err"
rc_ "$T/on.toml" PDF_INVOICE=on; r=$?; ok "on: exactly one [browser] binding BROWSER (rc $r)" "$([ $r = 0 ] && [ "$(grep -c '^\[browser\]' "$T/on.toml")" = 1 ] && [ "$(sed -n '/^\[browser\]/,/^\[/p' "$T/on.toml" | browser_count)" = 1 ] && echo 1 || echo 0)"
ok "on and unset differ by the [browser] binding only" "$({ diff <(grep -v '^ *$' "$T/u.toml") <(grep -v '^ *$' "$T/on.toml") || true; } | grep -E '^[<>]' | LC_ALL=C sort | tr '\n' '|' | grep -Fqx '> [browser]|> binding = "BROWSER"|' && echo 1 || echo 0)"
refuse "PDF_INVOICE must be on, off or unset" VARIANT=b-dosql PDF_INVOICE=yes
refuse "PDF_INVOICE is for variant b-dosql" VARIANT=a PDF_INVOICE=on
ok "deploy.sh writes its secrets through deploy_secrets_json (one writer)" "$(grep -q 'deploy_secrets_json "\$SECRETS"' "$ROOT/deploy/deploy.sh" && ! grep -qE '"SPIKE_TOKEN": ?o\["spike_token"\]' "$ROOT/deploy/deploy.sh" && echo 1 || echo 0)"
dj() { local out=$1 in=$2; shift 2; printf '%s' "$in" | env -i PATH="$PATH" HOME="$T" ROOT="$ROOT" "$@" bash -c ". '$ROOT/deploy/pdf-invoice.sh' && deploy_secrets_json '$out'" > "$T/dj.out" 2> "$T/dj.err"; }
dj "$T/d1.json" "$tf"; ok "deploy_secrets_json, unset: exactly WP_SALT and SPIKE_TOKEN" "$([ $? = 0 ] && python3 -I -c 'import json,sys; sys.exit(0 if json.load(open(sys.argv[1])) == {"WP_SALT":"salt-1","SPIKE_TOKEN":"tok-1"} else 1)' "$T/d1.json" && echo 1 || echo 0)"
dj "$T/d2.json" "$tf" PDF_INVOICE=on; ok "deploy_secrets_json, on: plus INVOICE_TOKEN" "$([ $? = 0 ] && python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if d.get("INVOICE_TOKEN") == "inv-1" and len(d) == 3 else 1)' "$T/d2.json" && echo 1 || echo 0)"
dj "$T/d3.json" "$tf_old" PDF_INVOICE=on; ok "deploy_secrets_json, on, no invoice_token output: refused, named" "$([ $? != 0 ] && grep -q "has no invoice_token output" "$T/dj.err" && echo 1 || echo 0)"
mode=$(stat -c '%a' "$T/d2.json" 2>/dev/null || stat -f '%Lp' "$T/d2.json"); ok "the secrets file is mode 600 (got $mode)" "$([ "$mode" = 600 ] && echo 1 || echo 0)"
ok "deploy/terraform makes invoice_token and outputs it as sensitive" "$(python3 -I - "$ROOT/deploy/terraform" <<'PY'
import glob, re, sys
s = ''.join(open(f).read() for f in glob.glob(sys.argv[1] + '/*.tf'))
print(int(bool(re.search(r'resource "random_password" "invoice_token" \{', s)) and bool(re.search(r'output "invoice_token" \{\s*value\s*=\s*random_password\.invoice_token\.result\s*sensitive\s*=\s*true', s))))
PY
)"
echo "$fails failing case(s)"
[ "$fails" = 0 ]
