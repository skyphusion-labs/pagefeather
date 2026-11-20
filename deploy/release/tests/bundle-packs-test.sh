#!/usr/bin/env bash
# The release bundle ships the remote packs (#1036). deploy.sh already does (#598 b-dosql,
# #1033 approach A): opcache and site packs under /_pf/, plus the index the Worker reads.
# A one-click store is built from this bundle, so both engines must carry those files as
# release assets. OPCACHE_REMOTE=0 (a null index and no _pf tree) opts out.
# Offline. No WordPress build: a fixture tree, the same packager build-bundle.sh calls.
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
CLI="$HERE/bundle-cli.mjs"
BB="$HERE/build-bundle.sh"
fails=0
check() { if [ "$2" = "$3" ]; then echo "  ok   $1"; else echo "  FAIL $1: got '$2', want '$3'"; fails=$((fails + 1)); fi; }
T=$(mktemp -d "${TMPDIR:-/tmp}/bundle-packs.XXXXXX")
trap 'rm -rf "$T"' EXIT

# tree <dir> <id> <packed|off|bad>
tree() {
  local d=$1 id=$2 mode=$3
  mkdir -p "$d"
  if [ "$mode" = off ]; then
    printf 'export default null;\n' > "$d/opcache-remote-index.js"
    printf 'export default null;\n' > "$d/site-remote-index.js"
    return
  fi
  mkdir -p "$d/public/_pf/$id"
  printf 'oc' > "$d/public/_pf/$id/oc-0.zip"
  printf 'st' > "$d/public/_pf/$id/st-0.zip"
  printf 'export default {"id":"%s","packs":[{"name":"oc-0.zip","bytes":2,"sha256":"aa"}],"files":{"a.php":[0,1]}};\n' "$id" > "$d/opcache-remote-index.js"
  printf 'export default {"id":"%s","packs":[{"name":"st-0.zip","bytes":2,"sha256":"bb"}],"files":{"b.php":[0,2]},"hot":null,"dirs":[]};\n' "$id" > "$d/site-remote-index.js"
  if [ "$mode" = bad ]; then
    printf 'export default null;\n' > "$d/opcache-remote-index.js"
    printf 'export default null;\n' > "$d/site-remote-index.js"
  fi
}

# manifest <path>: a stand-in for the module manifest build-bundle.sh writes first.
manifest() { printf '{"schema":1,"version":"0.0.0","modules":[]}\n' > "$1"; }

echo "1. a dosql bundle and an approach A bundle carry the packs and their index"
tree "$T/packed" bid-wooprimed packed
manifest "$T/dosql-manifest.json"
out=$(node "$CLI" packs "$T/packed" "$T/dosql" "" "$T/dosql-manifest.json" 2>&1); rc=$?
check "dosql: packs exits 0" "$rc" 0
[ "$rc" = 0 ] || echo "$out" | head -20
manifest "$T/a-manifest.json"
out=$(node "$CLI" packs "$T/packed" "$T/a" "a." "$T/a-manifest.json" 2>&1); rc=$?
check "approach A: packs exits 0 (assets prefixed a.)" "$rc" 0
[ "$rc" = 0 ] || echo "$out" | head -20

node --input-type=module - "$T" <<'JS'
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
const T = process.argv[2];
const sha = (b) => createHash('sha256').update(b).digest('hex');
let bad = 0;
const fail = (m) => { console.log('  FAIL ' + m); bad++; };
const ok = (m) => console.log('  ok   ' + m);
function look(label, dir, prefix, manifestPath) {
  const indexPath = dir + '/' + prefix + 'remote-packs-index.json';
  if (!existsSync(indexPath)) { fail(label + ': no ' + prefix + 'remote-packs-index.json'); return; }
  const raw = readFileSync(indexPath);
  let idx;
  try { idx = JSON.parse(raw); } catch (e) { fail(label + ': index is not JSON'); return; }
  const id = 'bid-wooprimed';
  if (idx.schema !== 1) fail(label + ': schema ' + idx.schema);
  else ok(label + ': index schema 1');
  if (!idx.opcache || idx.opcache.id !== id) fail(label + ': opcache index id');
  else ok(label + ': opcache index id ' + id);
  if (!idx.site || idx.site.id !== id) fail(label + ': site index id');
  else ok(label + ': site index id ' + id);
  const want = ['/_pf/' + id + '/oc-0.zip', '/_pf/' + id + '/st-0.zip'];
  const got = (idx.files || []).map((f) => f.path).sort();
  if (got.join(',') !== want.slice().sort().join(',')) fail(label + ': paths ' + got.join(','));
  else ok(label + ': both pack paths');
  for (const f of idx.files || []) {
    const name = prefix + f.asset;
    const p = dir + '/' + name;
    if (!existsSync(p)) { fail(label + ': missing asset ' + name); continue; }
    const bytes = readFileSync(p);
    if (sha(bytes) !== f.sha256) fail(label + ': ' + name + ' sha256');
    else ok(label + ': ' + name + ' sha256');
    if (typeof f.hash !== 'string' || !/^[0-9a-f]{32}$/.test(f.hash)) fail(label + ': ' + name + ' asset hash');
    else ok(label + ': ' + name + ' asset hash');
  }
  if (!existsSync(manifestPath)) { fail(label + ': no manifest to stamp'); return; }
  const man = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (man.assetsIndexSha256 !== sha(raw)) fail(label + ': manifest assetsIndexSha256');
  else ok(label + ': manifest pins the pack index');
}
look('dosql', T + '/dosql', '', T + '/dosql-manifest.json');
look('approach A', T + '/a', 'a.', T + '/a-manifest.json');
process.exit(bad === 0 ? 0 : 1);
JS
check "the index and the pack bytes check out for both engines" "$?" 0

echo "2. opt-out, and a pack tree with no index is refused"
tree "$T/off" bid-wooprimed off
out=$(node "$CLI" packs "$T/off" "$T/off-rel" "" 2>&1); rc=$?
check "OPCACHE_REMOTE off (null index, no _pf): exits 0" "$rc" 0
check "  and writes no pack index" "$([ -e "$T/off-rel/remote-packs-index.json" ] && echo yes || echo no)" no
tree "$T/bad" bid-wooprimed bad
out=$(node "$CLI" packs "$T/bad" "$T/bad-rel" "" 2>&1); rc=$?
check "packs on disk with a null index: exits 1" "$rc" 1
check "  and names the index" "$(printf '%s\n' "$out" | grep -c 'opcache-remote-index')" 1

echo "3. build-bundle.sh uses that packager for both engines, and deploy.sh's pack rule"
check "approach A applies a_remote_pack_defaults" "$(grep -c 'a_remote_pack_defaults' "$BB")" 1
check "b-dosql applies remote_pack_defaults" "$(grep -c 'remote_pack_defaults' "$BB")" 1
check "both engines call the packager with the asset prefix" "$(grep -c 'bundle-cli.mjs" packs' "$BB")" 1
check "approach A primes with TRACE so the packs follow OPCACHE_A" "$(grep -c 'TRACE=\${OPCACHE_REMOTE:-0}' "$BB")" 1
check "the pack scripts are remote_pack_scripts, not a second copy" "$(grep -c 'remote_pack_scripts' "$BB")" 1
check "bundle-cli stamps assetsIndexSha256" "$(grep -c 'assetsIndexSha256' "$ROOT/deploy/release/bundle-cli.mjs")" 1

echo "$fails failing case(s)"
[ "$fails" = 0 ]
