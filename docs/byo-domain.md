# Bring your own domain (self-service, delegated)

**Status: current.** The `site hostname` command (PR for #248) runs this flow. It
calls the custom-hostname op built in #157 and records the result in the site map.

This page is for an operator who wants a tenant to use their own domain, like
`shop.customer.com`, in front of a site. It uses **delegated** mode. In delegated
mode the customer keeps their domain. You never touch their DNS. You give them a
short list of records to add, and they add them.

## Why delegated (the anti-hostage property)

The customer owns their domain and their registrar account. They point it at you
with one CNAME. They can point it away again at any time. You never hold their
domain, so you can never hold it hostage. If they leave, they change one record.
This is the selling point, not a limit.

Managed mode is the other option: you place the records yourself, on a zone you
control for the customer. Use it only when you (or an agency) genuinely hold the
domain. The rest of this page is delegated mode.

## Before you start

You need:

- The site already exists (you ran `site add` for it). You pass its name.
- The SaaS home is set up (see [framework.md](framework.md), "The SaaS zone").
- These environment values, the same ones the SaaS home uses:

| Variable | What it is | Example |
| --- | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare account id. | |
| `CLOUDFLARE_API_TOKEN` | A token that can edit custom hostnames and KV. | |
| `WFP_KV_ID` | The `wp-wfp-sites` map id. | |
| `WFP_SAAS_ZONE_ID` | The SaaS home zone id. | `skyphusionwp.dev` |
| `WFP_SAAS_FALLBACK` | The SaaS fallback origin. | `fallback.skyphusionwp.dev` |

Keep tokens in the environment. Never put a token in a file you commit.

## Step 1: attach the custom hostname

Run one command. Replace the site name and the domain with the real ones.

```sh
node deploy/provision/cli.mjs hostname add blog \
  --domain shop.customer.com \
  --mode delegated \
  --dcv-delegation
```

- `blog` is the site name (the tenant site you already made).
- `--domain` is the customer's domain.
- `--mode delegated` means you touch none of their DNS.
- `--dcv-delegation` adds one extra record so the certificate renews on its own.
  It is optional but recommended; without it the customer must redo the DCV
  record each time the certificate renews.

The command writes nothing to the customer's DNS. It prints two things:

1. A JSON block (for a script or a UI) with the custom hostname id and the state.
2. A human list of the exact records the customer must add.

It also records `domainOwner`, `customHostname`, `customHostnameId`, and
`customHostnameState` on the site in the map.

> **Known gap:** the per-site Terraform in `deploy/wfp/terraform/site` pins `zone_id` to the `skyphusion.org` zone by default. A bring-your-own apex needs `TF_VAR_zone_id` set to its own zone. See [known-limitations.md](known-limitations.md).

## Step 2: give the customer the records

The command prints the exact records. Give that list to the customer. There are
usually three. Add exactly what the command prints; this table says what each one
is for.

| Type | Name | Points to | Why |
| --- | --- | --- | --- |
| CNAME | the domain (`shop.customer.com`) | the SaaS fallback (`fallback.skyphusionwp.dev`) | Sends the domain to you. Keep it DNS-only (grey cloud). |
| TXT | a `_acme` style name | a value the command prints | Proves the customer controls the domain, so Cloudflare can issue the certificate. |
| CNAME | `_acme-challenge.<domain>` | a one-time delegation target | Lets future certificate renewals validate on their own. Only with `--dcv-delegation`. |

Two rules for the customer:

- Add the CNAME to the fallback as **DNS-only** (grey cloud), not proxied.
- Copy the names and values exactly as printed.

## Step 3: check the state

The customer adds the records on their side. DNS and the certificate take a few
minutes. Check the state with:

```sh
node deploy/provision/cli.mjs hostname status blog
```

It reads the live state from Cloudflare and saves it back to the site map. Look
at `customHostnameState`:

- `pending`: the records are not all seen yet, or the certificate is still being
  issued. Wait, then run it again.
- `active`: the hostname and its certificate are both active. The domain works.

When the state is `active`, the customer's domain serves the site over HTTPS.

## If something is stuck

- Still `pending` after several minutes: check the CNAME is **DNS-only** (grey
  cloud), not proxied, and that the TXT name and value match exactly.
- The customer wants to leave: they delete the CNAME. The domain stops pointing
  at you at once. You hold nothing.

## See also

- [framework.md](framework.md), "Bring your own domain": the two modes and the
  anti-hostage property in short.
- `deploy/provision/README.md`: the custom-hostname op and the CLI.
