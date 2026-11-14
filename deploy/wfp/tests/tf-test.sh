#!/bin/bash
# Terraform checks of deploy/wfp (issue #35), offline (no credentials; the
# providers are downloaded on the first init). CI runs it with a checksum-verified
# terraform 1.17.1 (issue #336); run it locally before a live run too.
#   deploy/wfp/tests/tf-test.sh [a copy of deploy/wfp/terraform]
# - terraform validate and fmt for terraform/shared and terraform/site;
# - terraform/site makes no account token (#273): the keys that empty the bucket
#   and put an import's uploads are temporary R2 credentials (r2_temp.py), so the
#   deploy token needs no API Tokens permission.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
TFD=${1:-$HERE/../terraform}
fails=0
ok() { if [ "$2" = 1 ]; then echo "PASS $1"; else echo "FAIL $1"; fails=$((fails + 1)); fi; }
for r in shared site; do
	(cd "$TFD/$r" && terraform init -backend=false -input=false >/dev/null 2>&1 && terraform validate -no-color >/dev/null 2>&1); ok "$r: terraform validate" "$([ $? = 0 ] && echo 1 || echo 0)"
	(cd "$TFD/$r" && terraform fmt -check >/dev/null 2>&1); ok "$r: terraform fmt" "$([ $? = 0 ] && echo 1 || echo 0)"
done
g=$(cd "$TFD/site" && terraform graph 2>/dev/null)
[ -n "$g" ] || { echo "FAIL terraform graph gave nothing"; exit 1; }
ok "site: the graph has no cloudflare_account_token (#273)" "$(printf '%s\n' "$g" | grep -q 'cloudflare_account_token' && echo 0 || echo 1)"
# The control: the graph has the media bucket, so the check above reads a real graph.
ok "site: the graph has the media bucket (the check above can see a resource)" "$(printf '%s\n' "$g" | grep -q '"cloudflare_r2_bucket.media"' && echo 1 || echo 0)"
# #540: the expiry of the scheduled snapshots. The rules must equal the "pagefeather#540" shape
# of fleet-chezmoi's wp-wfp-*-media pattern (fc#2654), or the daily R2 census reads a FINDING.
ok "site: the graph has the media bucket lifecycle (#540)" "$(printf '%s\n' "$g" | grep -q '"cloudflare_r2_bucket_lifecycle.media"' && echo 1 || echo 0)"
ok "site: the lifecycle is exactly the fc#2654 shape: the default abort (604800 s) and snapshots-auto-35d on _snapshots/auto/ (3024000 s)" "$(python3 -I - "$TFD/site/main.tf" <<'PY2'
import re, sys
s = open(sys.argv[1]).read()
m = re.search(r'resource "cloudflare_r2_bucket_lifecycle" "media" \{(.*?)\n\}\n', s, re.S)
if not m:
    print(0); sys.exit()
b = m.group(1)
rules = re.findall(r'id\s*=\s*"([^"]+)".*?prefix\s*=\s*"([^"]*)".*?(abort_multipart_uploads_transition|delete_objects_transition).*?max_age\s*=\s*(\d+)', b, re.S)
want = [("Default Multipart Abort Rule", "", "abort_multipart_uploads_transition", "604800"),
        ("snapshots-auto-35d", "_snapshots/auto/", "delete_objects_transition", "3024000")]
print(1 if rules == want and b.count("enabled = true") == 2 and "bucket_name = cloudflare_r2_bucket.media.name" in b else 0)
PY2
)"
ok "site: no delete rule reaches the rollback snapshots, _build/ or uploads/ (#540)" "$(python3 -I - "$TFD/site/main.tf" <<'PY3'
import re, sys
s = open(sys.argv[1]).read()
b = re.search(r'resource "cloudflare_r2_bucket_lifecycle" "media" \{(.*?)\n\}\n', s, re.S).group(1)
dels = re.findall(r'prefix\s*=\s*"([^"]*)"\s*\}\s*delete_objects_transition', b, re.S)
keep = ["_snapshots/ggc/b1-20261114T000000Z.ndjson", "_build/inputs.json", "uploads/2026/11/a.jpg"]
print(1 if dels == ["_snapshots/auto/"] and not any(k.startswith(p) for p in dels for k in keep) else 0)
PY3
)"
echo "$fails failing check(s)"
exit $fails
