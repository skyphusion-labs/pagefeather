# Design: the one-click path (issue #401)

**Status: design only. Nothing here is built.** Written 2026-11-13 by Joan for the lead's ruling. The gate is design-then-stop.

The goal, in Conrad's words (2026-11-13): Pagefeather "has to look and basically feel like wordpress, it can't be like emdash", and it needs "a gui path, you know, the whole one click thing". The reader is a WordPress developer with no edge experience. Everything that person touches after the button is ordinary WordPress.

Every claim about Cloudflare names the page and the date it was read. Each page also shows its own "Last updated" date, in the table at the end. A claim with no page is **unmeasured**. Nothing in this design was tried on a real account.

## 0. The short answer

- The button can make the admin and its storage: one Worker, an R2 bucket, KV, a Durable Object. It cannot buy Workers for Platforms, cannot make an API token, and cannot turn on Zero Trust (the home of Access). Each of those is one guided step, in section 1.3.
- The admin cannot get its API token without a paste. Cloudflare's own Workers for Platforms starter does the same: it asks for the token on the deploy page. We use a pre-filled token link, so the user clicks a link, clicks **Create Token**, and pastes the value once.
- The biggest gap is not the button. **A plugin or theme installed from wp-admin does not persist on a Pagefeather site today** (`docs/plugins.md`, "Plugins must be in the build"). A WordPress developer will notice that in the first hour. Section 2.6 states it and parks the fix.
- First cut for import: the standard WordPress importer (Tools > Import > WordPress, a WXR file), run inside the new site's own wp-admin. It is ordinary WordPress, and it brings content and media. It does not bring plugins, the theme, settings or passwords.

## 1. Part 1: set up once per account

### 1.1 What the button does today

Source: [Deploy to Cloudflare buttons](https://developers.cloudflare.com/workers/platform/deploy-buttons/), read 2026-11-13.

The button link is `https://deploy.workers.cloudflare.com/?url=<public GitHub or GitLab repo URL>`, optionally with a subdirectory. When the user clicks it, Cloudflare:

1. **Clones the repository into the user's own GitHub or GitLab account.** So the user needs a GitHub or GitLab account. This is a gap for some WordPress developers (section 1.3, step G).
2. **Shows one setup page** where the user can change the repository name, the Worker name and the resource names.
3. **Builds and deploys with Workers Builds**, and makes the resources the Wrangler file asks for.

Resources the button page lists as made automatically: KV, D1, R2, Hyperdrive, Vectorize, Secrets Store secrets, Durable Objects, Workers AI, Queues. **A dispatch namespace is not in that list.**

A second page disagrees. [Wrangler configuration, Automatic provisioning](https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning), read 2026-11-13, says `wrangler deploy` can make "KV, R2, D1, Flagship, AI Search, Agent Memory, Dispatch Namespaces and Queues". The button runs `npx wrangler deploy` by default ([Workers Builds configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/), read 2026-11-13). So the namespace **may** be made by the button through Wrangler. **Unmeasured.** Cloudflare's own Workers for Platforms starter does not rely on it: its deploy script makes the namespace through the API before `wrangler deploy` (see 1.5).

Secrets: the button reads secret names from `.dev.vars.example` (or `.env.example`). A `package.json` `cloudflare.bindings.<NAME>.description` field adds help text, with links and inline code. The button page says secrets "can be defined" there. That the setup page then shows a field for each one is from Cloudflare's starter README ("you'll be prompted for ... `CLOUDFLARE_API_TOKEN`"), not from the button page. **Unmeasured by us.**

Limits from the same page:

- A subdirectory works, but the app "must be fully isolated within that subdirectory, including any dependencies". Cloudflare treats the subdirectory as the root of the new repository.
- Workers only (not Pages). github.com or gitlab.com only. The repository must be public (Pagefeather is).

Workers Builds limits ([Limits & pricing](https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/), read 2026-11-13): 20 minute build timeout, 8 GB memory, 20 GB disk, 3,000 build minutes a month on Free.

The build token ([Workers Builds configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/#api-token), read 2026-11-13): Workers Builds makes a **user** token with Account Settings read, Workers Scripts edit, Workers KV edit, Workers R2 edit, Workers Routes edit on all zones, and User Details and Memberships read. "Only user tokens are supported" there today. We do **not** reuse this token at run time (section 2.3).

### 1.2 Which of our pieces the button can make

| Piece | Today (`deploy/provision`, `deploy/wfp`) | Can the button make it? |
| --- | --- | --- |
| The admin (the provisioning Worker plus the admin screens) | `wp-provision`, a Worker | **Yes.** It is the Worker the button deploys. |
| The bundle bucket (`BUNDLES`) | R2 `wp-provision-bundles` | **Yes** (R2 is in the list). |
| The site map (`WFP_KV_ID`) | KV `wp-wfp-sites` | **Yes** (KV is in the list). |
| A rate limiter, a gate object | Rate Limiting binding, `DemoGate` Durable Object | Durable Objects: **yes**. The Rate Limiting binding is not in the list: **unmeasured**. The admin does not need either (one owner, behind Access). |
| The dispatch namespace | `wp-wfp` | **Not on the button page.** Maybe through Wrangler (unmeasured). Safe path: the build makes it through the API, as Cloudflare's starter does. Needs Workers for Platforms bought first. |
| The outbound Worker | `deploy/wfp/outbound` | **No.** One button deploys one Worker; a second Worker needs its own button ("Monorepos" limit). The admin can upload it through the API on first run. |
| The WordPress bundle (46 MB of modules, built by `spikes/b2-wordpress/build.sh`) | Built by the bake lane, put in R2 | **No, not from source.** The button build does not run our PHP build, and the bundle is not in git. See 1.4. |
| Workers for Platforms subscription | Bought in the dashboard | **No.** Guided step A. |
| An API token for the admin | `WP_PROVISION_TOKEN`, a Worker secret | **No.** Guided step C. |
| Zero Trust and the Access rule | None today | **No** for Zero Trust (it asks for payment details, even on the free plan). The Access rule itself can be made by the admin through the API. Guided step B. |
| A domain for each site | A SaaS zone (`skyphusionwp.dev`) today | **No**, and not needed for the first cut: sites use `workers.dev` (section 2.4). |

### 1.3 The guided steps, with the exact wording on screen

The README holds the button and a short list above it. The list is the "before you click" step, because the deploy fails if Workers for Platforms is not on (the namespace binding needs it). The admin's first screen checks every item live and shows the same wording until each one is done.

The steps, in order. The wording in quotes is the exact text on screen (README and admin). It is Simplified Technical English. It names no edge concept that the user does not have to act on.

**A. Turn on Workers for Platforms.** Source: [Workers for Platforms pricing](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/pricing/), read 2026-11-13: "The Workers for Platforms Paid plan is $25 monthly", bought at `https://dash.cloudflare.com/?to=/:account/workers-for-platforms`.

> **Step 1 of 3: Turn on Workers for Platforms.** Your sites run on this Cloudflare plan. It costs $25 a month, billed by Cloudflare to your own account. [Open this page in Cloudflare] and select **Purchase**. Then come back here.

The button label in the dashboard ("Purchase") is **unmeasured**. Whether Workers Paid ($5) must be bought first is **unmeasured**.

**B. Turn on Zero Trust (free).** Source: [Zero Trust get started](https://developers.cloudflare.com/cloudflare-one/setup/), read 2026-11-13: choose a team name, then "selecting a subscription plan and entering your payment details. If you chose the Zero Trust Free plan, this step is still needed but you will not be charged." [Cloudflare Access for Workers](https://developers.cloudflare.com/workers/configuration/cloudflare-access/), read 2026-11-13: "Zero Trust enabled on your account" is a prerequisite.

> **Step 2 of 3: Turn on sign-in protection.** Only you can open your site manager. Cloudflare checks your email before it lets anyone in. [Open Zero Trust in Cloudflare]. Type a team name (your business name is fine). Choose the **Free** plan. Cloudflare asks for a card, but the Free plan costs nothing.

**C. Make one API token, and paste it once.** Source: [API token template URLs](https://developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template/), read 2026-11-13: a URL pre-fills the token form; "Users must still complete the token creation process in the dashboard". Account token URLs take permission group ids; user token URLs take short keys only and drop an unknown key "silently". We use the **account** token URL, so the token belongs to the account and not to one person ([Account API tokens](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/), read 2026-11-13; Workers, R2, KV, Queues and Access are marked compatible there).

> **Step 3 of 3: Let the site manager make sites for you.** [Create the key in Cloudflare]. The page is filled in for you. Select **Continue to summary**, then **Create Token**. Copy the key that Cloudflare shows, and paste it below. Cloudflare shows it only once.
>
> Key: [__________]

Where the paste goes: into the button's own setup page, as the secret `PAGEFEATHER_KEY` (defined in `.dev.vars.example`, with the help text above in `package.json`). If the field is not shown there (unmeasured, section 1.1), the admin's first screen asks for it instead and stores it as its own Worker secret through the API.

The permissions the link asks for, from the operations `provisionSite` calls (`deploy/provision/ops.mjs`): Workers Scripts edit, Workers KV Storage edit, Workers R2 Storage edit, Workers for Platforms edit, Account Settings read, Access: Apps and Policies edit (only for the one-time Access rule in 2.3). The exact permission group ids are **unmeasured**: the measurement run reads them from `GET /accounts/{id}/tokens/permission_groups` and fixes the link. No zone permission: the first cut makes no DNS record. No API Tokens edit: the admin never makes a token (this keeps clear of #273).

**D. The account id.** The starter asks the user to type it. We do not: an account token reaches one account, so the admin reads it from `GET /accounts` with the pasted key. **Unmeasured.**

**E. The `workers.dev` subdomain.** A new account may not have one yet. [workers.dev](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/), read 2026-11-13, says how to change it, not whether a new account starts with one. The admin is itself on `workers.dev`, so the deploy either sets it or fails. **Unmeasured**; the measurement run records it.

**F. Email (not blocking).** A site sends mail through a `send_email` binding with `wordpress@<domain>` as the sender (`deploy/provision/wp-site-config.mjs`). A `workers.dev`-only account has no mail domain. So password reset and WooCommerce order mail likely do not leave on the first cut. **Unmeasured.** The admin says so on the site screen ("Email from this site is off until you connect a domain"), and the fix is parked with the domain step.

**G. A GitHub or GitLab account.** The button needs one (1.1). No workaround: it is how the button works.

So the honest count before the first site: **the button, three guided steps (A, B, C), one paste.** Steps A and B are once per Cloudflare account, ever.

### 1.4 How the WordPress bundle reaches the user's account

The admin needs the vetted WordPress bundle in its own `BUNDLES` bucket, as `wp-provision` does today (`deploy/provision/HARDENING.md`, decision 1). The button cannot build it. Two ways:

1. **(Recommended) A release asset.** CI builds the b-dosql bundle on a GitHub-hosted runner and attaches it to a GitHub Release, with its SHA-256. The deployed admin carries the expected SHA-256 in its own code. On first run it downloads the asset, checks the hash, and writes it to `BUNDLES`. A wrong hash is a refusal, never a write.
2. The build step downloads it with `wrangler r2 object put`. This runs inside the 20 minute build with the build token. It hides a failure in a build log the user never reads, so it is the second choice.

There is no release today (`gh release list` on 2026-11-13 printed nothing). This is a dependency: a CI job that builds and publishes the bundle. That job is not in this design.

Updates ("Dashboard > Updates", the WordPress way) need the admin to trust a newer bundle than the hash it was deployed with. A signed manifest (an Ed25519 key pinned in the admin, verified with Web Crypto) is the likely shape. **Parked**: it is a supply-chain design of its own.

### 1.5 Prior art: Cloudflare's Workers for Platforms starter

[cloudflare/templates `worker-publisher-template`](https://github.com/cloudflare/templates/tree/main/worker-publisher-template), read 2026-11-13 at commit `47645c9` (last change 2026-09-22), linked from [Workers for Platforms, Get started](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/get-started/) as "a complete Workers for Platforms setup with one click". It is the same shape as our Part 1:

- a Deploy to Cloudflare button;
- `.dev.vars.example` holds `CLOUDFLARE_API_TOKEN=`, so the deploy page asks the user to paste a token ("with Workers:Edit permission");
- the `deploy` script runs `scripts/deploy-wfp.ts` first, which gets or makes the dispatch namespace through the API, then `wrangler deploy`.

So Cloudflare's own answer to "how does the platform Worker get its token" is also "the user pastes one". We do the same, with a pre-filled link. This entry goes into `docs/prior-art.md` with this design, before we build the same thing (repo rule).

## 2. Part 2: add a site

### 2.1 The screens

The admin looks like wp-admin: the dark left menu, the admin bar, the grey page, the blue primary button, the `form-table` layout, the list table. It does **not** look like the Cloudflare dashboard. A static mockup is in [design-401/admin-mockup.html](design-401/admin-mockup.html) (vanilla HTML and CSS, no build, no script). The styles are written for this mockup to match the wp-admin look; no WordPress file is copied.

The menu: **Sites**, **Add New Site**, **Import**, **Site Health**. No word on any screen names a Worker, a namespace, a bucket, a Durable Object or a dispatcher.

| Screen | Looks like (wp-admin) | What it shows | What a click calls |
| --- | --- | --- | --- |
| **Site Health** (first screen until all is green) | Tools > Site Health | Each step of 1.3 as a check: "Workers for Platforms is on", "Sign-in protection is on", "The key works", "WordPress files are ready" (1.4). A failed check shows its wording from 1.3 and one button. | Read-only API checks with the pasted key. "Get WordPress files" runs the download of 1.4. |
| **Sites** | Posts > All Posts (a list table) | Each site: name, address, "Store" if WooCommerce is on, created date, row actions **Log in**, **Visit**, **Import content**. | Reads the site map (KV, `registry.mjs`). |
| **Add New Site** | Users > Add New and the WordPress install screen | Site name; Site address (read only, shown as you type: `wp-<name>.<you>.workers.dev`); Your username; Your password (with the WordPress strength meter); Your email; "This site is a store (WooCommerce)" checkbox; "Discourage search engines" checkbox; **Add New Site**. | `POST /api/sites` on the admin, which calls `provisionSite` (below). |
| **Creating your site** | The WordPress update screen ("Updating... Please wait") | One line per step, as WordPress shows during an update: "Making storage", "Copying WordPress", "Installing WordPress", "Turning on WooCommerce". | Polls the admin for the step log that `provisionSite` returns. |
| **Success!** | The WordPress install success screen | "WordPress has been installed. Thank you, and enjoy!" Username shown; password shown as typed (dots, with Show). **Log In**. | Links to `https://<site>/wp-login.php`. |

The domain field from the issue is on the Add New Site screen as a later step ("Use your own domain: coming later"), not in the first cut. See 2.4.

### 2.2 What each click calls in `deploy/provision/`

**Add New Site** sends `{ name, store, username, password, email, private }` to the admin. The admin builds the rest from its own trusted config, as `server-config.mjs` does today. The caller still configures nothing: no bindings, no code, no zone.

1. `validateRequest` (extended): `name` against `SITE_NAME_RE` and `isCallerReservedName`; the new fields against their own rules (email form, password length of at least 12, as `installWordPress` already requires).
2. `deriveTarget` (extended): a new kind of base, `workers.dev`, beside the SaaS-zone base. The hostname is `wp-<name>.<subdomain>.workers.dev`, as `cli.mjs` already defaults to.
3. `buildServerCfg`: unchanged in shape: `bDosqlBindings`, `bDosqlSecrets`, `bDosqlResourceCreateOps`, the bundle from `BUNDLES`.
4. `provisionSite` (`provision.mjs`): unchanged steps: the media bucket, the descriptor resources, `deployNamespaceScript`, `upsertSite` (the site map), then the install.
5. **New:** the site's front door on `workers.dev`. See 2.4. This adds one operation (upload the small dispatcher Worker as `wp-<name>` and turn on its `workers.dev` route; `enableWorkersDevSubdomain` already exists in `ops.mjs`, dormant).
6. `installWordPress` (extended): today it sends only `x-admin-password` and the site makes the user `admin` with the title "WordPress on D1" (`spikes/b2-wordpress/index.js`, `wp_install( 'WordPress on D1', 'admin', ...)`). The form needs the site title, the username, the email and the search-engine choice to reach `wp_install`. That is a change to the site's `/_install` endpoint.
7. **Store on:** after the install, the admin calls the site's existing `/_activate` to turn on WooCommerce. Today `provision.mjs` leaves this to the owner ("WooCommerce is NOT installed here"). **Unmeasured** on this path.

Approach A (`kind: a`, MySQL through Hyperdrive) is not in the first cut. It needs a database the user chooses and pays for outside Cloudflare (`docs/onboarding.md`), which is not one click.

### 2.3 Auth

**Who can open the admin: Cloudflare Access, in front of the admin Worker only.** Source: [Cloudflare Access for Workers](https://developers.cloudflare.com/workers/configuration/cloudflare-access/), read 2026-11-13: "Protect one Worker" covers its `workers.dev` hostname and previews, and the Access rule can be made with `POST /accounts/{id}/access/apps` with a destination of type `worker`.

- The button's setup page asks for **one more value: `ADMIN_EMAIL`**, the owner's email.
- On first run the admin makes its own Access rule through the API (destination: this Worker; allow: `ADMIN_EMAIL`; login: the one-time PIN by email, which needs no identity provider set up). After that the user does nothing more for sign-in.
- **The admin fails closed.** Until it sees a verified Access identity on the request, it serves only the Site Health screen in read-only form, and the one-time "protect me" step. It provisions nothing and shows no site. So the window between deploy and the Access rule exposes nothing.
- How it checks: `ctx.access` gives the identity "with no extra configuration or JWT parsing" (same page). Two limits from that page shape the build: `ctx.access` is not passed when the Worker uses **static assets** (an internal router runs first), so the admin serves its screens from the Worker code, not from static assets; and for non-browser clients only `aud` is filled, so the admin also validates the `Cf-Access-Jwt-Assertion` header against the team's keys and the rule's `aud`, and rejects a mismatch.
- The site's own wp-admin is **not** behind Access. It is ordinary WordPress login. Access is only on the site manager.

**How the admin gets its API token: the user pastes it once (step C).** I found no documented way for a Worker to get a Cloudflare API token without a person making it in the dashboard:

- The button's own build token is a user token made for Workers Builds. It is not given to the Worker at run time, it is tied to one person, and it has no Workers for Platforms or Access scope. **Rejected.**
- No binding can upload a namespace script, make a bucket or write an Access rule. The dispatch namespace binding only runs scripts (`get()`). So a binding cannot replace the token.
- A template URL removes the choosing of permissions, not the copy and paste.

The pasted key lives only as a Worker secret on the admin. It is never shown again, never logged, and never sent to a site.

### 2.4 Site addresses (and why `workers.dev`)

Repo rule: deploys go to `workers.dev` unless a CR issue routes a zone. The user's own account is not ours, but our measurement runs are, so the first cut is `workers.dev` only.

`workers.dev` gives one hostname per Worker: `<worker>.<subdomain>.workers.dev` ([workers.dev](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/), read 2026-11-13). One dispatcher cannot answer for many sites there. So each site gets its own small dispatcher Worker, `wp-<name>`, with the same code (`deploy/wfp/dispatcher/worker.js`, which already keys the site map by its own hostname). This is "phase A" of `deploy/wfp`, proven there (`docs/operator.md`).

Costs and limits of that choice:

- Two scripts per site: one plain Worker and one namespace script. The account limit is 500 Workers on Workers Paid ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/), read 2026-11-13). Whether namespace scripts count against it is **unmeasured**.
- The admin's token needs Workers Scripts edit for plain Workers. Today's hardened `wp-provision` deliberately has no plain script write (`HARDENING.md`). On the user's own account, for the user's own sites, this is a fair trade, but it changes the security boundary, so it is the lead's ruling (section 5).
- `workers.dev` runs a Browser Integrity Check that cannot be turned off; some default library user agents get error 1010 (same page). Browsers are fine. A plugin that calls its own site with a bare library user agent may fail. **Unmeasured.**
- "Use your own domain" comes later: a Workers Custom Domain on the site's dispatcher Worker, for a zone already in the same account. Phase A and phase B do not mix in one deployment today (`docs/operator.md`, "Known limit"), so this needs that limit lifted first. Parked, and it needs a CR before we route a zone in a test.

### 2.5 The hand-off to the site's own wp-admin

The Success screen has one button, **Log In**, to `https://wp-<name>.<you>.workers.dev/wp-login.php`. The user logs in with the username and password they typed on Add New Site. The admin never stores that password; it passes it once to the install and forgets it. After that, the site manager is not needed for daily work. The user lives in the site's wp-admin.

### 2.6 What a WordPress developer will still notice (the honest list)

These break "feels like WordPress". The button does not cause them, and this design does not fix them, but the lead should rule on each before a WordPress developer tries the path.

1. **Plugins and themes do not persist when installed from wp-admin.** `docs/plugins.md`: "a plugin installed from wp-admin does not persist" (the file system is in memory; plugins must be in the build). Today a demo site hides this with `DISALLOW_FILE_MODS` (`spikes/b2-wordpress/site-lock.mjs`). The size and memory sides are in #293. For the first cut, I recommend the same lock on every one-click site, so **Plugins > Add New** is not offered rather than offered and then lost, plus a WordPress-style notice that names the plugins the site has. That is honest, but it is not "plugins as usual". A real fix (plugins kept in R2 and loaded per runtime, lever B of #293) is its own issue.
2. **Email** (1.3 F).
3. **Cold starts** (#394): a quiet site can take about 3.5 s for a page. A developer who clicks around a fresh site sees it.

## 3. Part 3: import from an existing WordPress

| Option | What the user does | Content (posts, pages, comments, menus, terms) | Media | Users | Settings, widgets | Theme | Plugins | Works today on b-dosql? |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **A. WXR with the WordPress Importer** | Tools > Export on the old site, then Tools > Import > WordPress on the new one | Yes | Yes, fetched from the old site by URL, if it is still up | Authors only (mapped or made; no passwords) | No | No | No | The importer must be in the build (section 2.6, item 1). Media fetch goes out through `wp_remote_*`, which the HTTP bridge sends through `fetch()` (`docs/prior-art.md`). A large file may hit the CPU or request limits. **Unmeasured.** |
| **B. Upload the database and `wp-content`** | Upload a `.sql` dump and a `wp-content` archive on the Import screen of the site manager | Yes | Yes | Yes, with passwords | Yes | Only if it is in the build | Only if in the build | The pipeline exists as a CLI (`deploy/import.sh`, `dump-to-sqlite.php`, `search-replace.py`, `dbmove`). It runs in PHP CLI and Python, not in a Worker. Porting it is real work. |
| **C. Point at a URL, with a plugin on the old site** | Install a small export plugin on the old site; paste the new site's address and a one-time code | Yes | Yes | Yes | Yes | Same as B | Same as B | Needs a new plugin and a receiver. Prior art: WP Migrate, Migrate Guru class tools. Not built. |
| **D. A full-site archive** (`.wpress`, Duplicator) | Install the migration plugin on both sides | Yes | Yes | Yes | Yes | The files restore into memory and are lost on restart | Same | All-in-One WP Migration activates on B Paid (`docs/plugins.md`), but a restore writes plugin and theme files that do not persist, and a large archive meets the upload size limit. **Unmeasured**, and likely misleading. |

What Pagefeather cannot run, whichever way a site comes in (sources in the repo):

- A plugin or theme that is not in the build (`docs/plugins.md`).
- A plugin set over the 64 MiB Worker size or the 128 MiB memory cap: Elementor does not fit; Rank Math on a store goes over memory (#293, #279, `docs/known-limitations.md`).
- A plugin that writes its own files at run time and expects them to stay (page-cache plugins that write to `wp-content/cache`, file-based logs). Same cause as item 1 of 2.6.
- `curl_*`, PHP streams over HTTP and raw sockets: the bridge covers `wp_remote_*` only (`docs/prior-art.md`, HostlessWP section).
- A plugin that needs MySQL itself on b-dosql (SQLite): for example one that calls `mysqli_*` on `$wpdb->dbh` (`docs/plugins.md`, the All-in-One WP Migration finding on approach A).
- PHP extensions that the WebAssembly PHP does not have, ionCube-encoded plugins, and anything that runs a shell command. **Unmeasured** as a list; it follows from PHP running as WebAssembly in a Worker.

**Recommendation for the first cut: option A.** It is ordinary WordPress (the user uses the WordPress importer inside their new wp-admin, the way they already move content), it needs no new server code beyond putting the importer in the build, and it keeps the site manager simple. Its gaps (theme, plugins, settings, passwords) are the same gaps that 2.6 item 1 already causes, so option B or C is worth building only after plugins persist.

## 4. The measurement plan

What we measure, all on a throwaway account and a throwaway Git account, from a browser:

1. **Time** from the click on the button to the new site's wp-admin dashboard loaded and logged in. Split it: (a) button to admin live, (b) the three guided steps, (c) Add New Site to the Success screen, (d) Log In to the dashboard. A stopwatch on a screen recording, start and stop on visible events.
2. **Steps**: the count of separate pages the user acts on, the count of values they type or paste, and the count of times they leave our pages for the Cloudflare dashboard. Today's target from this design: the button, 3 guided steps, 1 paste, 1 email, 1 form.
3. **What fails**: each failure with its screen, its exact message, and whether a WordPress developer could recover without help. A failed run is a result and is recorded (repo rule).
4. **The unmeasured items above**, each answered yes or no: the namespace made by Wrangler (1.1); the secret field on the deploy page (1.1); the `Purchase` label (A); a new account's `workers.dev` subdomain (E); the account id from `GET /accounts` (D); the permission group ids (C); mail on a `workers.dev`-only account (F); WooCommerce turned on by `/_activate` on this path (2.2); a WXR import with media (3, option A), on the big Woo sample store export, not an empty site.
5. **A real WordPress developer**: the same run, timed, by a person who has not used Cloudflare. We watch and do not help. This is the measurement the issue asks for; ours is only the rehearsal.

Results go in `docs/results.md` with the date, the command or click path, the Wrangler version the build used, and the result.

**What the lead must create (I create no sites and no accounts):**

- A new Cloudflare account with nothing on it, to see the real first-run path. It needs Workers for Platforms bought ($25 a month, plus Workers Paid if the run shows it is needed) and Zero Trust Free (a card on file). Cancel after the run.
- A throwaway GitHub account or organisation for the button's clone. A repository in `skyphusion-labs` would also work, but then the run is not a stranger's run.
- An inbox for `ADMIN_EMAIL` that the tester can read (the Access one-time PIN goes there).
- The bundle release (1.4) must exist before the run, or the run stops at "WordPress files are ready".

## 5. Decisions

**For the lead:**

1. Workers for Platforms or plain Workers for the one-click path. This design keeps Workers for Platforms (the provisioning core, the site map and the dispatcher are all built on it, and one code path is a repo principle). The cost to the user is $25 a month before the first site, and it is the first guided step. The other way (each site a plain Worker, about $5 a month on Workers Paid) drops step A but is a second code path. I recommend Workers for Platforms.
2. The admin's token gets plain Workers Scripts edit, for the per-site `workers.dev` dispatcher (2.4). This widens what `HARDENING.md` allows today.
3. Lock plugin and theme installs on one-click sites (2.6, item 1) until plugins persist, and open an issue for persistence.
4. The bundle release (1.4): a CI job, and later a signed manifest for updates.
5. Where the button lives: a subdirectory of this repo (for example `deploy/oneclick/`, fully self-contained, as the button requires) or its own small repository. A subdirectory must vendor `deploy/provision/`, and a drift test must keep the two the same.

**For Conrad (only he can decide):**

1. **Spend:** a throwaway Cloudflare account with Workers for Platforms for the measurement run, about $25 to $30 for one month.
2. **The tester:** one of the WordPress developers he spoke with, to do the timed run in section 4, item 5. Only he can ask them.
3. **The $25 a month floor.** A WordPress developer pays Cloudflare $25 a month before their first site. That is a product position, not engineering. If it is too high for the people he spoke with, decision 1 for the lead changes.

## Parked

- Updates from the site manager (a signed bundle manifest), 1.4.
- "Use your own domain" (Workers Custom Domain, after the phase A and B limit), 2.4. Needs a CR to test.
- Email on a site without a domain, 1.3 F.
- Plugin and theme persistence, 2.6 item 1 (#293 lever B).
- Import options B and C, section 3.
- Approach A sites from the site manager (a database choice screen), 2.2.

## Pages read (2026-11-13)

| Page | Last updated (as shown) |
| --- | --- |
| [Deploy to Cloudflare buttons](https://developers.cloudflare.com/workers/platform/deploy-buttons/) | 2026-10-12 |
| [Wrangler configuration (Automatic provisioning)](https://developers.cloudflare.com/workers/wrangler/configuration/) | 2026-11-12 |
| [Workers Builds configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/) | 2026-11-08 |
| [Workers Builds limits and pricing](https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/) | 2026-10-28 |
| [Workers for Platforms, Get started](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/get-started/) | 2026-08-14 |
| [Workers for Platforms pricing](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/pricing/) | 2026-04-21 |
| [Cloudflare Access for Workers](https://developers.cloudflare.com/workers/configuration/cloudflare-access/) | 2026-11-02 |
| [Zero Trust, Get started](https://developers.cloudflare.com/cloudflare-one/setup/) | 2026-10-12 |
| [workers.dev](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/) | 2026-11-06 |
| [API token template URLs](https://developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template/) | 2026-09-21 |
| [Account API tokens](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/) | 2026-10-23 |
| [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) | 2026-11-13 |
| [cloudflare/templates worker-publisher-template](https://github.com/cloudflare/templates/tree/main/worker-publisher-template) | commit `47645c9`, 2026-09-22 |
