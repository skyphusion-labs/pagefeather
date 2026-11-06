# Security policy

## Supported versions

Only the default branch, `main`, receives security fixes. If you are running an
older revision, move to the current `main` to pick a fix up.

## Reporting a vulnerability

Do not open a public GitHub issue, pull request, or discussion for a security
problem.

Report it privately. Open the **Security** tab of this repository and choose
**Report a vulnerability**. That opens a private advisory. Only you and the
maintainers can read it. Private vulnerability reporting is enabled on this
repository.

If you cannot use that form, email **security@skyphusion.org**. Do not put the
details in a public issue, pull request, commit, or chat.

Include:

* what is wrong, and what someone can do with it,
* how to reproduce it, with a minimal example,
* the commit SHA, tag, or release,
* a fix, if you have one.

Say so if the report is time-sensitive. We aim to acknowledge a report within 5
business days. Please allow 90 days for a coordinated fix before you publish
it.

## What to report here

Report a flaw in this repository's own code: the Worker, the PHP drop-ins, the
container image build, the deploy scripts, and the tests. A flaw belongs here
when it can leak a secret, run code a visitor should not run, or break the
isolation between sites.

## What to report somewhere else

* A flaw in WordPress, WooCommerce, PHP, Litestream, or another upstream
  project: report it to that project. Tell us only when our use of it makes the
  flaw worse.
* A flaw in Cloudflare: report it to Cloudflare.
* A site you deployed from this repository, on your own account: that site is
  yours. This policy covers the code, not your account.

Do not test a deployed site you do not operate. The `workers.dev` names in the
docs are measurement records, not a target list.

Do not send code, diffs, or text you do not have the right to share.

## Secrets

Do not commit a token, a password, a salt, or a Terraform state file. The state
for a deploy holds the admin password. Keep it out of git. If a secret reaches
a public commit, say so in the private report. We will revoke it.
