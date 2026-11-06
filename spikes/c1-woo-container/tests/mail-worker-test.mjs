// Test of Store.prototype.sendMail in worker.js (issue #104), the real text,
// against a fake send_email binding (env.EMAIL). Run:
//   node spikes/c1-woo-container/tests/mail-worker-test.mjs [another worker.js]
// Exit 0 only when every check passes.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(process.argv[2] || join(here, '..', 'worker.js'), 'utf8');
// undeliverable() and sendMail, which follows it.
const a = src.indexOf('function undeliverable(');
const m = a < 0 ? -1 : src.indexOf('Store.prototype.sendMail = async function', a);
const b = m < 0 ? -1 : src.indexOf('\n};\n', m);
if (a < 0 || m < 0 || b < 0) { console.log('FAIL worker.js: undeliverable or sendMail not found'); process.exit(1); }
const Store = function () {};
new Function('Store', src.slice(a, b) + '\n};\n')(Store);

let fails = 0;
const check = (name, ok, extra = '') => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); };
// A fake binding: records what it is given; throws when told to.
const binding = (throwCode) => {
  const calls = [];
  return { calls, send: async (m) => { calls.push(m); if (throwCode) { const e = new Error('refused for ann@example.org'); e.code = throwCode; throw e; } return { messageId: '<m1@x>' }; } };
};
const store = (env) => { const s = new Store(); s.env = env; return s; };
const msg = (extra = {}) => ({ to: ['ann@example.org'], subject: 'Order 1', html: '<p>x</p>', text: 'x', from: { email: 'orders@shop.example.co', name: 'WordPress' }, ...extra });

// 1. Not set up: no binding, or no MAIL_FROM.
let s = store({ MAIL_FROM: 'wp@mail.example.org' });
let r = await s.sendMail(msg());
check('no binding: c1_mail_not_configured', r.ok === false && r.code === 'c1_mail_not_configured' && s.mail.failed === 1 && s.mail.sent === 0);
s = store({ EMAIL: binding() });
r = await s.sendMail(msg());
check('no MAIL_FROM: c1_mail_not_configured, nothing sent', r.ok === false && r.code === 'c1_mail_not_configured' && s.env.EMAIL.calls.length === 0);

// 2. Sent: From is MAIL_FROM; the From WordPress asked for becomes the Reply-To.
let e = binding();
s = store({ EMAIL: e, MAIL_FROM: 'wp@mail.example.org', MAIL_FROM_NAME: 'Test Shop' });
r = await s.sendMail(msg());
let c = e.calls[0] || {};
check('sent: ok and messageId', r.ok === true && r.messageId === '<m1@x>' && s.mail.sent === 1);
check('sent: From is MAIL_FROM with MAIL_FROM_NAME', c.from && c.from.email === 'wp@mail.example.org' && c.from.name === 'Test Shop');
check('sent: the asked From is the Reply-To', c.replyTo && c.replyTo.email === 'orders@shop.example.co');
check('sent: to, subject, html and text passed', JSON.stringify(c.to) === '["ann@example.org"]' && c.subject === 'Order 1' && c.html === '<p>x</p>' && c.text === 'x');

// 3. The asked From is MAIL_FROM: no Reply-To. An explicit Reply-To is kept.
e = binding();
s = store({ EMAIL: e, MAIL_FROM: 'wp@mail.example.org' });
await s.sendMail(msg({ from: { email: 'WP@mail.example.org', name: '' } }));
check('same From: no Reply-To', e.calls[0] && !('replyTo' in e.calls[0]));
await s.sendMail(msg({ replyTo: { email: 'help@shop.example.co', name: 'Help' } }));
check('an explicit Reply-To is kept', e.calls[1] && e.calls[1].replyTo && e.calls[1].replyTo.email === 'help@shop.example.co');
check('no MAIL_FROM_NAME: the asked name, or the bare address', e.calls[0].from === 'wp@mail.example.org' && e.calls[1].from.name === 'WordPress');

// 3b. A Reply-To that cannot receive mail is dropped, derived or explicit
//     (live on wp-c1-mail: admin@example.com and wordpress@<site>.workers.dev).
e = binding();
s = store({ EMAIL: e, MAIL_FROM: 'wp@mail.example.org' });
await s.sendMail(msg({ from: { email: 'admin@example.com', name: 'Shop' } }));
await s.sendMail(msg({ from: { email: 'wordpress@wp-c1-mail.skyphusion.workers.dev', name: 'WordPress' } }));
await s.sendMail(msg({ replyTo: { email: 'x@shop.invalid', name: '' } }));
await s.sendMail(msg({ replyTo: { email: 'buyer@mail.example.co', name: 'Buyer' } }));
check('undeliverable Reply-To dropped: example.com, workers.dev, .invalid', e.calls.slice(0, 3).every((c) => !('replyTo' in c)));
check('a deliverable explicit Reply-To is kept', e.calls[3] && e.calls[3].replyTo && e.calls[3].replyTo.email === 'buyer@mail.example.co');
// On a deliverable MAIL_FROM, so the undeliverable rule cannot be what drops it.
e = binding();
s = store({ EMAIL: e, MAIL_FROM: 'wp@mail.shop.example.co' });
await s.sendMail(msg({ from: { email: 'wp@mail.shop.example.co', name: 'Shop' }, replyTo: { email: 'WP@mail.shop.example.co', name: 'Shop' } }));
check('a Reply-To equal to MAIL_FROM is dropped (WooCommerce sets one)', e.calls[0] && !('replyTo' in e.calls[0]));

// 4. The binding refuses: ok false with its code, counted, no address kept.
e = binding('E_SENDER_NOT_VERIFIED');
s = store({ EMAIL: e, MAIL_FROM: 'wp@mail.example.org' });
r = await s.sendMail(msg());
check('refused: ok false with the code', r.ok === false && r.code === 'E_SENDER_NOT_VERIFIED');
check('refused: failed 1, lastError, no address', s.mail.failed === 1 && s.mail.sent === 0 && s.mail.lastError.startsWith('E_SENDER_NOT_VERIFIED') && !/@/.test(s.mail.lastError));

// 5. An attachment arrives as bytes.
e = binding();
s = store({ EMAIL: e, MAIL_FROM: 'wp@mail.example.org' });
await s.sendMail(msg({ attachments: [{ filename: 'a.csv', type: 'text/csv', content: Buffer.from('a,b\n1,2\n').toString('base64') }] }));
const at = (e.calls[0].attachments || [])[0] || {};
check('attachment: bytes, name, type', at.content instanceof Uint8Array && Buffer.from(at.content).toString() === 'a,b\n1,2\n' && at.filename === 'a.csv' && at.type === 'text/csv' && at.disposition === 'attachment');

// 6. Not a message: refused before the binding.
e = binding();
s = store({ EMAIL: e, MAIL_FROM: 'wp@mail.example.org' });
r = await s.sendMail({ subject: 'x' });
check('no recipient: c1_mail_invalid, nothing sent', r.ok === false && r.code === 'c1_mail_invalid' && e.calls.length === 0);

console.log(fails ? `${fails} failing check(s)` : 'all PASS');
process.exit(fails ? 1 : 0);
