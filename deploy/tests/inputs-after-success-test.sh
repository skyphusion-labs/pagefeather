#!/bin/bash
# #1428: deploy.sh must not record a run's inputs until the upload has succeeded.
# A data-plane apply that writes deploy_inputs first leaves that record behind when the
# build later fails at fetch (an unpinned plugin). The next deploy then refuses the
# site's real inputs. This runs deploy.sh with the slow steps stubbed (terraform, npm,
# the WordPress assemble) and the real tests/plugins/fetch.sh, so the refusal is the
# same "not pinned" line. No Cloudflare, no network.
#   deploy/tests/inputs-after-success-test.sh
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../.." && pwd)
T=$(mktemp -d "${TMPDIR:-/tmp}/inputs-after-success.XXXXXX")
NAME=pf1428-record
SITES="$ROOT/deploy/terraform/sites"
clean_sites() {
  rm -f "$SITES/$NAME.tfvars" "$SITES/$NAME.apply.log" "$SITES/$NAME.media-guard.log" "$SITES/$NAME.media-guard.plan" "$SITES/$NAME.inputs-apply.log"
}
clean_sites
trap 'clean_sites; rm -rf "${T:?}"' EXIT
fails=0
ok() { if [ "$2" = 1 ]; then echo "  ok   $1"; else echo "  FAIL $1"; fails=$((fails + 1)); fi; }

mkdir -p "$T/bin" "$T/app" "$T/fetch-dest/plugins" "$T/cache"
# terraform: `output -raw deploy_inputs` is $T/rec. `apply` copies the var file's
# deploy_inputs into that record, which is what a real apply writes into state.
cat > "$T/bin/terraform" <<STUB
#!/bin/sh
echo "\$*" >> "$T/tf.log"
cmd=\$1
shift
case "\$cmd" in
  init) exit 0 ;;
  workspace)
    sub=\$1
    case "\$sub" in
      list) printf '%s\n' '* default' '  $NAME'; exit 0 ;;
      select) exit 0 ;;
    esac
    exit 1 ;;
  output)
    name=
    for a in "\$@"; do
      case "\$a" in -no-color|-raw) ;; *) name=\$a ;; esac
    done
    if [ "\$name" = deploy_inputs ]; then
      if [ -f "$T/rec" ]; then cat "$T/rec"; exit 0; fi
      echo 'Error: Output "deploy_inputs" not found' >&2
      exit 1
    fi
    exit 0 ;;
  state) exit 0 ;;
  plan)
    for a in "\$@"; do
      case "\$a" in -out=*) printf '%s\n' '{"resource_changes":[]}' > "\${a#-out=}" ;; esac
    done
    exit 0 ;;
  show)
    file=
    for a in "\$@"; do file=\$a; done
    cat "\$file"
    exit 0 ;;
  apply)
    file=
    for a in "\$@"; do
      case "\$a" in -var-file=*) file=\${a#-var-file=} ;; esac
    done
    val=\$(sed -n 's/^deploy_inputs  = "\\(.*\\)"\$/\\1/p' "\$file")
    printf '%s' "\$val" > "$T/rec"
    exit 0 ;;
esac
exit 0
STUB
chmod +x "$T/bin/terraform"
# npm ci is the only npm call before fetch. It must not install anything.
printf '#!/bin/sh\nexit 0\n' > "$T/bin/npm"
# Anything else here is a step the test did not mean to run.
for c in node npx curl docker; do
  printf '#!/bin/sh\necho "STUB %s called: the deploy went past the stubbed steps" >&2\nexit 97\n' "$c" > "$T/bin/$c"
  chmod +x "$T/bin/$c"
done
chmod +x "$T/bin/npm"
# prepare.sh succeeds. build.sh is the real fetch, and nothing else: the WordPress
# download, unzip and opcache are the slow steps.
printf '#!/bin/sh\nexit 0\n' > "$T/app/prepare.sh"
cat > "$T/app/build.sh" <<'EOF'
#!/bin/sh
set -eu
dest=${PF_FETCH_DEST:?}
fetch=${PF_FETCH:?}
if [ -n "${PLUGINS:-}" ]; then
  "$fetch" "$dest/plugins" $PLUGINS
fi
if [ -n "${THEMES:-}" ]; then
  "$fetch" --themes "$dest/themes" $THEMES
fi
exit 0
EOF
chmod +x "$T/app/prepare.sh" "$T/app/build.sh"
# cd "$APP" in deploy.sh lands in the stub tree. Every other cd is unchanged.
cat > "$T/bash-env.sh" <<EOF
cd() {
  if [ "\${1:-}" = "$ROOT/spikes/b2-wordpress" ]; then
    builtin cd "$T/app"
  else
    builtin cd "\$@"
  fi
}
EOF

# shellcheck source=../lib/recorded-inputs.sh
. "$ROOT/deploy/lib/recorded-inputs.sh"
# The record the site already has: the same base settings, without the plugin this run adds.
old=$(env -i PATH="$PATH" VARIANT=b-do LOCATION=enam MEDIA=0 WOO_ACTIVE=0 bash -c '. "'"$ROOT"'/deploy/lib/recorded-inputs.sh"; deploy_inputs_value')
printf '%s' "$old" > "$T/rec"
cp "$T/rec" "$T/before"
: > "$T/tf.log"

set +e
env -i PATH="$T/bin:$PATH" HOME="${HOME:-/tmp}" TMPDIR="${TMPDIR:-/tmp}" \
  BASH_ENV="$T/bash-env.sh" \
  PF_FETCH="$ROOT/tests/plugins/fetch.sh" PF_FETCH_DEST="$T/fetch-dest" FETCH_CACHE="$T/cache" \
  PHP_ENGINE=npm NAME="$NAME" ACCOUNT_ID=0123456789abcdef0123456789abcdef CLOUDFLARE_API_TOKEN=fake \
  VARIANT=b-do LOCATION=enam MEDIA=0 WOO_ACTIVE=0 \
  PLUGINS=pf1428-not-pinned REPLACE_INPUTS=1 \
  bash "$ROOT/deploy/deploy.sh" > "$T/out" 2>&1
rc=$?
set -e

ok "the deploy fails at fetch (rc $rc)" "$([ "$rc" != 0 ] && grep -q 'fetch: not pinned' "$T/out" && grep -q 'pf1428-not-pinned' "$T/out" && echo 1 || echo 0)"
ok "REPLACE_INPUTS=1 was accepted before that failure" "$(grep -q 'REPLACE_INPUTS=1: the recorded inputs are replaced' "$T/out" && grep -q 'PLUGINS:' "$T/out" && echo 1 || echo 0)"
ok "the inputs check is before the fetch failure" "$(awk 'index($0, "REPLACE_INPUTS=1: the recorded inputs are replaced") {r=NR} index($0, "fetch: not pinned") {f=NR} END {print (r && f && r < f) ? 1 : 0}' "$T/out")"
applies=$(grep -c '^apply ' "$T/tf.log" || true)
ok "terraform apply ran once (the data plane) and the upload did not" "$([ "$applies" = 1 ] && ! grep -q '^== deploy$' "$T/out" && echo 1 || echo 0)"
if cmp -s "$T/before" "$T/rec"; then same=1; else
  same=0
  echo "  record before: $(cat "$T/before")"
  echo "  record after:  $(cat "$T/rec")"
fi
ok "a fetch failure leaves the recorded inputs byte for byte unchanged" "$same"

[ "$fails" = 0 ] && echo "inputs-after-success: all checks pass" || echo "inputs-after-success: $fails failing check(s)"
exit $((fails > 0))
