# From a LAMP WordPress host to Workers for Platforms

<!-- VOICE / INTRO: Conrad to tune. The welcoming pitch is his to land; the
     placeholder below is a plain stand-in, not the final voice. Everything from
     "The one-to-one map" down is the substance, meant to stay accurate. -->

If you run WordPress the traditional way, a Linux box with Apache or nginx, PHP, and MySQL, you already know how to run WordPress well. That stack is battle-tested and you know it cold. This page is a translation, not a sales pitch: the same jobs you do now, mapped one-to-one onto Workers for Platforms, so you can do them without a server to keep alive and patch. Where this way gives something up, this page says so plainly.

It leads into the framework quickstart (`docs/framework.md`); read this first if the words "Worker", "Durable Object" and "R2" are new, and the quickstart second for the commands.

## The one-to-one map

| What you do on a LAMP host | The same job here | Notes |
| --- | --- | --- |
| SSH into a VPS to run or change the site | There is no box to SSH into. A site is a deployed Worker (`wp`) or a container the platform runs for you (`shop`). | You change a site by redeploying its artifact, not by logging in. |
| Apache/nginx + PHP-FPM you install and tune | The platform runs the web tier. `wp` runs PHP in a Durable Object; `shop` runs the same nginx + PHP-FPM you know, inside a container the platform schedules. | You still get PHP-FPM behind nginx for a store; you just do not operate the host. |
| MySQL or MariaDB server | `wp`: SQLite inside the Durable Object, one tenant, one database, no separate server. `shop`: SQLite on the container disk, streamed to R2; or your own MySQL over Hyperdrive if you bring one. | No database server for you to run, back up, or secure. |
| `wp-content/uploads` on local disk | R2 (object storage). The media library reads and writes R2. | Uploads are not on a disk that a container loses when it sleeps. |
| cPanel/WHM, or a script, to spin up a new site | `site add --kind wp|shop <name>`, one command, or a POST to a provisioning Worker. | The provisioning is itself a Worker you can call; no control panel. |
| System cron and `wp-cron` | Workers Cron Triggers and Durable Object alarms; a `shop` runs `wp-cron` itself on a timer inside the container. | Scheduled work does not need a crontab on a box. |
| LiteSpeed cache, W3 Total Cache, a Redis object cache | The Workers edge cache (built in, for logged-out pages) plus APCu inside the container. | You do not install a caching plugin for the edge layer; it is the platform. |
| Nightly `mysqldump` and file backups | Litestream streams every database change to R2 continuously (`shop`); the update flow snapshots the data before it changes anything and can restore it. | Restore is part of the deploy, not a separate cron job you hope ran. |
| SSH in and patch WordPress or a plugin in place | You do not patch in place. The code lives in the image or bundle; you rebuild the artifact for a new WordPress or WooCommerce version and redeploy. | No drift between what is on the box and what the config says. |
| A pet server you keep warm | Disposable. A site is created and torn down by command. | A `shop` sleeps when idle and cold-starts in about 11 to 12 seconds on the first request after that. |

## The process: declare and provision, instead of provision and install

On a LAMP host the shape is: get a VPS or a cPanel account, install WordPress, configure it by hand. The running state then lives on the box, and your notes drift from what the box actually does.

Here the shape is inverted: you DECLARE a site, its name, its kind, its resources, and provision it with one command or a Worker call. The whole fleet is code. It is committed to git, reviewed as a diff in a pull request, applied with Terraform for the data plane, and rolled back the same way. The map of which hostname serves which site is a record you read, not something you hold in your head or in a wiki that lies. A hand-built LAMP box could never be diffed or rolled back as a unit; a declared fleet can. That is the whole difference, and it is the thing a pet server cannot give you.

## What you gain, and what you give up

You gain:
- No server to patch, and nothing that drifts: a site is an artifact, versioned and disposable.
- Per-site isolation by construction: each site has its own database, its own R2 bucket, its own secrets, its own per-request limits; one site cannot read another's.
- The edge cache and R2 media without installing or tuning plugins for them.
- Provisioning that a Worker can do, so a control plane or a customer UI can stand up a site, not just a human at a shell.

You give up, or must plan around (stated plainly, because they are real):
- One routing phase per deployment: a deployment's `wp` sites are all on `workers.dev`, or all on custom hostnames; you pick one for the deployment, you do not mix them.
- A `shop` is one container per store: one region, one writer, and a cold-start wait of about 11 to 12 seconds for the first visitor after the store has been idle. For a great many tiny stores, that per-store container is a real cost.
- Transactional WooCommerce checkout needs a `shop` (the container), not a `wp` site: a Durable Object isolate hits its 128 MiB memory limit at checkout, so `wp` serves cached store BROWSING but cannot take an order.
- You update by rebuilding and redeploying the artifact, not by editing files on a live box. That removes drift, and it is a change of habit.

Every number here is measured; the sources are in the framework quickstart's architecture section (`docs/framework.md`) and `docs/approach-c1.md`. Next: the quickstart, for the commands and the prerequisites.
