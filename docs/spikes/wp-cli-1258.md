# WP-CLI on a local pagefeather site (issue 1258, step 1)

Date: 2026-11-21. Local only. No deploy. Wrangler 4.107.0 (`deploy/wr --version`).

The question: does the real `wp-cli.phar` run inside our PHP runtime, on a local site, the way a request runs PHP? What does it cost in wasm memory and wall time?

Short answer: the real phar entry does not run. `PHP_SAPI` is `wasm`, and WP-CLI stops. The engine can run the same phar as CLI (`php.cli()`, or `setSapiName('cli')` before the first request). A request does not do that. If the SAPI check is skipped, `wp option get siteurl` and `wp cache flush` succeed on the local site. `wp user list` and `wp cron event list` hang, because `proc_open` has no spawn handler. `wp plugin install hello-dolly` is not refused by the code lock once the SAPI check is skipped. The real entry never reaches the lock.

## What was run

Harness: `spikes/wp-cli-1258/run.sh` (`python3 measure.py`). It does not edit product code. It puts `runner.php` and the phar into the local `build/site.zip` for the run, then restores the zip.

Phar:

```text
curl -fsSL -o cache/wp-cli.phar https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar
curl -fsSL -o cache/wp-cli.phar.sha512 https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar.sha512
```

sha512 of the file: `be928f6b8ca1e8dfb9d2f4b75a13aa4aee0896f8a9a0a1c45cd5d2c98605e6172e6d014dda2e27f88c98befc16c040cbb2bd1bfa121510ea5cdf5f6a30fe8832`

That matches the first field of the published `wp-cli.phar.sha512`. File size: 7,142,777 bytes. Version, read from `phar:///wordpress/wp-cli.phar/vendor/wp-cli/wp-cli/VERSION` inside the site runtime: `2.12.0`.

Site build: `spikes/b2-wordpress`. `./prepare.sh` (lean engine), `./build.sh` (WordPress in `site.zip`, WooCommerce files present, WooCommerce not activated). `build/opcache.zip` is the empty zip from `build.sh`. `./opcache.sh` was not run. Each shape used a new `PERSIST_TO` directory and `DEV_LOCAL=1` (Wrangler `--local`). Then `POST /_install` with the local spike token.

Shapes:

- `DEV_ENV=dosql-local`: PHP and SQLite in the Durable Object. `POST /_install` HTTP 200 in 2.295 s. Home `GET /` HTTP 200, `x-wasm-mib` 77, ledger `wasmMiB` 76.8, `x-php-ms` 221, client wall 0.261 s.
- `DEV_ENV=a-shape-local`: PHP in the Worker, database on local D1. It booted. `POST /_install` HTTP 200 in 1.785 s. Home `GET /` HTTP 200, `x-wasm-mib` 79, `x-php-ms` 203, client wall 0.215 s.

A request for `/pf-wpcli-1258.php` is a normal PHP file in the document root. `PHPRequestHandler` runs it. The worker adds `x-wasm-mib`. The spike token adds `x-php-ms` and, on dosql-local, `x-perf` (wasm before and after, and the memory ledger). `x-php-ms` is wall time around the PHP call. On this laptop the clock moves during PHP, so it is close to the client wall time.

`memory_get_peak_usage(true)` is 0 on every result. The site sets `USE_ZEND_ALLOC=0`. The wasm heap is the memory reading. The ledger value is `x-perf.mem.wasmMiB` (one decimal). `x-wasm-mib` is that heap rounded to an integer.

## Engine probe (no site database)

`node spikes/wp-cli-1258/probe-engine.mjs` boots `vendor/php_8_3.wasm` with the same loader the worker uses. There is no WordPress database. Numbers below are from `out/engine.json` after that run.

The wasm exports `wasm_set_sapi_name`, `wasm_add_cli_arg`, `run_cli`, `wasm_sapi_handle_request`, and `php_wasm_init`. `engine/expect/lean.json` says the SAPI name is `wasm`. `prepare.sh` rewrites OPcache's SAPI list entry `frankenphp` to `wasm`, so OPcache runs.

| Step | Result | Time | Wasm heap |
| --- | --- | --- | --- |
| `php.run` of a file that includes `wp-cli.phar` (`wp cli version`) | Exit -1. WP-CLI says the SAPI is `wasm`, not `cli`. | 54 ms | 24 MiB, then 24 MiB |
| `setSapiName('cli')`, then the same include | Exit 0. Stdout is the shebang line and `WP-CLI 2.12.0`. `setSapiName` did not throw. | 310 ms | 24 MiB, then 24 MiB |
| `php.cli(['php', '-r', 'echo PHP_SAPI;'])` | Exit 0. Stdout `cli`. | 5 ms | 24 MiB, then 24 MiB |
| `php.cli(['php', '/tmp/wp-cli.phar', 'cli', 'version'])` | Exit 0. Stdout `WP-CLI 2.12.0`. | 241 ms | 24 MiB, then 30.3 MiB (31,784,960 bytes) |

24 MiB is 25,165,824 bytes. `setSapiName('cli')` works only before PHP is initialized. A site request initializes PHP. The request path calls `wasm_sapi_handle_request`, not `run_cli`.

## Real phar entry, on the site

`mode=phar` includes `/wordpress/wp-cli.phar` with `argv` set to the command. This is the real entry (`php/boot-phar.php` in the phar).

Every command failed the same way, on both shapes. HTTP 500. PHP exit -1. `PHP_SAPI` in the JSON is `wasm`. The body says:

```text
WP-CLI only works correctly from the command line, using the 'cli' PHP SAPI.
You're currently executing the WP-CLI binary via the 'wasm' PHP SAPI.
```

The next sentence in that body has no space in `SAPIby`. That is the phar's own text. No command ran. The code lock was not reached.

dosql-local. The home page was at 77 MiB. The first phar request moved the heap from 77 to 85 (`x-perf` `wasm0MiB` 77, `wasm1MiB` 85). Later phar requests stayed at 85. Ledger 84.6.

| Command | Wall s | x-php-ms | x-wasm-mib |
| --- | --- | --- | --- |
| `wp option get siteurl` | 0.062 | 56 | 85 |
| `wp user list` | 0.072 | 67 | 85 |
| `wp cache flush` | 0.084 | 77 | 85 |
| `wp cron event list` | 0.091 | 64 | 85 |
| `wp plugin install hello-dolly` | 0.061 | 51 | 85 |

a-shape-local. Same error text. Heap 85 MiB after the first phar request (`x-wasm-mib` 85). `x-php-ms` was 52, 47, 53, 48, and 49, in the same command order. Client wall was 0.057 s, 0.052 s, 0.057 s, 0.054 s, and 0.054 s. a-shape does not put the dosql ledger on `x-perf`.

## Inner load (not the real entry)

`mode=inner` loads `phar:///wordpress/wp-cli.phar/vendor/wp-cli/wp-cli/php/wp-cli.php` and sets `WP_CLI_ROOT`. It skips the SAPI check in `boot-phar.php`. This is a probe. It is not how WP-CLI starts.

`STDOUT` and `STDERR` are not defined (`const_stdout` false in the probe). `php://stdout` still opens. `wp option get siteurl` succeeded with no polyfill. A second call defined `STDOUT` as `php://stdout`. It also succeeded. The polyfill is not required for that command.

The cron command did not return JSON. The harness then started a new server for the plugin command, and ran `wp user list` on that server. So the plugin row is a fresh runtime (home-sized heap), not the 85 MiB runtime.

### dosql-local

| Command | HTTP | Wall s | x-php-ms | x-wasm-mib | Ledger MiB | What came back |
| --- | --- | --- | --- | --- | --- | --- |
| `wp option get siteurl` (no polyfill) | 200 | 0.446 | 434 | 85 | 84.6 | `http://localhost:49789` (`x-boot-origin` is the same URL). 5 SQL statements. |
| `wp option get siteurl` (STDOUT polyfill) | 200 | 0.303 | 292 | 85 | 84.6 | Same URL. |
| `wp cache flush` | 200 | 0.340 | 332 | 85 | 84.6 | `Success: The cache was flushed.` |
| `wp cron event list` | none | 40.019 | none | none | none | No PHP result. See blockers. |
| `wp plugin install hello-dolly` | 200 | 1.571 | 1559 | 77 | 76.8 | Installed Hello Dolly 1.7.2. Not refused. |
| `wp user list` | none | 40.015 | none | none | none | No PHP result. See blockers. |

The 40 s times are the harness client cap (`curl -m 40`), not a finished command. The saved body for both is: `The site is busy and did not start your request. Please try again in a few seconds.`

An earlier run of the same harness, before that 40 s cap, sent `wp user list` to dosql-local and got HTTP 503 after 91.093 s. The header was `x-object-deadline: queued` and `x-php-lock: shed`. The body was the same busy text. The default object call deadline is 90 s (`object-deadline.mjs`).

### a-shape-local

| Command | HTTP | Wall s | x-php-ms | x-wasm-mib | What came back |
| --- | --- | --- | --- | --- | --- |
| `wp option get siteurl` (no polyfill) | 200 | 0.486 | 468 | 85 | `http://localhost:49953` |
| `wp option get siteurl` (STDOUT polyfill) | 200 | 0.323 | 317 | 85 | Same URL. |
| `wp cache flush` | 200 | 0.292 | 287 | 85 | `Success: The cache was flushed.` |
| `wp cron event list` | 500 | 0.309 | none | none | Worker canceled a hung request. |
| `wp plugin install hello-dolly` | 200 | 1.446 | 1434 | 79 | Installed Hello Dolly 1.7.2. Not refused. |
| `wp user list` | 500 | 0.328 | none | none | Worker canceled a hung request. |

The 500 body is: `The Workers runtime canceled this request because it detected that your Worker's code had hung and would never generate a response.`

A later pass cleared `TERM` before the include (`term=off`) and ran `wp user list` again. It still hung. dosql-local: client cap 40.008 s, no body. a-shape-local: HTTP 500 in 0.569 s, same hung-request text. `dev.log` for that a-shape run still has `SPAWN_UNSUPPORTED`. Clearing `TERM` does not avoid the spawn.

## Runtime probe (both shapes)

`mode=probe` does not start WP-CLI. dosql-local: HTTP 200, `x-wasm-mib` 77, client wall 0.077 s. a-shape-local: HTTP 200, `x-wasm-mib` 79, client wall 0.070 s. The JSON matches on the PHP facts:

- PHP 8.3.36. `PHP_SAPI` `wasm`.
- Phar is loaded. `new Phar('/wordpress/wp-cli.phar')` counts 1,162 files. `phar.readonly` is `1`. Opening the phar for read still works.
- `memory_limit` `256M`. `max_execution_time` `0`. `disable_functions` is empty. `allow_url_fopen` is `1`.
- `proc_open`, `popen`, `exec`, `shell_exec`, `system`, and `passthru` exist. `pcntl_exec` and `pcntl_fork` do not. `posix_isatty` does not. `stream_isatty` does. `curl_exec` does not. `fsockopen` exists.
- `STDIN`, `STDOUT`, and `STDERR` are not defined. `php://stdin`, `php://stdout`, `php://stderr`, and `php://output` open.
- `wp-runtime.php` exists and contains `define('DISALLOW_FILE_MODS', true);` and `define('SKYPHUSION_CODE_LOCK', true);`. The code lock is on for this local site (`site-lock.mjs`: on unless `CODE_LOCK=off`).

## Blockers

1. SAPI check, real entry. Evidence: the phar body quoted above, `PHP_SAPI` `wasm` in the JSON, exit -1, HTTP 500, on every command, both shapes. Same text from `php.run` in the engine probe (54 ms). `prepare.sh` and `engine/expect/lean.json` name this SAPI `wasm`.

2. The request path does not call the CLI entry. Evidence: the exports exist, and `php.cli()` prints `WP-CLI 2.12.0` (241 ms, heap 24 MiB to 30.3 MiB) with no site database. `setSapiName('cli')` before init also lets the phar print `WP-CLI 2.12.0` (310 ms). The site request uses `handler.request` (`wasm_sapi_handle_request`).

3. `proc_open` / `exec` have no spawn handler, and the failure hangs the request. Evidence: `dev.log` during `wp cron event list` and `wp user list` on dosql-local, and during the `term=off` user-list on a-shape-local:

```text
Error: popen(), proc_open() are unsupported on this PHP instance. Call php.setSpawnHandler()
and provide a callback to handle spawning processes, or disable popen(), proc_open() via php.ini.
code: SPAWN_UNSUPPORTED
at __asyncjs__js_popen_to_file (vendor/php_8_3.js)
```

The phar's own strings include `exec('tput cols')` when `TERM` is set, and `proc_open('echo 1 >/dev/null', ...)` as a tty check. The log does not name which program was spawned. Clearing `TERM` did not stop the hang, so the tty `proc_open` (or another spawn) still runs. `wp option get` and `wp cache flush` do not hit this path. They return.

4. Code lock does not stop `wp plugin install` inside WP-CLI 2.12.0. Evidence: the inner command printed `Installing Hello Dolly (1.7.2)`, `Downloading installation package from https://downloads.wordpress.org/plugin/hello-dolly.1.7.2.zip...`, `Plugin installed successfully.`, and `Success: Installed 1 of 1 plugins.` On both shapes. `strings` on the phar finds no `DISALLOW_FILE_MODS`. The constant is defined in `wp-runtime.php` before WordPress loads. WP-CLI did not honor it. The real phar entry never ran this command. It died on the SAPI check first, so a real include did not install the plugin.

## Recommendation for steps 2 to 4

Step 2, the allowlist. Put the refusal in our operator code. Do not expect WP-CLI 2.12.0 to enforce `DISALLOW_FILE_MODS`. This phar does not contain that name, and the inner probe installed Hello Dolly. The real entry today refuses every command, including the install, only because the SAPI is `wasm`. That is not the code lock.

Step 3, the operator endpoint. Call `php.cli()` (the `run_cli` export) on a runtime that already has the site files and the database bridge (`onMessage`). Or call `setSapiName('cli')` before `php_wasm_init` on that runtime. A normal page request cannot do either. `php.cli()` finishes by exiting the runtime, so one command consumes that runtime. Install a spawn handler that fails into PHP at once. The missing handler throws `SPAWN_UNSUPPORTED` and the request hangs: a-shape cancels it, dosql holds the PHP lock until the 90 s object deadline or the client gives up. Do not expose the route on a public host. This spike did not build that route.

Step 4, `pagefeather wp`. Stream stdout from `php.cli()`. On this small local site, with an empty OPcache file cache, the commands that finished took 0.29 s to 1.57 s of client wall time. The wasm heap stayed at the site's existing size: 77 to 85 MiB on dosql-local, 79 to 85 MiB on a-shape-local. `memory_get_peak_usage` cannot be the meter while `USE_ZEND_ALLOC=0`. Use `x-wasm-mib` or the ledger. These numbers are not a production store. WooCommerce was not active, and scripts were compiled on the first requests. Table commands (`wp user list`, `wp cron event list`) do not finish until the spawn hang is fixed. Long jobs (search-replace, import) were not run.

## Step 2: the command allowlist

WP-CLI 2.12.0 does not read `DISALLOW_FILE_MODS`. The phar does not contain that name, and the inner probe installed Hello Dolly. This allowlist is the lock.

The module is `spikes/b2-wordpress/wp-cli-allow.mjs`. Step 3 calls it from `POST /_pf/wp-cli`.

The input is an array of strings, one argument per element. A shell string is refused. The check does not read the process environment.

Allowed:

| Command | What it may do |
| --- | --- |
| `option get` | Read one option. One key may follow. |
| `user list` | List users. |
| `cache flush` | Flush the cache. |
| `cron event list` | List cron events. |
| `cron event run --due-now` | Run due events. The flag is the bare `--due-now`. A hook name or `--all` is refused. |
| `transient delete --expired` | Delete expired transients. The flag is the bare `--expired`. A key or `--all` is refused. |
| `post list` | List posts. |
| `core version` | Read the core version. |

Any other command is refused. That includes plugin and theme install, update, and delete; `core update`; `eval`, `eval-file`, and `shell`; `package`; `config`; `db import`, `db query`, and `db reset`. `search-replace` is refused here. Step 5 runs it as a chunked job. The message says the command needs a later step.

These flags are refused in every argument, including after `--`: `--exec`, `--require`, `--path`, `--ssh`, and `--http`. WP-CLI 2.12.0 `Configurator::extract_assoc` does not stop at `--`. A `--no-exec` form is the same flag. The `--` token is not a command word. A flag value uses `=`. A short option (one dash) is refused.

The refusal names the command. It says that the site's code is locked, or that the command needs a later step. It names issue #1258. It does not repeat the other arguments.

Command words are case-sensitive. `option get` is allowed. `Option get` is refused.

Test: `node --test spikes/b2-wordpress/tests/wp-cli-allow.test.mjs`. CI runs that file.

## Step 3: the operator endpoint

`POST /_pf/wp-cli` runs one allowed command. It exists only when the deploy sets `WP_CLI_ENDPOINT=on`. That value is a recorded input. When it is unset, the path answers 404, the same as any other `/_pf/` path, and the Worker does not load the WP-CLI modules.

Both checks run on every request. The request needs a `Cf-Access-Jwt-Assertion` that verifies against the team certs (`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`, cached), with `aud` equal to `ACCESS_AUD`, a future `exp`, and `iss` of `https://<team>.cloudflareaccess.com`. It also needs `x-spike-token`, compared in constant time with `SPIKE_TOKEN`. A leaked JWT alone does not get in. A leaked token alone does not get in. If either check fails, the answer is 404. It is not 401 or 403.

The body is JSON, `{"argv": ["option","get","siteurl"]}`, at most 4 KiB. The array goes only through `decideWpCli`. A shell string is refused. A refusal is 422 with the module message, and `php.cli` is not called. An allowed command is 200, `{"exit": n, "stdout": "...", "stderr": "...", "ms": n, "truncated": bool}`, and the answer is no-store (`noStoreAnywhere`).

The run is `php.cli()` in the same runtime the site uses. On b-dosql and b-do that is the site object, the one writer. On approach A it is the Worker. `WP_CLI_CONFIG_PATH` is an empty file the runner writes. The working directory is `/internal/wp-cli-run`, which has no `wp-cli.yml`. `WP_CLI_PACKAGES_DIR` is an empty directory. `WP_CLI_DISABLE_AUTO_CHECK_UPDATE=1`. STDIN is not passed. The wall limit is 25 s (exit 124, `truncated` true). Stdout stops at 1 MiB and stderr at 64 KiB (`truncated` true). One run at a time per isolate. A second run is 429.

Every allowed or refused call logs one line: `{"@event":"wp-cli", "who": <Access email or service-token client id>, "cmd": <the command name only>, "allowed": bool, "exit": n, "ms": n, "bytes": n}`. The line does not contain the arguments, stdout, stderr, the JWT, or the token.

Limits, until step 5 and step 6 expand this:

- No long jobs. Search-replace and import stay refused. Step 5 is the chunked run.
- The wall cap is 25 s. One run at a time.
- Access and a custom domain are required. `WP_CLI_ENDPOINT=on` needs `CUSTOM_DOMAIN` (#1264) plus `ACCESS_AUD` and `ACCESS_TEAM`. Those are the wp-admin Access application (#1260). #1260 does not write the AUD into the Worker yet, so the operator sets the same AUD and the team name.
- This allowlist is the code lock. WP-CLI 2.12.0 ignores `DISALLOW_FILE_MODS`.
- `user list` and `user get` refuse `user_pass` and `user_activation_key` in `--field`, `--fields`, or a `--format` template. `option get` stays allowed. The answer goes to the operator and is not logged.

The phar path the runner calls is `/wordpress/wp-cli.phar`. `build.sh` does not put that file in `site.zip`. See the step 3 PR for why.

Tests: `node --test spikes/b2-wordpress/tests/wp-cli-endpoint.test.mjs` and `bash deploy/tests/wp-cli-endpoint-test.sh`. CI runs both.
