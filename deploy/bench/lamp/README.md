# Stock LAMP baseline

A plain LAMP VPS (Linux, Apache, MariaDB, PHP) running stock WordPress and
WooCommerce, to measure native-PHP server time as the comparison baseline for
the Cloudflare approaches (b-dosql WASM PHP, c1 container).

## Box

Vultr `vc2-2c-4gb` (2 vCPU, 4 GB), Ubuntu 24.04, PHP 8.3.6 (native, same version
as the php-wasm build), MariaDB 10.11, Apache 2.4. SSH restricted to the
operator; no public route needed (measured from localhost).

## Reproduce

1. Provision the box with `cloud-init.sh` as user-data (installs the LAMP stack,
   wp-cli, production-like OPcache).
2. Run `setup-and-measure.sh` (from a control host; it SSHes in): it creates two
   installs, wp-plain (`:8081`) and wp-woo (`:8082`) at WordPress 7.1.4 +
   WooCommerce 11.2.1, then measures server-side time from localhost
   (`curl %{time_total}` and `woo.py`, the same checkout flow used for b-dosql).

## Measured (2026-11-07, localhost, no network)

- Plain WordPress home: median 88 ms server time.
- WooCommerce guest COD checkout: 0.62 s (order created, stock decremented).
- Shop page ~0.3 s; cart / add-to-cart 0.08 to 0.09 s.

Compared with b-dosql (WASM PHP + translated SQLite) whose warm checkout wall is
about 2.75 to 3.14 s even with the AST translation cache, and the c1 container
(native PHP) at 1.3 to 1.7 s warm but 11 to 12 s cold. Native LAMP is the fastest
per request and has no cold start, at the cost of an always-on paid server.
