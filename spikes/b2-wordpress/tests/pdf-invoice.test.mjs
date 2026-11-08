// node --test tests/pdf-invoice.test.mjs
// Unit tests for the Browser Rendering PDF-invoice helpers (issue #227, part of #201).
// These are the pure parts index.js builds the browserRender op, the download route
// and the config gate from. Browser Rendering itself does not run here (it needs the
// binding, Paid); the render and R2 store are exercised by the lead on a live run.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
	pdfInvoiceEnabled,
	escapeHtml,
	bytesToHex,
	invoiceKey,
	isInvoiceKey,
	invoiceHtml,
	renderOpPlan,
	hmacHex,
	signDownload,
	timingSafeEqualHex,
	verifyDownload,
	invoiceDownloadPath,
	parseDownloadQuery,
} from '../pdf-invoice.mjs';

test('the gate is on only with the DO profile and both bindings, off switch wins', () => {
	const on = { PHP_IN_DO: 'on', DB_IN_DO: 'on', MEDIA: {}, BROWSER: {} };
	assert.equal(pdfInvoiceEnabled(on), true);
	assert.equal(pdfInvoiceEnabled({ ...on, PDF_INVOICE: 'off' }), false);
	assert.equal(pdfInvoiceEnabled({ ...on, BROWSER: undefined }), false);
	assert.equal(pdfInvoiceEnabled({ ...on, MEDIA: undefined }), false);
	assert.equal(pdfInvoiceEnabled({ ...on, PHP_IN_DO: 'off' }), false);
	assert.equal(pdfInvoiceEnabled({ ...on, DB_IN_DO: 'off' }), false);
	assert.equal(pdfInvoiceEnabled(undefined), false);
});

test('escapeHtml neutralises the five markup characters', () => {
	assert.equal(escapeHtml(`<script>&"'`), '&lt;script&gt;&amp;&quot;&#39;');
	assert.equal(escapeHtml(null), '');
	assert.equal(escapeHtml(42), '42');
});

test('bytesToHex pads each byte to two digits', () => {
	assert.equal(bytesToHex(new Uint8Array([0, 15, 255, 16])), '000fff10');
	assert.equal(bytesToHex(new Uint8Array([])), '');
});

test('invoiceKey sits under the invoices prefix and is sanitized', () => {
	assert.equal(invoiceKey(1234, 'abcdef01'), 'invoices/1234-abcdef01.pdf');
	// A hostile order id cannot escape the prefix or inject a path.
	assert.equal(invoiceKey('../../etc/passwd', 'deadbeef'), 'invoices/etcpasswd-deadbeef.pdf');
	// Empty id degrades to 0, random is lower-cased hex only.
	assert.equal(invoiceKey('', 'AABB'), 'invoices/0-aabb.pdf');
});

test('isInvoiceKey accepts only well-formed invoice keys', () => {
	assert.equal(isInvoiceKey('invoices/1234-abcdef01.pdf'), true);
	assert.equal(isInvoiceKey('invoices/../secret.pdf'), false);
	assert.equal(isInvoiceKey('uploads/1234-ab.pdf'), false);
	assert.equal(isInvoiceKey('invoices/1234-abcdef01.png'), false);
	assert.equal(isInvoiceKey(''), false);
	assert.equal(isInvoiceKey(null), false);
});

test('invoiceHtml renders the data and escapes every field', () => {
	const html = invoiceHtml({
		number: '1050',
		date: '2026-11-08',
		store: { name: 'Acme <Goods>', lines: ['1 Main St', 'Detroit MI'], email: 'shop@acme.test' },
		billing: { name: 'Jane "JJ" Doe', lines: ['42 Oak', ''], email: 'jane@x.test', phone: '555-1000' },
		items: [
			{ name: 'Widget & Co', qty: 2, total: '$40.00' },
			{ name: 'Gizmo', qty: 1, total: '$15.00' },
		],
		totals: [
			{ label: 'Subtotal', value: '$55.00' },
			{ label: 'Total', value: '$55.00' },
		],
		note: 'Thank you <3',
	});
	assert.match(html, /^<!doctype html>/);
	assert.match(html, /Invoice 1050/);
	// Data is present, escaped.
	assert.match(html, /Acme &lt;Goods&gt;/);
	assert.match(html, /Jane &quot;JJ&quot; Doe/);
	assert.match(html, /Widget &amp; Co/);
	assert.match(html, /Thank you &lt;3/);
	// No unescaped shopper markup leaked through.
	assert.ok(!html.includes('<Goods>'));
	assert.ok(!html.includes('"JJ"'));
	// An empty address line is dropped, not rendered as an empty div pair.
	assert.ok(!html.includes('<div></div>'));
});

test('invoiceHtml degrades on empty or absent data without throwing', () => {
	const html = invoiceHtml({});
	assert.match(html, /No line items\./);
	assert.match(html, /Invoice<\/h1>|Invoice/);
	assert.doesNotThrow(() => invoiceHtml(null));
	assert.doesNotThrow(() => invoiceHtml(undefined));
});

test('renderOpPlan builds HTML from structured invoice data', () => {
	const plan = renderOpPlan({ orderId: 7, invoice: { number: '7' } });
	assert.equal(plan.ok, true);
	assert.equal(plan.orderId, 7);
	assert.equal(plan.format, 'pdf');
	assert.equal(plan.contentType, 'application/pdf');
	assert.match(plan.html, /Invoice 7/);
});

test('renderOpPlan honours a raw html override and rejects an empty op', () => {
	const plan = renderOpPlan({ orderId: 9, html: '<p>hi</p>' });
	assert.equal(plan.ok, true);
	assert.equal(plan.html, '<p>hi</p>');
	assert.deepEqual(renderOpPlan({}), { ok: false, error: 'no invoice' });
	assert.deepEqual(renderOpPlan({ html: '   ' }), { ok: false, error: 'no invoice' });
	assert.deepEqual(renderOpPlan(null), { ok: false, error: 'bad op' });
});

test('hmac and the signature are deterministic for the same input', async () => {
	const a = await hmacHex('secret', 'invoices/1-ab.pdf:100');
	const b = await signDownload('secret', 'invoices/1-ab.pdf', 100);
	assert.equal(a, b);
	assert.equal(a.length, 64); // SHA-256 hex
	const c = await signDownload('other', 'invoices/1-ab.pdf', 100);
	assert.notEqual(a, c);
});

test('timingSafeEqualHex compares value and rejects a length mismatch', () => {
	assert.equal(timingSafeEqualHex('abcd', 'abcd'), true);
	assert.equal(timingSafeEqualHex('abcd', 'abce'), false);
	assert.equal(timingSafeEqualHex('abcd', 'abc'), false);
});

test('verifyDownload accepts a fresh valid token and rejects tampering or expiry', async () => {
	const secret = 'topsecret';
	const key = 'invoices/1234-abcdef01.pdf';
	const now = 1000;
	const exp = now + 500;
	const sig = await signDownload(secret, key, exp);
	assert.equal(await verifyDownload(secret, key, exp, sig, now), true);
	// Expired.
	assert.equal(await verifyDownload(secret, key, exp, sig, exp + 1), false);
	// Wrong secret.
	assert.equal(await verifyDownload('wrong', key, exp, sig, now), false);
	// Tampered key (and not a valid invoice key shape).
	assert.equal(await verifyDownload(secret, 'invoices/9999-abcdef01.pdf', exp, sig, now), false);
	assert.equal(await verifyDownload(secret, 'uploads/x', exp, sig, now), false);
	// Missing parts fail closed.
	assert.equal(await verifyDownload('', key, exp, sig, now), false);
	assert.equal(await verifyDownload(secret, key, exp, '', now), false);
});

test('download path round-trips through the query parser', () => {
	const key = 'invoices/1234-abcdef01.pdf';
	const path = invoiceDownloadPath(key, 1762600000, 'deadbeef');
	assert.match(path, /^\/skyphusion-invoice\?/);
	const u = new URL('https://x.test' + path);
	const q = parseDownloadQuery(u.searchParams);
	assert.equal(q.key, key);
	assert.equal(q.exp, '1762600000');
	assert.equal(q.sig, 'deadbeef');
	assert.deepEqual(parseDownloadQuery(new URLSearchParams()), { key: '', exp: '', sig: '' });
});
