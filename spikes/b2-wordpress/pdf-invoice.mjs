// Pure helpers for the Browser Rendering PDF-invoice op (issue #227, part of #201).
// index.js imports these for browserRenderOp and the config gate;
// tests/pdf-invoice.test.mjs tests them. No side effects and no Worker runtime, so
// both can import without a browser or a binding.

// Whether index.js should inject define('SKYPHUSION_PDF_INVOICE', true): the DO
// profile (PHP and the database in the Durable Object), the MEDIA bucket to store
// the PDF, and the Browser Rendering binding all present, and PDF_INVOICE not turned
// off. Default on when the bindings are present, off otherwise, so a site without the
// Browser Rendering binding never renders anything.
export function pdfInvoiceEnabled(env) {
	return !!(
		env &&
		env.PHP_IN_DO === 'on' &&
		env.DB_IN_DO === 'on' &&
		env.MEDIA &&
		env.BROWSER &&
		env.PDF_INVOICE !== 'off'
	);
}

// HTML-escape a value for safe interpolation into the invoice document. Every field
// comes from order data a shopper controls (names, addresses, product titles), so it
// is escaped here, in one place, before it reaches the rendered page.
export function escapeHtml(value) {
	return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
		'&': '&amp;',
		'<': '&lt;',
		'>': '&gt;',
		'"': '&quot;',
		"'": '&#39;',
	})[c]);
}

// Lower-case hex of a byte array (for the random key component and HMAC output).
export function bytesToHex(bytes) {
	let s = '';
	for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
	return s;
}

// The R2 object key for an order's invoice PDF. A fixed private prefix, the order id
// and a random component (supplied by the caller from crypto), so the key cannot be
// guessed from the order number alone. The id is sanitized to a safe key charset.
export function invoiceKey(orderId, rand) {
	const id = String(orderId == null ? '' : orderId).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || '0';
	const r = String(rand == null ? '' : rand).replace(/[^a-f0-9]/gi, '').toLowerCase().slice(0, 32);
	return `invoices/${id}-${r}.pdf`;
}

// Only keys under the invoices/ prefix are ever served by the download route, so a
// valid signature can never be made to stream some other R2 object.
export function isInvoiceKey(key) {
	return typeof key === 'string' && /^invoices\/[A-Za-z0-9_-]+-[a-f0-9]+\.pdf$/.test(key);
}

// A table of amount rows (label, value), each already a formatted money string from
// PHP (WooCommerce formats in the store's currency and locale). Pure string work.
function amountRows(rows) {
	if (!Array.isArray(rows)) return '';
	return rows
		.filter((r) => r && typeof r === 'object')
		.map((r) => `<tr><th>${escapeHtml(r.label)}</th><td>${escapeHtml(r.value)}</td></tr>`)
		.join('');
}

function itemRows(items) {
	if (!Array.isArray(items) || items.length === 0) {
		return '<tr><td colspan="3" class="muted">No line items.</td></tr>';
	}
	return items
		.filter((it) => it && typeof it === 'object')
		.map(
			(it) =>
				`<tr><td>${escapeHtml(it.name)}</td>` +
				`<td class="num">${escapeHtml(it.qty)}</td>` +
				`<td class="num">${escapeHtml(it.total)}</td></tr>`
		)
		.join('');
}

function addressBlock(lines) {
	if (!Array.isArray(lines)) return '';
	return lines
		.map((l) => String(l == null ? '' : l).trim())
		.filter((l) => l !== '')
		.map((l) => `<div>${escapeHtml(l)}</div>`)
		.join('');
}

// Build a self-contained invoice HTML document from structured order data. All CSS is
// inline (the renderer loads nothing external); print to A4. The invoice object:
//   { store:{name,lines[],email}, number, date, billing:{name,lines[],email,phone},
//     items:[{name,qty,total}], totals:[{label,value}], note }
// Every field is escaped. Missing fields degrade to empty, never throw.
export function invoiceHtml(invoice) {
	const inv = invoice && typeof invoice === 'object' ? invoice : {};
	const store = inv.store && typeof inv.store === 'object' ? inv.store : {};
	const billing = inv.billing && typeof inv.billing === 'object' ? inv.billing : {};
	const title = `Invoice ${escapeHtml(inv.number)}`.trim();
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body { font: 13px/1.5 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #1a1a1a; padding: 40px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .muted { color: #666; }
  .num { text-align: right; white-space: nowrap; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 28px; }
  .store { text-align: right; }
  .store .name { font-weight: 600; }
  .meta { margin: 0 0 24px; }
  .parties { display: flex; gap: 40px; margin-bottom: 24px; }
  .parties h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: #666; margin: 0 0 6px; }
  table { width: 100%; border-collapse: collapse; }
  .items th, .items td { padding: 8px 10px; border-bottom: 1px solid #e3e3e3; text-align: left; }
  .items thead th { border-bottom: 2px solid #1a1a1a; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
  .totals { width: 280px; margin-left: auto; margin-top: 10px; }
  .totals th { text-align: left; padding: 5px 10px; font-weight: 400; color: #444; }
  .totals td { text-align: right; padding: 5px 10px; white-space: nowrap; }
  .totals tr:last-child th, .totals tr:last-child td { font-weight: 700; border-top: 2px solid #1a1a1a; }
  .note { margin-top: 32px; padding-top: 16px; border-top: 1px solid #e3e3e3; color: #444; }
</style>
</head>
<body>
  <div class="head">
    <div>
      <h1>${title || 'Invoice'}</h1>
      <div class="meta muted">${escapeHtml(inv.date)}</div>
    </div>
    <div class="store">
      <div class="name">${escapeHtml(store.name)}</div>
      ${addressBlock(store.lines)}
      ${store.email ? `<div class="muted">${escapeHtml(store.email)}</div>` : ''}
    </div>
  </div>
  <div class="parties">
    <div>
      <h2>Billed to</h2>
      <div>${escapeHtml(billing.name)}</div>
      ${addressBlock(billing.lines)}
      ${billing.email ? `<div class="muted">${escapeHtml(billing.email)}</div>` : ''}
      ${billing.phone ? `<div class="muted">${escapeHtml(billing.phone)}</div>` : ''}
    </div>
  </div>
  <table class="items">
    <thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Total</th></tr></thead>
    <tbody>${itemRows(inv.items)}</tbody>
  </table>
  <table class="totals">${amountRows(inv.totals)}</table>
  ${inv.note ? `<div class="note">${escapeHtml(inv.note)}</div>` : ''}
</body>
</html>`;
}

// Shape and validate the browserRender op into a render plan, or an error. PHP sends
// structured invoice data (op.invoice); a raw op.html is honoured too (a test or a
// future card), and takes precedence. Pure: no binding, no I/O.
export function renderOpPlan(op) {
	if (!op || typeof op !== 'object') return { ok: false, error: 'bad op' };
	let html;
	if (typeof op.html === 'string' && op.html.trim() !== '') {
		html = op.html;
	} else if (op.invoice && typeof op.invoice === 'object') {
		html = invoiceHtml(op.invoice);
	} else {
		return { ok: false, error: 'no invoice' };
	}
	return { ok: true, orderId: op.orderId, html, format: 'pdf', contentType: 'application/pdf' };
}

// HMAC-SHA256 hex over a message with a secret, using Web Crypto (present in Workers
// and in Node's global crypto). Async.
export async function hmacHex(secret, message) {
	const enc = new TextEncoder();
	const key = await crypto.subtle.importKey(
		'raw',
		enc.encode(String(secret == null ? '' : secret)),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const sig = await crypto.subtle.sign('HMAC', key, enc.encode(String(message == null ? '' : message)));
	return bytesToHex(new Uint8Array(sig));
}

// The signature binding an invoice key to an expiry. The secret stays in the Worker,
// so PHP can relay the signed URL but can never mint one.
export async function signDownload(secret, key, exp) {
	return hmacHex(secret, `${key}:${exp}`);
}

// Constant-time compare of two equal-length hex strings (the signature check must not
// leak timing). Unequal lengths are an immediate mismatch.
export function timingSafeEqualHex(a, b) {
	const x = String(a);
	const y = String(b);
	if (x.length !== y.length) return false;
	let diff = 0;
	for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
	return diff === 0;
}

// Verify a download: a non-expired, correctly-signed invoice key. now is epoch
// seconds (the caller passes Date.now()/1000). Fails closed on any missing part.
export async function verifyDownload(secret, key, exp, sig, now) {
	if (!secret || !isInvoiceKey(key) || !sig) return false;
	const e = Number(exp);
	if (!Number.isFinite(e) || e < (Number(now) || 0)) return false;
	const expected = await signDownload(secret, key, e);
	return timingSafeEqualHex(expected, sig);
}

// The relative download URL PHP stores and surfaces (order email, My Account). The
// Worker serves it from R2 after verifying the signature; the path is outside /_ so it
// needs no spike token.
export function invoiceDownloadPath(key, exp, sig) {
	const p = new URLSearchParams({ k: String(key), e: String(exp), s: String(sig) });
	return `/skyphusion-invoice?${p.toString()}`;
}

// Pull the three download parameters out of a URLSearchParams (the route then verifies).
export function parseDownloadQuery(searchParams) {
	return {
		key: (searchParams && searchParams.get('k')) || '',
		exp: (searchParams && searchParams.get('e')) || '',
		sig: (searchParams && searchParams.get('s')) || '',
	};
}
