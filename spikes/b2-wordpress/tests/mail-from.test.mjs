import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveMailFrom, sender, replyTo, sendEmailBinding, mailVarLines, undeliverable, deliverableRecipients } from '../mail-from.mjs';

test('MAIL_FROM wins over the site host', () => {
	assert.equal(resolveMailFrom({ MAIL_FROM: 'shop@shop.example.co', SITE_ORIGIN: 'https://other.example.co' }), 'shop@shop.example.co');
});

test('a custom host derives wordpress@host', () => {
	assert.equal(resolveMailFrom({ SITE_ORIGIN: 'https://Shop.Example.co' }), 'wordpress@shop.example.co');
});

test('workers.dev and example names do not become a sender', () => {
	assert.equal(resolveMailFrom({ SITE_ORIGIN: 'https://wp-one.sub.workers.dev' }), '');
	assert.equal(resolveMailFrom({ MAIL_FROM: 'admin@example.com' }), 'admin@example.com');
	assert.equal(sender({ MAIL_FROM: 'admin@example.com' }), null);
	assert.equal(undeliverable('a@shop.example.com'), true);
});

test('the display name is MAIL_FROM_NAME only', () => {
	assert.deepEqual(sender({ MAIL_FROM: 'a@shop.example.co' }), { email: 'a@shop.example.co' });
	assert.deepEqual(sender({ MAIL_FROM: 'a@shop.example.co', MAIL_FROM_NAME: 'North Shop' }), { email: 'a@shop.example.co', name: 'North Shop' });
});

test('a different From becomes Reply-To, and workers.dev does not', () => {
	assert.deepEqual(replyTo('a@shop.example.co', 'From: Ada <ada@ada.example>\r\n'), { email: 'ada@ada.example', name: 'Ada' });
	assert.equal(replyTo('a@shop.example.co', 'From: wordpress@wp.workers.dev'), null);
	assert.equal(replyTo('a@shop.example.co', 'From: a@shop.example.co'), null);
});

test('the binding is restricted only when there is an address', () => {
	assert.equal(sendEmailBinding({ SITE_ORIGIN: 'https://wp.workers.dev' }), 'send_email = [{ name = "EMAIL" }]');
	assert.equal(
		sendEmailBinding({ SITE_ORIGIN: 'https://shop.example.co' }),
		'send_email = [{ name = "EMAIL", allowed_sender_addresses = ["wordpress@shop.example.co"] }]',
	);
	assert.equal(mailVarLines({ SITE_ORIGIN: 'https://shop.example.co', MAIL_FROM_NAME: 'North' }), 'MAIL_FROM = "wordpress@shop.example.co"\nMAIL_FROM_NAME = "North"');
	assert.equal(mailVarLines({ SITE_ORIGIN: 'https://wp.workers.dev' }), '');
	assert.throws(() => sendEmailBinding({ MAIL_FROM: 'a"b@shop.example.co' }));
});

test('deliverableRecipients drops the seeded test admin and keeps a real address', () => {
	const r = deliverableRecipients(['admin@example.com', 'buyer@shop.test', 'owner@realstore.com']);
	assert.deepEqual(r.deliverable, ['owner@realstore.com']);
	assert.equal(r.dropped, 2);
});

test('deliverableRecipients accepts a bare string and trims', () => {
	assert.deepEqual(deliverableRecipients('  owner@realstore.com ').deliverable, ['owner@realstore.com']);
	assert.equal(deliverableRecipients('admin@example.com').deliverable.length, 0);
	assert.equal(deliverableRecipients('admin@example.com').dropped, 1);
});

test('deliverableRecipients drops blanks and all-undeliverable lists cleanly', () => {
	const r = deliverableRecipients(['', null, 'x@localhost', 'y@workers.dev']);
	assert.deepEqual(r.deliverable, []);
	assert.equal(r.dropped, 2);
});
