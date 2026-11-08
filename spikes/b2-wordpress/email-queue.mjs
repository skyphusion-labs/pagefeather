// Durable outbound-email retry via a Cloudflare Queue (#190, Refs #201).
//
// v1 (#185/#187) delivers wp_mail off the request path with env.EMAIL.send under
// ctx.waitUntil: a transient Email Sending failure drops the message with no retry
// and no dead-letter. v2 hardens delivery without changing the enqueue trigger:
//
//   producer  sendPending() hands each drained wp_mail message to env.EMAIL_QUEUE
//             instead of sending it directly (index.js).
//   consumer  the Worker's queue() handler calls env.EMAIL.send, acks on success,
//             and retries with backoff on failure; after the consumer's max_retries
//             the message routes to the dead-letter queue, where it is logged/metered.
//
// A deploy without the EMAIL_QUEUE binding, or with ASYNC_EMAIL_QUEUE=off, keeps the
// v1 best-effort drain unchanged. These helpers are the pure, unit-tested core; the
// env/stats/send glue lives in index.js.

// The durable path is on only when the binding is wired AND not switched off, so a
// deploy that has not provisioned the queue falls back to the direct drain.
export function emailQueueEnabled(env) {
	return !!(env && env.EMAIL_QUEUE && env.ASYNC_EMAIL_QUEUE !== 'off');
}

// Exponential backoff, in seconds, for a failed delivery. attempts is 1 on the first
// try, so the sequence is 10, 20, 40, 80, 160, ... capped (default 900 s / 15 min).
// A non-positive or non-numeric attempts is treated as the first attempt.
export function emailBackoffDelay(attempts, capSeconds = 900) {
	const n = Math.max(1, Math.floor(Number(attempts) || 1));
	return Math.min(capSeconds, 10 * Math.pow(2, n - 1));
}

// Cloudflare Queue sendBatch accepts at most 100 messages per call, so a large drain
// is split into chunks. An empty list yields no chunks.
export function chunkBatch(items, size = 100) {
	const list = Array.isArray(items) ? items : [];
	const out = [];
	for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
	return out;
}

// The dead-letter queue is named with a "-dlq" suffix. The consumer logs and meters
// these messages instead of retrying them, so a permanently failed send is visible.
export function isDeadLetterQueue(name) {
	return typeof name === 'string' && name.endsWith('-dlq');
}

// Deliver one queued message, deciding ack vs retry. This is the consumer control
// flow, kept here so it is unit-testable with a fake message and a fake send; index.js
// supplies the real send (env.EMAIL.send through sendEmail) and the metering.
//
//   send(email) must resolve to { attempted, failed }: attempted = recipient sends
//   tried, failed = how many were rejected. attempted 0 with failed 0 means there was
//   nothing deliverable (ack, no retry). A thrown send is treated as one failure.
//
// Returns "ack", "ack-empty" or "retry".
export async function handleQueuedEmail(msg, send, opts = {}) {
	let r;
	try {
		r = await send((msg && msg.body) || {});
	} catch (e) {
		r = { attempted: 0, failed: 1 };
	}
	const attempted = (r && Number(r.attempted)) || 0;
	const failed = (r && Number(r.failed)) || 0;
	if (failed > 0) {
		const delaySeconds = emailBackoffDelay(msg && msg.attempts, opts.capSeconds);
		if (typeof opts.onRetry === "function") opts.onRetry(delaySeconds);
		msg.retry({ delaySeconds });
		return "retry";
	}
	msg.ack();
	return attempted === 0 ? "ack-empty" : "ack";
}
