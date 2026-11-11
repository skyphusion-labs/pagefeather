#!/bin/bash
# Test of lib.sh site_recorded / site_vars: an existing site's recorded hostname, Custom Domain and zone
# win over the computed ones, so an update, import or remove never re-keys its site map entry or moves its
# Custom Domain to another zone. A stand-in terraform answers by STUB_MODE. No account, no network.
#   deploy/wfp/tests/recorded-host-test.sh
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin"
cat > "$T/bin/terraform" <<'SH'
#!/bin/sh
# STUB_MODE: apex (ggc.sh on its own zone), phasea (workers.dev, no domain), none (never applied),
# nozone (a Custom Domain whose state shows no zone_id)
case "$STUB_MODE:$*" in
  apex:"output -raw hostname") printf ggc.sh ;;
  apex:"state list") printf 'cloudflare_r2_bucket.media\ncloudflare_workers_custom_domain.site[0]\ncloudflare_workers_kv.entry\n' ;;
  apex:"state show -no-color cloudflare_workers_custom_domain.site[0]") printf '    hostname    = "ggc.sh"\n    zone_id     = "8a3456a9f80165678f7fca9f7c913e0b"\n    zone_name   = "ggc.sh"\n' ;;
  phasea:"output -raw hostname") printf wp-blog.example.workers.dev ;;
  phasea:"state list") printf 'cloudflare_r2_bucket.media\ncloudflare_workers_kv.entry\n' ;;
  none:"output -raw hostname") echo "No outputs found" >&2; exit 1 ;;
  nozone:"output -raw hostname") printf shop.example.org ;;
  nozone:"state list") printf 'cloudflare_workers_custom_domain.site[0]\n' ;;
  nozone:"state show -no-color cloudflare_workers_custom_domain.site[0]") printf '    hostname = "shop.example.org"\n' ;;
  *) exit 1 ;;
esac
SH
chmod +x "$T/bin/terraform"
export PATH="$T/bin:$PATH" WFP_STATE=local
# shellcheck disable=SC1090,SC1091
. "$HERE/../lib.sh"
fails=0
check() { if [ "$2" = "$3" ]; then echo "PASS $1"; else echo "FAIL $1: got [$2], want [$3]"; fails=$((fails + 1)); fi; }
run() { STUB_MODE=$1; export STUB_MODE; REC_VARS=(); site_vars "$2" sub kv1 && echo "${REC_VARS[*]}"; }
check "apex: the recorded hostname, Custom Domain and its own zone" "$(run apex ggc)" \
  "-var name=ggc -var hostname=ggc.sh -var kv_namespace_id=kv1 -var custom_domain=true -var zone_id=8a3456a9f80165678f7fca9f7c913e0b"
check "apex: WFP_CUSTOM_DOMAIN=0 does not drop the recorded domain" "$(WFP_CUSTOM_DOMAIN=0 run apex ggc)" \
  "-var name=ggc -var hostname=ggc.sh -var kv_namespace_id=kv1 -var custom_domain=true -var zone_id=8a3456a9f80165678f7fca9f7c913e0b"
check "phase A: the recorded workers.dev host, no domain, no zone" "$(run phasea blog)" \
  "-var name=blog -var hostname=wp-blog.example.workers.dev -var kv_namespace_id=kv1 -var custom_domain=false"
check "never applied: the computed host (phase A)" "$(run none three)" \
  "-var name=three -var hostname=wp-three.sub.workers.dev -var kv_namespace_id=kv1 -var custom_domain=false"
STUB_MODE=nozone; export STUB_MODE
out=$(site_vars shop sub kv1 2>&1); rc=$?
check "a Custom Domain with no zone in the state stops" "$rc:$(printf '%s' "$out" | grep -c 'no zone_id')" "1:1"
# The callers use it: an update and a remove read the recorded values.
check "site update and remove use site_vars" "$(grep -c 'site_vars "\$s" "\$SUB" "\$KV_ID"' "$HERE/../site")" "2"
check "site.sh down uses site_vars" "$(grep -c 'site_vars "\$s" "\$SUB" "\$KV_ID"' "$HERE/../site.sh")" "1"
check "site update applies the recorded vars" "$(grep -c 'REC_VARS\[@\]' "$HERE/../site")" "2"
STUB_MODE=apex; export STUB_MODE SUB=sub; site_vars ggc sub kv1
check "site_key: the recorded key after site_vars" "$(site_key ggc)" "ggc.sh"
check "site_key: another site is still computed" "$(site_key blog)" "wp-blog.sub.workers.dev"
check "entry_build and site_footprint read site_key" "$(grep -c 'site_key "\$1"\|site_key "\$s"' "$HERE/../lib.sh")" "3"
check "site remove reads the recorded values before its footprint" "$(grep -c 'so the footprint checks the right entry' "$HERE/../site")" "1"
echo "$fails failing case(s)"
exit $fails
