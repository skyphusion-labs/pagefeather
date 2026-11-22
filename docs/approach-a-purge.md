# Approach A: page-cache purges that the rate limit refuses (#837)

**The problem.** Workers Cache purges have an account limit: 5 a minute, with a bucket of 25 (#699). A purge over the limit is refused with code 1134. On approach A, the gateway purged at most once per 15 s per isolate, and it logged a refused purge and DROPPED it. Under the hlm029 wc suite on `cf759hl` (2026-11-22, 14:40 to 16:16Z), 195 of 641 purges were refused, all with 1134 (Rollins, #837). Each dropped purge left guest copies that a write had changed, until those copies aged out.

**What happens now.** A refused purge is never dropped. The code is `spikes/b2-wordpress/a-purge.mjs`, and the tests are `tests/a-purge.test.mjs`. There are two routes:

| route | when | what it does |
|---|---|---|
| `object` | `A_CRON=on` and the `PHP_RUNTIME` binding (the site's cron object, `a-cron.mjs`) | The gateway hands each purge to the cron object's `requestPurge()`. This is the same path a b-dosql site uses (#699). The object coalesces the whole site's purges into one send per 15 s. It keeps a refused purge pending in its storage, retries it on its alarm after 12 s, 24 s, then every 48 s, and asks the account purge budget first if one is bound. The object runs in the site's own script, so it can purge the site's own cache. If the hand-off fails, the gateway sends the purge itself (the `local` route). |
| `local` | no cron object | The isolate keeps the same state in memory. It retries a refused purge inside the request's `waitUntil`, for at most 25 s. A purge that is still refused stays pending (log line `m: purge-pending`), and the isolate's next request sends it. |

**The stated limit.** After a write, a guest copy can be served until the first successful purge after that write. That purge is retried, never dropped, for `PAGE_CACHE_TTL` plus `stale-while-revalidate` after the oldest write it covers: 120 + 600 = 720 s by default (`purgeWindowMs`). After that time, no copy made before the write can still be served, so the purge expires, and the expiry is counted (`m: purge-expired`). So **a guest copy is never served past its writes for longer than 720 s by default.** Store pages are shorter: 30 s plus 30 s (#628, #699). If the bucket has room, the purge goes out within 15 s of the write, plus one back-off step for each refusal.

**What the tests show (a model, not a live run).** The unit test runs 30 minutes of writes on the object route, while a neighbour site keeps spending the account bucket. It saw 44 refusals in 103 sends. Every write got a successful purge, and the worst wait was 240 s, inside the 720 s limit. The cron object in that test is a model built on the same `purge-state.mjs` functions as the object's alarm. It proves the decision path, not the deployed object. With the `local` route forced, the same run fails the limit: one isolate cannot hold it when the bucket is shared.

**Limits:**
- **The local route loses a pending purge if its isolate is evicted.** The copy then ages out within the 720 s, as before #837. Run approach A with `A_CRON=on` to use the object route.
- **No account budget on approach A yet.** `deploy.sh` binds `PURGE_BUDGET` only for b-dosql. Without it, the object fails open: one site sends at most 4 purges a minute, but several busy sites on one account can still pass 5 a minute. Then the retries and the 720 s limit are the backstop.
- **The live check is still open.** The cron object's purge reaching the site's `Pages` cache on approach A has to be proven on a box: a write, the `m: purge` lines from the object (`where: object`), and the guest copy cleared.
