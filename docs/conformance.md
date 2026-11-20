# Conformance runs: WordPress's and WooCommerce's own test suites (#759)

The support matrix (#759) comes from running the projects' own test suites against a site on each tier. Those suites
need content that no real site may carry, so a deploy that carries it is for a throwaway only.

## The content and the gate (#764)

`tests/conformance/prepare-content.sh` (#763) builds the content and prints the build line. It is the one source:
WooCommerce Cleanup (`GET wc-cleanup/v1/reset` deletes every order, product, coupon, term and media file and truncates
tables), the WooCommerce e2e test helper (sets and deletes options over REST), Gutenberg's test plugins and themes,
and the throwaway marker mu-plugin `pf-conformance-throwaway.php`. Both upstream suites also delete all posts.

`deploy/conformance.sh` keys on that **content**, never on a flag, so it cannot reach a site by a path that skips the
check. The content is present when any of these holds:

- `IMPORT_MU_PLUGINS` names `pf-conformance-throwaway.php`;
- `IMPORT_PLUGINS` names `woocommerce-cleanup`, `woocommerce-e2e-test-helper` or `gutenberg-test-plugins`;
- `SUITE` or `THEME_SUITE` points into `tests/conformance/` (the conformance-only pins);
- `IMPORT_CONTENT` is a `wp-content` that holds `mu-plugins/pf-conformance-throwaway.php`, whatever `IMPORT_*` says.

With the content, a deploy needs `CONFORMANCE=on` (the run states that it carries this content: a deploy-time
statement only, never rendered or recorded), `THROWAWAY=1`, and a named site that is not live (neither `deploy/live-sites/<name>.env`
nor `deploy/wfp/live-sites/<name>`; ggc and ggc-test are refused). It is checked, before any step, at the entry of
`deploy/deploy.sh` and of every Workers for Platforms command (`site add`, `site update`, each site of `update --all`,
`site.sh up`, `up.sh`). A `site update` checks again on the site's **recorded** build inputs, which can carry the
content, and `render_user` checks as the last guard.

## A run

1. **Build and deploy:** the throwaway with `prepare-content.sh`'s line, `CONFORMANCE=on THROWAWAY=1`, and these settings:
   - `TURNSTILE_LOGIN` must be `off`. The suite login post has no token.
   - `TURNSTILE_LOSTPASSWORD` must be `off`. The suite lost-password posts cannot complete the challenge.
   - `TURNSTILE_SITEKEY` must be `1x00000000000000000000AA`. That is the always-pass test site key.
   - `TURNSTILE_SECRET` must be `1x0000000000000000000000000000000AA`. That is the always-pass test secret.
   - Do not set `TURNSTILE_WOO` or `TURNSTILE_COMMENTS` to `off`. Those gates stay on.
   - The deploy refuses any other site key or secret. A real site key stops classic checkout (#940).
   - `WOO_EXTRAS` must NOT be `off`: it forces `woocommerce_allow_tracking` off, which the WooCommerce suite needs on.
2. **Seed** (it also activates the two WooCommerce test plugins the line copied in; Gutenberg's stay inactive): `B=<site> ADMIN_PASSWORD=<the workspace's> python3 -I tests/conformance/seed.py <out>` (#775). It owns all
   setup and checks each item. `<out>/creds.env` (mode 600, `export` lines) holds the admin's account password, which
   is an application password (one value passes both the login form and Basic, #762), and the customer's.
3. **Run:** `. <out>/creds.env`, then `runner.py prepare` (it checks the seed and never writes), then the suite
   (`tests/conformance/vps-run.sh`). Each run asserts that the auth setup really logged in (`runner.py check-state`).
4. **The REST routes:** `tests/conformance/routes.py` (#779) over the site's own index, with `WP_PASSWORD`.
5. **Reseed** between the API half and the browser half: `seed.py <out>` again, with `ADMIN_PASSWORD` unset.

## Upstream notes for the matrix

- **WooCommerce Cleanup's reset prints a database error on every database:** it runs
  `DELETE FROM wp_woocommerce_tax_classes`, a table WooCommerce has not created since 3.7 (`wc_tax_rate_classes`). The
  reset goes on and answers 200, and its `TRUNCATE TABLE` works on our SQLite (measured locally, 2026-11-16).
- **Upstream's `image-01.png` is a JPEG,** so WordPress stores it as `image-01.jpg`, on stock too. Match it by stem.
