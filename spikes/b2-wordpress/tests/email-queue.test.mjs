import assert from 'node:assert/strict';
import test from 'node:test';
import { emailQueueEnabled, emailBackoffDelay, chunkBatch, isDeadLetterQueue, handleQueuedEmail } from '../email-queue.mjs';

test('emailQueueEnabled needs the binding and the switch not off', () => {
	assert.equal(emailQueueEnabled({ EMAIL_QUEUE: {} }), true);
	assert.equal(emailQueueEnabled({ EMAIL_QUEUE: {}, ASYNC_EMAIL_QUEUE: 'off' }), false);
	assert.equal(emailQueueEnabled({ ASYNC_EMAIL_QUEUE: 'on' }), false);
	assert.equal(emailQueueEnabled({}), false);
	assert.equal(emailQueueEnabled(null), false);
});

test('emailBackoffDelay grows exponentially and caps', () => {
	assert.equal(emailBackoffDelay(1), 10);
	assert.equal(emailBackoffDelay(2), 20);
	assert.equal(emailBackoffDelay(3), 40);
	assert.equal(emailBackoffDelay(4), 80);
	assert.equal(emailBackoffDelay(99), 900);
	assert.equal(emailBackoffDelay(5, 100), 100);
});

test('emailBackoffDelay treats a missing or bad attempts as the first try', () => {
	assert.equal(emailBackoffDelay(0), 10);
	assert.equal(emailBackoffDelay(undefined), 10);
	assert.equal(emailBackoffDelay('x'), 10);
});

test('chunkBatch splits at the limit and never returns a partial over the cap', () => {
	assert.deepEqual(chunkBatch([], 100), []);
	assert.equal(chunkBatch(Array.from({ length: 100 }, (_, i) => i), 100).length, 1);
	const two = chunkBatch(Array.from({ length: 150 }, (_, i) => i), 100);
	assert.equal(two.length, 2);
	assert.equal(two[0].length, 100);
	assert.equal(two[1].length, 50);
});

test('isDeadLetterQueue matches the -dlq suffix only', () => {
	assert.equal(isDeadLetterQueue('b2-email-dlq'), true);
	assert.equal(isDeadLetterQueue('b2-email'), false);
	assert.equal(isDeadLetterQueue(undefined), false);
});

function fakeMsg(attempts = 1) {
	const calls = { ack: 0, retry: [] };
	return {
		msg: { attempts, body: { to: 'x@realstore.example-live.com', subject: 'hi' }, ack: () => calls.ack++, retry: (o) => calls.retry.push(o) },
		calls,
	};
}

test('handleQueuedEmail acks a delivered message', async () => {
	const { msg, calls } = fakeMsg();
	const r = await handleQueuedEmail(msg, async () => ({ attempted: 2, failed: 0 }));
	assert.equal(r, 'ack');
	assert.equal(calls.ack, 1);
	assert.equal(calls.retry.length, 0);
});

test('handleQueuedEmail acks (no retry) when there is nothing deliverable', async () => {
	const { msg, calls } = fakeMsg();
	const r = await handleQueuedEmail(msg, async () => ({ attempted: 0, failed: 0 }));
	assert.equal(r, 'ack-empty');
	assert.equal(calls.ack, 1);
	assert.equal(calls.retry.length, 0);
});

test('handleQueuedEmail retries with backoff on a send failure', async () => {
	const { msg, calls } = fakeMsg(3);
	let retried;
	const r = await handleQueuedEmail(msg, async () => ({ attempted: 1, failed: 1 }), { onRetry: (d) => (retried = d) });
	assert.equal(r, 'retry');
	assert.equal(calls.ack, 0);
	assert.equal(calls.retry.length, 1);
	assert.equal(calls.retry[0].delaySeconds, 40); // backoff for attempts=3
	assert.equal(retried, 40);
});

test('handleQueuedEmail treats a thrown send as a failure and retries', async () => {
	const { msg, calls } = fakeMsg(1);
	const r = await handleQueuedEmail(msg, async () => { throw new Error('send blew up'); });
	assert.equal(r, 'retry');
	assert.equal(calls.retry.length, 1);
	assert.equal(calls.retry[0].delaySeconds, 10);
});
