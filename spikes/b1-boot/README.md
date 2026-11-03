# Spike B1: PHP and D1 in a Worker

Proves two things in local workerd: PHP 8.3 in WebAssembly boots, and PHP can query D1 through JSPI.

## Run

```sh
npm ci
./prepare.sh
./run.sh            # PHP version, PDO drivers, extensions
./run.sh '?d1=1'    # PHP creates a table in D1, inserts a row, reads it back
```

`run.sh` starts `wrangler dev` on port 8798 and prints one response.

## How PHP reaches D1

PHP calls `post_message_to_js()` with JSON that holds the SQL and its parameters. The Worker's `php.onMessage` handler runs the statement on the `DB` binding and returns JSON. The JSPI build pauses PHP until the D1 promise settles.

Results are in `../../docs/results.md`.
