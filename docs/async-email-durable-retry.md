# b-dosql async email: durable retry via Queues

This document describes the v2 hardening of b-dosql async email (issue #190), which
adds a durable retry path with a Cloudflare Queue. It extends the v1 async email
(#185 / #187) and advances the Queues item of the bindings umbrella (#201).

Simplified Technical English. No em dashes or en dashes.

## The problem v2 solves

In v1, WordPress wp_mail hands each message to the Worker (`emailOp`). The Worker
drains the queued messages (`sendPending`) on the request path and on the Durable
Object cron alarm, and sends each one with the Cloudflare Email Sending binding
(`env.EMAIL.send`). The send is best effort: a transient Email Sending failure drops
the message. There is no retry and no dead-letter. Order mail is low volume per site,
so this is acceptable for v1, but it is not durable.

## The v2 design

v2 keeps the enqueue trigger unchanged and hardens only the delivery leg.

1. Producer. When the durable path is on, `sendPending` hands the drained messages to
   a Cloudflare Queue (`env.EMAIL_QUEUE`) instead of sending them directly. The Durable
   Object cron alarm and the request path still call `sendPending`, so the enqueue
   trigger does not change.
2. Consumer. The Worker exports a `queue()` handler. It calls `env.EMAIL.send` for each
   queued message. On success it acknowledges the message. On failure it asks the
   runtime to retry the message after a backoff delay.
3. Retry and backoff. The delay grows exponentially: 10, 20, 40, 80, 160 seconds, and
   so on, capped at 900 seconds (15 minutes). The consumer `max_retries` caps the
   number of attempts.
4. Dead-letter. After `max_retries`, the runtime routes the message to the dead-letter
   queue (`b2-email-dlq`). A second consumer logs and meters the dead message, so a
   permanently failed send is visible to the operator, then acknowledges it.

## Status: opt-in, not a default

Provisioning has an `async-email-queue` descriptor (`deploy/provision/wp-site-config.mjs`). It is **opt-in** (`default: false`). It creates a per-site queue and dead-letter queue and adds the `EMAIL_QUEUE` binding. It does not yet subscribe the queue consumer to the site Worker; that is a step after deploy. Until that step is wired, turning the queue on by default would send order mail to a queue with no consumer, which is worse than the working direct path. See [known-limitations.md](known-limitations.md).

## The feature gate

The durable path is opt-in. It is on only when both conditions hold:

- The `EMAIL_QUEUE` producer binding is present.
- The `ASYNC_EMAIL_QUEUE` variable is not `off`.

A deploy without the binding, or with `ASYNC_EMAIL_QUEUE=off`, keeps the v1 best-effort
drain with no change. This matches the other `SKYPHUSION_*` feature gates.

## Failure handling

- Queue outage on enqueue. If `env.EMAIL_QUEUE.sendBatch` throws (a Queues outage), the
  producer falls back to a best-effort direct send, which is the v1 path. A transient
  Queues failure does not lose the mail.
- Undeliverable recipients. The consumer uses the same `sendEmail` path as v1, which
  drops undeliverable recipients (example.com, workers.dev, and so on) before the send
  (issue #198). An all-undeliverable message is acknowledged, not retried.
- Nowhere to send. If the consumer has no `MAIL_FROM` or no `EMAIL` binding, it
  acknowledges the message, which matches the v1 drop.

## Operator visibility

The Worker meters:

- `emailQueued`: messages handed to the queue.
- `emailQueueSent`: messages the consumer delivered.
- `emailQueueFailed`: delivery attempts that failed and were retried.
- `emailDead`: messages that reached the dead-letter queue.

Each retry logs a structured `email-queue-retry` line with the attempt count and the
backoff delay. Each dead letter logs a structured `email-dead-letter` line with the
recipient and subject.

## How to enable on a real deploy

1. Create the queues:

       wrangler queues create b2-email
       wrangler queues create b2-email-dlq

2. Add the producer and consumer bindings to the deploy environment, the same shape as
   the `env.dosql-local` block in `wrangler.toml`.
3. Set `ASYNC_EMAIL_QUEUE=on` (or leave it unset, since the binding alone turns the path
   on).

Provisioning the queues and wiring the deploy environment is an infrastructure step. The
code in this repository works with or without the binding. The provisioning descriptor
makes the queues and the producer binding; the consumer subscription is still a manual
step (see [known-limitations.md](known-limitations.md)).

## Local development

The `env.dosql-local` environment wires the binding for local queue development, but
sets `ASYNC_EMAIL_QUEUE=off` so the default local drain is unchanged. Set
`--var ASYNC_EMAIL_QUEUE:on` to exercise the durable path against the local queue that
`wrangler dev` simulates.

## Files

- `email-queue.mjs`: the pure helpers (feature gate, backoff, batch chunking,
  dead-letter name test), with `tests/email-queue.test.mjs`.
- `index.js`: the producer (`enqueueEmails`), the consumer (`deliverQueuedEmail`,
  `deadLetterEmail`, `consumeEmailQueue`), and the `queue()` export.
- `wrangler.toml`: the `env.dosql-local` queue producer and consumers.
