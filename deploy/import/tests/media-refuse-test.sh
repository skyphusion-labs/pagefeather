#!/bin/bash
# Test of the per-file HEAD and PUT in deploy/import/media.sh (issue #124)
# against fake-s3.py.
#   deploy/import/tests/media-refuse-test.sh [another media.sh]
# Two files (6 bytes each). Cases (fake modes; the summary line; the PUTs):
#   present, HEAD 403 for 2 s      preload both   0 sent, 2 already there   no PUT
#   present, HEAD 403 past budget  preload both   0 sent, 0 there, 2 failed  no PUT, "fail head 403"
#   HEAD 500 always                no preload     2 failed                   no PUT, "fail head 500"
#   absent (404)                   no preload     2 sent                     2 PUTs
#   PUT 403 for 2 s                no preload     2 sent                     2 PUTs
#   PUT 403 past budget            no preload     2 failed                   "fail put 403"
#   present, other size            preload 1:3    1 sent, 1 already there    1 PUT
# R2_RETRY_S 3 (the budget), R2_RETRY_STEP 0.3. Exits 0 only when every case
# gives what it must. Needs bash, curl, python3.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
SH=${1:-$HERE/../media.sh}
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
mkdir -p "$T/src/uploads/2026/01"
printf 'abcdef' > "$T/src/uploads/2026/01/a b.jpg"
printf 'pdfpdf' > "$T/src/uploads/2026/01/doc.pdf"
A="preload=uploads/2026/01/a b.jpg:6"; D="preload=uploads/2026/01/doc.pdf:6"
fails=0
run_case() {
	local name=$1 want_rc=$2 want_sum=$3 want_puts=$4 want_text=$5; shift 5
	local pid rc out puts
	rm -f "$T/port" "$T/log"; : > "$T/log"
	python3 -I "$HERE/fake-s3.py" "$T/port" "$T/log" "$@" & pid=$!
	for _ in $(seq 1 50); do [ -s "$T/port" ] && break; sleep 0.1; done
	out=$(R2_KEY_ID=k R2_SECRET=s R2_RETRY_S=3 R2_RETRY_STEP=0.3 bash "$SH" "http://127.0.0.1:$(cat "$T/port")" bucket "$T/src" 2>&1); rc=$?
	kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
	puts=$(wc -l < "$T/log" | tr -d ' ')
	if [ "$rc" = "$want_rc" ] && printf '%s\n' "$out" | grep -qx "$want_sum" && [ "$puts" = "$want_puts" ] && { [ -z "$want_text" ] || printf '%s' "$out" | grep -q "$want_text"; }; then
		echo "PASS $name: exit $rc, $puts PUT(s)"
	else
		echo "FAIL $name: exit $rc, $puts PUT(s) (want exit $want_rc, \"$want_sum\", $want_puts PUT(s)${want_text:+, \"$want_text\"})"; fails=$((fails + 1))
	fi
	printf '%s\n' "$out" | sed 's/^/   /'
}
run_case "present, HEAD 403 for 2 s (issue #124)" 0 "media: 0 sent, 2 already there, 0 failed" 0 "" head-deny=2 "$A" "$D"
run_case "present, HEAD 403 past the budget" 1 "media: 0 sent, 0 already there, 2 failed" 0 "fail head 403" head-deny=60 "$A" "$D"
run_case "HEAD 500 always" 1 "media: 0 sent, 0 already there, 2 failed" 0 "fail head 500" head-500
run_case "absent (404)" 0 "media: 2 sent, 0 already there, 0 failed" 2 ""
run_case "PUT 403 for 2 s" 0 "media: 2 sent, 0 already there, 0 failed" 2 "" put-deny=2
run_case "PUT 403 past the budget" 1 "media: 0 sent, 0 already there, 2 failed" 0 "fail put 403" put-deny=60
run_case "present, other size" 0 "media: 1 sent, 1 already there, 0 failed" 1 "" "preload=uploads/2026/01/a b.jpg:3" "$D"
echo "$fails failing case(s)"
exit $fails
