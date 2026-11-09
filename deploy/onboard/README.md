# Onboarding Phase 1: provider choice to a ready Hyperdrive config

Issue #240. For "approach A" (WordPress in a Worker, external managed MySQL
reached through Hyperdrive; see `docs/approach-a.md` and `docs/approach-a2.md`).

An end user chooses a database PROVIDER. This step sets up that provider's
backing where needed, creates a Hyperdrive config (caching disabled) pointing at
it, and prints the config id. That id feeds Phase 2:

    node deploy/provision/cli.mjs  (and, planned) site add --kind a <name> --hyperdrive <id>

This is ONE step with ONE output contract. It does not build or deploy a Worker.

## Usage

    node deploy/onboard/onboard.mjs <provider> --name <config-name> [--out FILE] [--dry-run]

- `<provider>`: `azure`, `planetscale`, `vultr`, or `external`.
- `--name`: the Hyperdrive config name (lower case, digits, hyphens, 1 to 40).
  May also be given as `ONBOARD_NAME`.
- `--out FILE`: also write `HYPERDRIVE_ID=...` and `SQL_MODE=...` to FILE (0600),
  for Phase 2 to source. May also be given as `ONBOARD_OUT`.
- `--dry-run`: print the plan (no secrets, no API calls, no spend) and exit.

Output on stdout is one JSON object. Progress goes to stderr. No secret value is
ever printed or written.

### Always needed

    CLOUDFLARE_ACCOUNT_ID   the Cloudflare account (or ACCOUNT_ID)
    CLOUDFLARE_API_TOKEN    a token that can create Hyperdrive configs (and, for
                            planetscale, call the PlanetScale integration)

These come from the environment. Account id is never hard-coded (IaC rule). For
the operator's own run the token is the privileged account token at
`/Users/conrad/cloudflare-mcp.env` (`CLOUDFLARE_API_TOKEN`).

## The contract handed to Phase 2

Every run prints, and `--out` stores:

- `HYPERDRIVE_ID`: the Hyperdrive config id.
- `SQL_MODE`: `ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION` for
  `planetscale`, EMPTY for the others.

`SQL_MODE`, when set, is what Phase 2 passes as `HYPERDRIVE_SQL_MODE` so each
statement carries the mode on a strict server that will not keep a session `SET`
(`docs/approach-a2.md`, result 2). It is empty for Azure and Vultr because those
servers are relaxed at the server instead.

Caching is DISABLED on every provider. Hyperdrive's default query cache (60 s,
not invalidated on writes) serves stale WordPress reads; the a2 measurements
deploy with it off.

## Providers

### external

A MySQL the user already has. Public SSL host, or a Cloudflare Tunnel behind
Access (CR #141, no public port, no SSL on the box).

    MYSQL_HOST, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE   required
    MYSQL_PORT                                               default 3306
    MYSQL_ACCESS_CLIENT_ID, MYSQL_ACCESS_CLIENT_SECRET       both set => tunnel origin

    node deploy/onboard/onboard.mjs external --name wp-acme

### azure

Azure Database for MySQL Flexible Server. The server `sql_mode` is relaxed to
`ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION` (idempotent) with the `az`
CLI, then a Hyperdrive config is made (SSL, caching off).

    AZ_MYSQL_PASSWORD                      required (the live value is in
                                           /Users/conrad/wpref-azure-mysql.env
                                           as AZ_MYSQL_PASSWORD)
    AZ_MYSQL_HOST       default wpref-mysql.mysql.database.azure.com
    AZ_MYSQL_DATABASE   default wordpress
    AZ_MYSQL_USER       default wpadmin
    AZ_RESOURCE_GROUP, AZ_SERVER_NAME      both set => run the az sql_mode relax;
                                           unset => skip it (the live wpref server
                                           is already relaxed)
    HYPERDRIVE_ID                          reuse an existing config, do NOT create

Azure is the one LIVE backend. Its existing config is
`84ab72d4ef5d479a99348b436b44f717`. To reuse it (relax sql_mode, verify, emit,
no new config):

    HYPERDRIVE_ID=84ab72d4ef5d479a99348b436b44f717 \
      node deploy/onboard/onboard.mjs azure --name wpref-a

### planetscale

CF-billed PlanetScale (Vitess MySQL, one Cloudflare bill). The step asks
Cloudflare for a database signature, pipes it to `pscale database create
--cloudflare-billing`, makes a branch password, and creates a Hyperdrive config
to the DIRECT region host. `pscale` must be authenticated first (`pscale auth
login`). This backend REQUIRES `SQL_MODE` (Vitess is strict).

    PSCALE_ORG, PS_DB_NAME                 required
    PS_REGION           default us-west
    PS_CLUSTER_SIZE     default PS-10  (a paid plan; see Cost)
    PS_PASSWORD_NAME    default hyperdrive
    PS_DIRECT_HOST      default <PS_REGION>.connect.psdb.cloud

The anycast "optimized" host `aws.connect.psdb.cloud` is about 27 ms per query
slower through Hyperdrive (`docs/approach-a2.md`, result 1); the step REFUSES it.
Vitess schema-propagation lag: a WordPress install or plugin activation may need
a re-run.

    node deploy/onboard/onboard.mjs planetscale --name wp-a2 --out build/a2.env

### vultr

A self-managed MariaDB box, provisioned by the existing `deploy/mysql`
Terraform (Vultr instance, a firewall group open on 3306 to Cloudflare's ranges
only, a Cloudflare DNS record, MariaDB with REQUIRE SSL via cloud-init). Then a
Hyperdrive config to the host.

    VULTR_API_KEY       required (the key at /Users/conrad/.vultr-api.key)
    MYSQL_ZONE_ID       required (skyphusion.org = 3b58b52bd324332fb56b3ab685588c76)
    MYSQL_HOST          required (the db hostname in that zone, e.g.
                        mysql-acme.skyphusion.org)
    MYSQL_REGION        default ord (Chicago)
    MYSQL_PLAN          default vc2-2c-4gb

`deploy/mysql`'s own default plan is `vc2-1c-2gb`; this step defaults LARGER
because `vc2-1c-2gb` was flaky under heavy concurrent load this session. A
`vc2-1c` plan is allowed but warns. Terraform state is one workspace per config
name, local by default.

    node deploy/onboard/onboard.mjs vultr --name wp-acme

## What it does NOT do

- Build or deploy a Worker (Phase 2).
- Enable Hyperdrive query caching (always disabled).
- Mint a Cloudflare token (operator supplies one).
- Create a config for `azure` when `HYPERDRIVE_ID` is set (it reuses).

## Cost

- `external` and `azure`-reuse: free (a Hyperdrive config is free).
- `azure`-create: free config; the Azure server is an existing paid resource.
- `vultr`: the box is about $10 a month at `vc2-1c-2gb`, more at `vc2-2c-4gb`,
  billed by the hour.
- `planetscale`: `PS-10` is a paid plan (about $39 a month, measured for
  `wp-on-cf-a2`), on the single Cloudflare bill.

## Tests

    node deploy/onboard/tests/hyperdrive-test.mjs
    node deploy/onboard/tests/onboard-test.mjs

Both are offline: a fake CF fetch and a fake CLI runner drive every provider
path, so no network, no `az`, no `pscale`, no `terraform`, no spend. They assert
the CF request shape, caching always disabled, the SQL_MODE contract, the Azure
reuse branch, the PlanetScale direct-host guard, the Vultr small-plan warning,
and that a password never reaches a log or stdout. CI runs both.

## Live check (operator, once)

The only seam the unit tests cannot cover is the real CF Hyperdrive API. To
verify it without new spend, against the live Azure host: create a throwaway
config, read it back, then DELETE it.

    node deploy/onboard/onboard.mjs azure --name wp-live-check   # prints an id
    # confirm caching.disabled is true on the returned config, then:
    curl -s -X DELETE -H "authorization: Bearer $CLOUDFLARE_API_TOKEN" \
      "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/hyperdrive/configs/<id>"
