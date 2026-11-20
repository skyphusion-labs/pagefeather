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
	assert.deepEqual(replyTo('a@shop.example.co', 'From: Ada <ada@ada.example.co>\r\n'), { email: 'ada@ada.example.co', name: 'Ada' });
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

// The reserved .example TLD (RFC 2606) is undeliverable too: the sample store fixture's admin is
// admin@wordpress.example, and b-dosql must never hand it to env.EMAIL.send. example.co (a real
// TLD) stays deliverable.
test('the .example TLD is undeliverable; example.co is not', () => {
	assert.equal(undeliverable('admin@wordpress.example'), true);
	assert.equal(undeliverable('x@example'), true);
	assert.equal(undeliverable('shop@shop.example.co'), false);
	assert.equal(sender({ SITE_ORIGIN: 'https://shop.wordpress.example' }), null);
	assert.deepEqual(deliverableRecipients(['a@wordpress.example', 'b@shop.example.co']), { deliverable: ['b@shop.example.co'], dropped: 1 });
});

// #1096: the send_email binding refused EVERY message when MAIL_FROM_NAME was unset. Measured on cf759hx: "Incorrect type
// for the 'name' field on 'EmailAddress': the provided value is not of type 'string'." sender() and replyTo() return
// { email } with no name key, and that object went in as msg.from / msg.replyTo. bindingAddress hands the binding the
// shape it accepts: { email, name } with a string name, else the bare address string.
import { bindingAddress } from '../mail-from.mjs';
test('#1096 bindingAddress: no name is the bare address string; a name is { email, name } with a string name', () => {
	assert.equal(bindingAddress({ email: 'a@shop.example.co' }), 'a@shop.example.co');
	assert.equal(bindingAddress({ email: 'a@shop.example.co', name: '' }), 'a@shop.example.co');
	assert.deepEqual(bindingAddress({ email: 'a@shop.example.co', name: 'North Shop' }), { email: 'a@shop.example.co', name: 'North Shop' });
	assert.equal(bindingAddress(null), null);
});
test('#1096 every address the binding can receive has a string name or none at all', () => {
	for (const a of [sender({ MAIL_FROM: 'a@shop.example.co' }), sender({ MAIL_FROM: 'a@shop.example.co', MAIL_FROM_NAME: 'N' }),
		replyTo('a@shop.example.co', 'Reply-To: b@b.example.co\r\n'), replyTo('a@shop.example.co', 'From: Ada <ada@ada.example.co>\r\n')]) {
		const b = bindingAddress(a);
		assert.ok(typeof b === 'string' || (b && typeof b.name === 'string' && b.name !== '' && typeof b.email === 'string'), JSON.stringify(b));
	}
});
test('#1096 index.js: sendEmail passes from and replyTo through bindingAddress', async () => {
	const { readFileSync } = await import('node:fs');
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	assert.match(src, /const msg = \{ to: null, from: bindingAddress\(from\), subject, html, text \};/);
	assert.match(src, /if \(rt\) msg\.replyTo = bindingAddress\(rt\);/);
});
