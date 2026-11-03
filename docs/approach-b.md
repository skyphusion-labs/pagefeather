# Approach B: WordPress on D1

WordPress runs as PHP compiled to WebAssembly in a Worker. Its database is D1. There is no MySQL and no server.

Status: design. Nothing is deployed. Findings below are from 2026-11-03.

## The parts

| Part | Choice | Why |
| --- | --- | --- |
| PHP | `@php-wasm/web-8-3` 3.1.62, JSPI build (GPL-2.0-or-later) | Open source. It has `pdo_sqlite`, `mbstring`, `openssl`, `zlib` and `libxml`. It has an `instantiateWasm` hook, so the Worker can pass a bundled module. The HostlessWP engine is binary only, so we cannot build on it. |
| MySQL to SQLite | `sqlite-database-integration` (`WP_SQLite_Driver`) | WordPress sends MySQL. This driver parses it and writes SQLite. |
| Database | D1 binding | The goal of approach B. |
| Files | WordPress core, theme and plugins bundled; uploads in R2 | Same as HostlessWP. |

## Findings

### 1. PHP can wait for D1. Measured.

D1 is async. PHP runs synchronously. JSPI lets WebAssembly pause on a JavaScript promise.

Local workerd (Wrangler 4.157.0, compatibility date 2026-07-01) returned:

```
{"Suspending":"function","promising":"function","Tag":"function"}
```

So `WebAssembly.Suspending` and `WebAssembly.promising` exist. Not yet checked on the deployed runtime.

### 2. The PHP engine fits.

The JSPI `php_8_3.wasm` is 18,065,768 bytes, and 6,975,027 bytes after `gzip -9`. The Worker size limit is 64 MiB on both plans. Memory is 128 MB per isolate, so WordPress plus PHP must fit in that. Not yet measured.

### 3. The driver uses a small part of PDO.

`WP_SQLite_Connection` accepts a `PDO` instance in `$options['pdo']`. The driver and its information schema classes call only these: `prepare`, `execute`, `query`, `fetchAll`, `fetchColumn`, `columnCount`, `rowCount`, `lastInsertId`, `quote`, `setAttribute`.

Plan: a `D1_PDO` class that extends `PDO` and sends each statement to the D1 binding through JSPI. Counted with `grep` on `sqlite-database-integration` at `f05c1f9`.

### 4. Blocker: the driver needs PHP functions inside SQLite.

The driver registers 43 PHP functions in SQLite with `PDO::createFunction` (`class-wp-sqlite-pdo-user-defined-functions.php`). The SQL it writes calls them. Examples: `year`, `month`, `unix_timestamp`, `now`, `rand`, `md5`, `regexp`, `field`, `from_unixtime`, `get_lock`.

D1 cannot run a PHP function. A query that uses one fails on D1.

Fix: a D1 dialect in the translator. Each function becomes plain SQLite where it can:

| Function | SQLite form |
| --- | --- |
| `year(x)` | `CAST(strftime('%Y', x) AS INTEGER)` |
| `month(x)` | `CAST(strftime('%m', x) AS INTEGER)` |
| `now()` | `datetime('now')` |
| `unix_timestamp(x)` | `CAST(strftime('%s', x) AS INTEGER)` |
| `rand()` | `(random() / 18446744073709551616.0 + 0.5)` |
| `field(x, a, b)` | `CASE x WHEN a THEN 1 WHEN b THEN 2 ELSE 0 END` |
| `get_lock`, `release_lock` | Answer `1` without a query. One request runs at a time per isolate. |
| `md5`, `regexp` | No SQLite built-in. Compute in PHP when an argument is a constant. Otherwise fail with a clear error and list it in the compatibility table. |

The same work is needed for a Durable Object's SQLite, so it is not wasted if we add that backend.

### 5. Every query is a round trip. Not yet measured.

Each MySQL query from WordPress becomes one or more SQLite statements. Each statement is one call to D1. An uncached page can make 30 to 100 calls.

- Run the Worker next to the database (placement hint or Smart Placement). Measure the cost of one call.
- Send read-only statements in a `batch()` where the driver allows it.

### 6. The Free plan will serve cached pages only.

- D1 allows 50 queries per Worker invocation on Free and 1,000 on Paid ([D1 limits](https://developers.cloudflare.com/d1/platform/limits/)). An uncached WordPress page, after the driver adds its own statements, is likely to exceed 50.
- Worker CPU time is 10 ms per request on Free ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/)).

So on Free, logged-out pages must come from a page cache. Admin and post saves need Paid. We will measure this, not assume it.

## Prior work

- [sqlite-database-integration#288](https://github.com/WordPress/sqlite-database-integration/issues/288): D1 through the REST API. Open. A fork tried it in [Avunu/sqlite-database-integration#2](https://github.com/Avunu/sqlite-database-integration/pull/2), which was closed without a merge. Its branch is gone.
- [bhubbard/wp-cloudflare-d1](https://github.com/bhubbard/wp-cloudflare-d1): a `wpdb` replacement that calls D1. Not on the SQLite driver.
- Both use the D1 REST API from outside a Worker. Approach B uses the D1 binding from inside one.

## Steps

1. Boot `@php-wasm` in local workerd and run `phpinfo()`. Record memory and cold start.
2. `D1_PDO`: run `SELECT 1` from PHP against a local D1 through JSPI.
3. Install WordPress on D1 with the driver. Record every query that fails. That list is the D1 dialect work.
4. Add the D1 dialect for the functions in finding 4.
5. Page cache in KV or the Cache API for logged-out pages.
6. Deploy to a Free account and a Paid account. Fill row B in the README with **measured** results.
