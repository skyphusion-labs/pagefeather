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

// #1096 (the lead's bar): a FAKE send_email binding that enforces the address type the way workerd does. An address is a
// string, or an object with a string email AND a string name; anything else throws workerd's own message (measured on
// cf759hx). It is red on the old shape and green on bindingAddress, with the name empty, unset or set.
function fakeBinding() {
	const sent = [];
	const check = (field, a) => {
		if (typeof a === 'string') return;
		if (!a || typeof a !== 'object' || typeof a.email !== 'string') throw new TypeError("Incorrect type for the 'email' field on 'EmailAddress': the provided value is not of type 'string'.");
		if (typeof a.name !== 'string') throw new TypeError("Incorrect type for the 'name' field on 'EmailAddress': the provided value is not of type 'string'.");
	};
	return {
		sent,
		async send(msg) {
			check('from', msg.from);
			if (msg.replyTo !== undefined) check('replyTo', msg.replyTo);
			sent.push(msg);
			return { messageId: 'm' + sent.length };
		},
	};
}
test('#1096 RED: the old shape ({ email } with no name, MAIL_FROM_NAME unset) is refused by a workerd-typed binding', async () => {
	const b = fakeBinding();
	await assert.rejects(b.send({ from: sender({ MAIL_FROM: 'a@shop.example.co' }), to: 'c@c.example.co', subject: 's', text: 't' }), /Incorrect type for the 'name' field on 'EmailAddress'/);
	await assert.rejects(b.send({ from: 'a@shop.example.co', replyTo: replyTo('a@shop.example.co', 'Reply-To: b@b.example.co\r\n'), to: 'c@c.example.co', subject: 's', text: 't' }), /'name' field/);
});
test('#1096 GREEN: through bindingAddress the binding accepts the name unset, empty and set, for from and replyTo', async () => {
	const b = fakeBinding();
	for (const env of [{ MAIL_FROM: 'a@shop.example.co' }, { MAIL_FROM: 'a@shop.example.co', MAIL_FROM_NAME: '' }, { MAIL_FROM: 'a@shop.example.co', MAIL_FROM_NAME: '  ' }, { MAIL_FROM: 'a@shop.example.co', MAIL_FROM_NAME: 'North Shop' }]) {
		const from = sender(env);
		for (const hdr of ['', 'Reply-To: b@b.example.co\r\n', 'Reply-To: Bea <b@b.example.co>\r\n']) {
			const rt = replyTo(from.email, hdr);
			const msg = { from: bindingAddress(from), to: 'c@c.example.co', subject: 's', text: 't' };
			if (rt) msg.replyTo = bindingAddress(rt);
			await b.send(msg);
		}
	}
	assert.equal(b.sent.length, 12);
	assert.deepEqual(b.sent[9].from, { email: 'a@shop.example.co', name: 'North Shop' }, 'a set name is kept');
	assert.equal(b.sent[0].from, 'a@shop.example.co', 'no name: the bare address');
	assert.deepEqual(b.sent[11].replyTo, { email: 'b@b.example.co', name: 'Bea' });
});

// #1056: MAIL_ALLOWED_TO, a destination allowlist on the send_email binding, as c1 has (c1-config.sh). A test
// site with a real MAIL_FROM could otherwise send to any address it is handed (a load run's buyers, a suite's).
test('#1056 MAIL_ALLOWED_TO renders allowed_destination_addresses', async () => {
	const m = await import('../mail-from.mjs');
	assert.equal(
		m.sendEmailBinding({ MAIL_FROM: 'wp-test@skyphusion.org', MAIL_ALLOWED_TO: 'mackaye@skyphusion.org' }),
		'send_email = [{ name = "EMAIL", allowed_sender_addresses = ["wp-test@skyphusion.org"], allowed_destination_addresses = ["mackaye@skyphusion.org"] }]',
	);
	assert.equal(
		m.sendEmailBinding({ MAIL_FROM: 'wp-test@skyphusion.org', MAIL_ALLOWED_TO: 'a@skyphusion.org, b@example.org' }),
		'send_email = [{ name = "EMAIL", allowed_sender_addresses = ["wp-test@skyphusion.org"], allowed_destination_addresses = ["a@skyphusion.org", "b@example.org"] }]',
	);
});

test('#1056 unset MAIL_ALLOWED_TO leaves the binding as it was', async () => {
	const m = await import('../mail-from.mjs');
	assert.equal(m.sendEmailBinding({ MAIL_FROM: 'wp-test@skyphusion.org' }), 'send_email = [{ name = "EMAIL", allowed_sender_addresses = ["wp-test@skyphusion.org"] }]');
	assert.equal(m.sendEmailBinding({ MAIL_FROM: 'wp-test@skyphusion.org', MAIL_ALLOWED_TO: '' }), 'send_email = [{ name = "EMAIL", allowed_sender_addresses = ["wp-test@skyphusion.org"] }]');
});

test('#1056 a bad MAIL_ALLOWED_TO is refused, as c1 refuses it', async () => {
	const m = await import('../mail-from.mjs');
	assert.throws(() => m.sendEmailBinding({ MAIL_FROM: 'wp-test@skyphusion.org', MAIL_ALLOWED_TO: 'not-an-address' }), /MAIL_ALLOWED_TO/);
	assert.throws(() => m.sendEmailBinding({ MAIL_FROM: 'wp-test@skyphusion.org', MAIL_ALLOWED_TO: 'a"b@skyphusion.org' }), /MAIL_ALLOWED_TO/);
	const eleven = Array.from({ length: 11 }, (_, i) => `t${i}@skyphusion.org`).join(',');
	assert.throws(() => m.sendEmailBinding({ MAIL_FROM: 'wp-test@skyphusion.org', MAIL_ALLOWED_TO: eleven }), /MAIL_ALLOWED_TO/);
});

test('#1056 MAIL_ALLOWED_TO with no sender is refused (it would allow nothing to be sent, silently)', async () => {
	const m = await import('../mail-from.mjs');
	assert.throws(() => m.sendEmailBinding({ SITE_ORIGIN: 'https://wp.workers.dev', MAIL_ALLOWED_TO: 'mackaye@skyphusion.org' }), /MAIL_ALLOWED_TO needs MAIL_FROM/);
});

// #1135 (the lead's ruling (a)): the refusal pre-check. A recipient the platform can never deliver to is refused inside
// wp_mail, in 0 ms, before anything is queued, so #368's HOLD (a request with a lost write sends no mail) still decides
// at the request end. Two classes, one path: #198's undeliverable domains, and the MAIL_ALLOWED_TO allowlist, which the
// send_email binding enforces as allowed_destination_addresses. Both are rendered from ONE list (allowedTo).
import { precheckRecipients, allowedTo as allowedTo1135, sendEmailBinding as binding1135, mailVarLines as vars1135 } from '../mail-from.mjs';
test('#1135 precheck: undeliverable domains and addresses outside MAIL_ALLOWED_TO are refused, with the reason', () => {
	const env = { MAIL_ALLOWED_TO: 'mackaye@skyphusion.org,b@skyphusion.org' };
	const r = precheckRecipients(env, ['mackaye@skyphusion.org', 'load@example.com', 'customer@skyphusion.org']);
	assert.deepEqual(r.send, ['mackaye@skyphusion.org']);
	assert.deepEqual(r.refused.map((x) => x.why), ['undeliverable', 'not-allowed']);
	assert.equal(r.reason, 'email to [address] not allowed', "the binding's own text for an allowlist refusal (strummer's #1135 run)");
	assert.equal(precheckRecipients({}, ['load@example.com']).reason, 'undeliverable recipient domain (#198)');
	assert.deepEqual(precheckRecipients({}, ['a@skyphusion.org', 'B@SkyPhusion.org']).send, ['a@skyphusion.org', 'B@SkyPhusion.org'], 'no allowlist: only #198 applies');
	assert.deepEqual(precheckRecipients({ MAIL_ALLOWED_TO: 'Mackaye@Skyphusion.org' }, ['mackaye@skyphusion.org']).send, ['mackaye@skyphusion.org'], 'the allowlist compares addresses case-insensitively');
	assert.equal(precheckRecipients({ MAIL_ALLOWED_TO: 'not an address' }, ['x@skyphusion.org']).send.length, 1, 'a malformed runtime list (deploy refuses one) fails OPEN to the binding, never refusing a deliverable send');
});
test('#1135 ONE source: the binding allowlist and the MAIL_ALLOWED_TO var are rendered from the same list, and are equal', () => {
	const env = { MAIL_FROM: 'wp@skyphusion.org', MAIL_ALLOWED_TO: ' mackaye@skyphusion.org , b@skyphusion.org ' };
	const b = binding1135(env);
	const fromBinding = JSON.parse(b.match(/allowed_destination_addresses = (\[[^\]]*\])/)[1]);
	const v = vars1135(env);
	const fromVar = JSON.parse(v.match(/^MAIL_ALLOWED_TO = (".*")$/m)[1]).split(',');
	assert.deepEqual(fromBinding, allowedTo1135(env));
	assert.deepEqual(fromVar, fromBinding, 'the var is the binding list, exactly');
	assert.equal(/MAIL_ALLOWED_TO/.test(vars1135({ MAIL_FROM: 'wp@skyphusion.org' })), false, 'no allowlist, no var');
});
test('#1135 PRODUCTION: an unset, empty or blank MAIL_ALLOWED_TO is NO allowlist pre-check: every deliverable recipient passes', () => {
	const list = ['customer@gmail.com', 'Owner <owner@shop.co.uk>', 'b@skyphusion.org'];
	for (const env of [{}, { MAIL_ALLOWED_TO: '' }, { MAIL_ALLOWED_TO: '   ' }, { MAIL_ALLOWED_TO: undefined }, null, undefined]) {
		const r = precheckRecipients(env, list);
		assert.deepEqual(r.send, list, 'all sent with env ' + JSON.stringify(env));
		assert.equal(r.refused.length, 0);
		assert.equal(r.reason, null);
	}
	assert.deepEqual(precheckRecipients({}, ['customer@gmail.com', 'load@example.com']).send, ['customer@gmail.com'], 'only #198 still applies');
});
