# Results

Each row is one deploy and one test run.

A row with plan `local` ran in local workerd through `wrangler dev`. It is not a plan result and does not change a README cell.

| Id | Plan | Date (UTC) | Wrangler | Command | Result |
| --- | --- | --- | --- | --- | --- |
| B | local | 2026-11-03 | 4.157.0 | `spikes/b1-boot/run.sh` | PHP 8.3.36 boots in 319 ms on the first request, a script runs in 11 ms. `pdo_sqlite` and `post_message_to_js` are loaded. |
| B | local | 2026-11-03 | 4.157.0 | `spikes/b1-boot/run.sh '?d1=1'` | PHP ran CREATE, INSERT and SELECT on D1 through JSPI. 3 D1 calls, 104 ms total on local D1. Returned the inserted row. |
