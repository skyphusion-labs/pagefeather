# Contributing

This repository (Pagefeather) records which ways of running WordPress on
Cloudflare work, and on which plan. The README matrix is the product. Read it
before you change a cell.

## License

This project is GPL-2.0-or-later. See [LICENSE](LICENSE).

By sending a contribution you agree that it is licensed under GPL-2.0-or-later, the same
license as the project. You also affirm that the contribution is your own work,
or work you have the right to license this way. Do not paste code or text you
do not have the rights to.

## Sign your work

We use the [Developer Certificate of Origin](https://developercertificate.org/)
(DCO). Sign every commit:

```bash
git commit -s
```

That adds this line to the commit message:

```
Signed-off-by: Your Name <you@example.com>
```

The name and the email must be real, and they must match the commit author. An
unsigned commit will be sent back for a signature (`git commit --amend -s`, or
`git rebase --signoff` for a series) before it can merge.

## Rules for a result a reader can trust

* A cell is **measured** only after a real deploy on that plan and a test in
  `tests/`. Record the command, the date, the Wrangler version, and the result
  in `docs/results.md`.
* Documentation, or a third-party claim, is not a measurement.
* A failed deploy is a result. Record it. Do not delete a cell because it
  failed.
* Credit prior art in `docs/prior-art.md` before you build the same thing.
* Every plan limit you write down names its Cloudflare documentation page and
  the date you read it.
* Deploys from this repository go to a `workers.dev` address. Do not route a
  zone.
* Docs a reader reads use Simplified Technical English.
* No em dash (U+2014) or en dash (U+2013) in source, docs, or commit messages.
  Use a comma, a semicolon, parentheses, or two hyphens (`--`).

## Commits

Use a [Conventional Commit](https://www.conventionalcommits.org/):

* `fix(scope): ...`
* `feat(scope): ...`
* `docs: ...`
* `ci: ...`

The subject says what changed. The body says why.

## Checks

CI on a pull request runs the checks below. Run them before you open the pull
request.

```bash
php -l spikes/b2-wordpress/php/*.php
php -l spikes/b2-wordpress/tests/*.php
php spikes/b2-wordpress/tests/dialect-test.php
for f in $(git ls-files '*.sh'); do bash -n "$f"; done
```

The Worker files are ES modules, and `package.json` says `commonjs`, so check
them as `.mjs`:

```bash
cp spikes/b2-wordpress/index.js /tmp/woc-index.mjs && node --check /tmp/woc-index.mjs
cp spikes/b1-boot/index.js /tmp/woc-b1.mjs && node --check /tmp/woc-b1.mjs
```

CI does not deploy, and it does not run `e2e.sh`. If your change affects a
measured cell, run that approach's test and record the result.

## Code scanning

CodeQL runs from `.github/workflows/codeql.yml` (advanced setup, issue #608), not from default
setup. It scans `actions`, `javascript-typescript`, `python` and `c-cpp` on every pull request and
on each push to `main`. The `code_scanning` rule of the org ruleset needs a result for each of
them on every pull request.

The `c-cpp` scan builds php-src 8.3.36 `ext/opcache` natively, with the engine patches applied
(`engine/opcache/codeql-build.sh`). The emscripten engine build is too heavy for each pull request.
If a patch in `engine/opcache/` does not apply, the `c-cpp` scan fails. A step after the analysis
checks that the database holds the patched `zend_persist.c`.

GitHub drops a result whose file is not in the repository, and the patched php-src files are not.
So `engine/opcache/codeql-sarif-map.py` moves each result on a line that a patch added to that line
of the `.patch` file. A result on an upstream php-src line is not ours: the job log lists it, and it
is not uploaded.

Default setup must stay off. While it is on, GitHub refuses each upload from this workflow ("CodeQL
analyses from advanced configurations cannot be processed when the default setup is enabled").
The repo cannot turn it off itself: the org security configuration controls it. Pagefeather is
attached (enforced) to the org configuration 295954 `public-advanced-codeql`. That configuration is
the GitHub recommended configuration 17 with default setup disabled; all other settings are the
same. Attach any other repo that moves to advanced CodeQL to 295954 in the same way (2026-11-15).

## Pull requests

Branch from `main`. Open the pull request against `main`. Keep it to one
subject. `main` is protected: a change lands through a pull request.

## Conduct and security

Be decent to each other. Read [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

Do not open a public issue for a security vulnerability. Read
[SECURITY.md](SECURITY.md).
