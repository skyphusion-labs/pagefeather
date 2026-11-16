# engine/notices

The licence texts, NOTICE and SOURCE of the pagefeather engine (#584).
`deploy/release/package-notices.sh` copies them into every release that ships
an engine.

`NOTICE` and `SOURCE` here describe the npm Playground engine (the binary
pinned in `engine/UPSTREAM`, then `spikes/b2-wordpress/prepare.sh`). A product
release (`vX.Y.Z`, the b-dosql bundle and the approach-A bundle) ships that
engine. `package-notices.sh` with no engine argument copies these files.

`lean/NOTICE` and `lean/SOURCE` describe the custom build, variant s1-lean.
The lean prerelease calls `package-notices.sh <release-dir> "" lean`. That
SOURCE names `engine/` at the release tag, the pins and licence texts in
`engine/licenses.tsv`, and `.github/workflows/pagefeather-engine.yml`. Both
engines share this `LICENSES/` directory.

Do not edit the files under `LICENSES/`. They are the upstream texts at the
versions pinned in `engine/licenses.tsv`, fetched by `engine/tools/licenses.py`.
A row whose body sha256 does not match the pin fails
`deploy/release/tests/release-notices-test.sh`.

To regenerate after a pin change:

```sh
out=$(mktemp -d)
python3 -I engine/tools/licenses.py --all "$out"
rm -rf engine/notices/LICENSES
cp -R "$out/LICENSES" engine/notices/LICENSES
cp "$out/NOTICE" "$out/SOURCE" engine/notices/
cp "$out/NOTICE" NOTICE
python3 -I engine/tools/licenses.py --all engine/notices/lean --engine lean --notices-only
```

The lean command does not fetch. It rewrites `lean/NOTICE` and `lean/SOURCE`
from `engine/licenses.tsv` and `engine/UPSTREAM`. Lean SOURCE says the shipped
wasm sha256 differs from the pinned Playground wasm sha256. `package-notices.sh`
refuses the lean release when the wasm bytes disagree with that sentence.
