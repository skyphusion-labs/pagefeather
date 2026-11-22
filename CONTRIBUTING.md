# Contributing

Thank you for looking. Contributions of every size are welcome: a fixed typo, a clearer sentence, a
plugin you tested, or a deploy on a plan we have not tried. If you are not sure where to start,
open an issue and ask.

This repository (Pagefeather) records which ways of running WordPress on Cloudflare work, and on
which plan. The README matrix is the product, so please read it before you change a cell.

## License

This project is GPL-2.0-or-later. See [LICENSE](LICENSE).

By sending a contribution you agree that it is licensed under GPL-2.0-or-later, the same
license as the project. You also affirm that the contribution is your own work,
or work you have the right to license this way. Please do not paste code or text you
do not have the rights to.

## Sign your work

We use the [Developer Certificate of Origin](https://developercertificate.org/)
(DCO). It is a short statement that you have the right to send your contribution. Sign every
commit:

```bash
git commit -s
```

That adds this line to the commit message:

```
Signed-off-by: Your Name <you@example.com>
```

The name and the email must be real, and they must match the commit author. If a commit is not
signed, we will ask you to sign it (`git commit --amend -s`, or
`git rebase --signoff` for a series) before it can merge.

## Rules for a result a reader can trust

The matrix is only useful if a reader can trust each cell. These rules keep it that way:

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
* Docs a reader reads use Simplified Technical English. "How we write", below, says more.
* No em dash (U+2014) or en dash (U+2013) in source, docs, or commit messages.
  Use a comma, a semicolon, parentheses, or two hyphens (`--`).

## How we write

The repository has two kinds of text, and each has its own voice.

### Public texts

These are the pages a WordPress developer or an agency meets first: `README.md`,
`CONTRIBUTING.md`, `docs/README.md`, `docs/onboarding.md`, `docs/from-lamp-to-wfp.md`,
`docs/known-limitations.md`, `docs/plugins.md`, and any issue or pull request template under
`.github/`. Many readers arrive with no context and decide from these pages whether the project is
for them. When you write one:

* Talk to the reader as "you", and say "we" for the project.
* Give a sentence of why before the how. A reader who knows the reason follows the steps more
  easily.
* Say what is new, unfinished or limited, kindly and honestly. Do not soften a measured limit into
  a promise. If something does not work, say that it does not work, and say what to use instead.
* Welcome contributors, and tell them where to start.
* Keep the English plain: short sentences, common words, one idea in a sentence. Explain a term the
  first time you use it, or link to the page that explains it.
* No hype and no marketing superlatives ("blazing fast", "revolutionary", "the best"). The measured
  numbers make the case.
* Keep every technical fact exact: commands, numbers, versions, dates, issue numbers and links. A
  friendlier sentence that changes a fact is a wrong sentence.

### Texts that stay terse on purpose

Runbooks and operator docs (for example `docs/operator.md` and `docs/releasing.md`), design notes
(`docs/design-*`, `docs/approach-*`), the measurement record (`docs/results.md`,
`docs/admin-memory-matrix.md` and the like), and issues and pull requests between maintainers stay
short and direct. Their readers already have the context and need the facts fast, often while
something is broken. There, lead with the answer and use short imperative sentences.

Both voices use Simplified Technical English vocabulary, no em dash or en dash, and exact facts.

## Commits

Use a [Conventional Commit](https://www.conventionalcommits.org/):

* `fix(scope): ...`
* `feat(scope): ...`
* `docs: ...`
* `ci: ...`

The subject says what changed. The body says why.

## Checks

CI on a pull request runs the checks below. If you run them before you open the pull
request, you find a problem sooner than CI does.

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

Most contributors never need this section. It is here so that a failing scan on your pull request
makes sense, and it is written for maintainers, so it is terse.

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
of the `.patch` file. A result on an upstream php-src line is not ours, but a patch can make an
unchanged upstream line dangerous. So each upstream result must be in
`engine/opcache/codeql-upstream-baseline.json` (rule, file and a hash of the line text). A result
that is not in it fails the `c-cpp` scan, and it is uploaded at the header of the patch for that
file. After a php-src bump, regenerate the baseline with `codeql-sarif-map.py ... --write-baseline`
and review the diff.

Default setup must stay off. While it is on, GitHub refuses each upload from this workflow ("CodeQL
analyses from advanced configurations cannot be processed when the default setup is enabled").
The repo cannot turn it off itself: the org security configuration controls it. Pagefeather is
attached (enforced) to the org configuration 295954 `public-advanced-codeql`. That configuration is
the GitHub recommended configuration 17 with default setup disabled; all other settings are the
same. Attach any other repo that moves to advanced CodeQL to 295954 in the same way (2026-11-15).

## Pull requests

Branch from `main`, and open the pull request against `main`. Please keep each pull request to one
subject; that makes it easier to review. `main` is protected, so every change lands through a pull
request.

## Changing the base branch

A retarget through the API does not trigger checks. GitHub does not send `pull_request` `opened`
or `synchronize` when you change `base` with `PATCH /repos/{owner}/{repo}/pulls/{pull_number}`.
CI, CodeQL and approval-at-head do not run on that head.

Close the pull request and reopen it, or push a commit. That starts the checks.

## Conduct and security

Be decent to each other. Read [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

If you find a security vulnerability, please do not open a public issue. Read
[SECURITY.md](SECURITY.md) for how to report it privately.
