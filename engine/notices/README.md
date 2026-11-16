# engine/notices

The licence texts, NOTICE and SOURCE of the pagefeather engine (#584).
`deploy/release/package-notices.sh` copies them into every release that ships
an engine.

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
```
