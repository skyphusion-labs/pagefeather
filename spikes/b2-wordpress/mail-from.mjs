// Who a b-dosql site sends as. The address is MAIL_FROM when it is set.
// Otherwise it is wordpress@<the site host>, and only when that host can be a
// sending domain. workers.dev, localhost and the example names cannot, so a
// test deploy sends nothing until MAIL_FROM names an onboarded domain.
// The name "WooCommerce" is not a default: every store would look like the same
// sender. Set MAIL_FROM_NAME for a display name.

const UNDELIVERABLE = /(^|\.)(example|example\.(com|org|net)|invalid|test|localhost|workers\.dev)$/i;

export function undeliverable(email) {
	const domain = String(email || '').split('@')[1] || '';
	return !domain || UNDELIVERABLE.test(domain);
}

// Split a recipient list into the deliverable addresses and a count of the ones
// dropped because their domain cannot receive mail (example.com, workers.dev,
// localhost, .invalid, .test). b-dosql never hands such an address to
// env.EMAIL.send: it would bounce in the Email Sending log and can hang a manual
// /_runcron, and the seeded test admin is admin@example.com (#198).
export function deliverableRecipients(list) {
	const all = (Array.isArray(list) ? list : [list]).map((x) => String(x || '').trim()).filter(Boolean);
	const deliverable = all.filter((to) => !undeliverable(to));
	return { deliverable, dropped: all.length - deliverable.length };
}

export function resolveMailFrom(env) {
	const explicit = String((env && env.MAIL_FROM) || '').trim();
	if (explicit) return explicit;
	let host = '';
	try {
		host = new URL(String((env && env.SITE_ORIGIN) || '')).hostname.toLowerCase();
	} catch {
		host = '';
	}
	if (!host) return '';
	const derived = 'wordpress@' + host;
	return undeliverable(derived) ? '' : derived;
}

export function sender(env) {
	const email = resolveMailFrom(env);
	if (!email || undeliverable(email)) return null;
	const name = String((env && env.MAIL_FROM_NAME) || '').trim();
	return name ? { email, name } : { email };
}

// #1096: the address shape the send_email binding accepts. An EmailAddress object needs a STRING name, so { email } with
// no name was refused for every message ("Incorrect type for the 'name' field on 'EmailAddress'", measured on cf759hx):
// with a name it is { email, name }, without one the bare address string. sender() and replyTo() keep their { email }
// shape for the code that reads .email; this is applied where the message is built (index.js sendEmail).
export function bindingAddress(a) {
	if (!a || !a.email) return null;
	const name = typeof a.name === 'string' ? a.name.trim() : '';
	return name ? { email: a.email, name } : a.email;
}
// "Name <addr>" or a bare address, from one header value.
export function parseAddress(raw) {
	const s = String(raw || '').trim();
	const wrapped = s.match(/^(.*)<([^>]+)>\s*$/);
	if (wrapped) {
		const name = wrapped[1].replace(/^["'\s]+|["'\s]+$/g, '').trim();
		return { name, email: wrapped[2].trim() };
	}
	if (s.includes('@') && !s.includes(' ')) return { name: '', email: s };
	return null;
}

export function headerAddress(headers, name) {
	const lines = Array.isArray(headers) ? headers : String(headers || '').split(/\r?\n/);
	const re = new RegExp('^' + name + '\\s*:\\s*(.*)$', 'i');
	for (const line of lines) {
		const m = String(line).trim().match(re);
		if (m) return parseAddress(m[1]);
	}
	return null;
}

// Reply-To when WordPress asked for a different From. An address that cannot
// receive mail (example.com, workers.dev) is dropped.
export function replyTo(fromEmail, headers) {
	const reply = headerAddress(headers, 'reply-to');
	const asked = headerAddress(headers, 'from');
	const rt = reply || (asked && asked.email.toLowerCase() !== String(fromEmail).toLowerCase() ? asked : null);
	if (!rt || undeliverable(rt.email)) return null;
	if (rt.email.toLowerCase() === String(fromEmail).toLowerCase()) return null;
	return rt.name ? { email: rt.email, name: rt.name } : { email: rt.email };
}

function tomlString(value, label) {
	if (/["\\\r\n]/.test(value)) throw new Error(label + ' has a character a toml string cannot hold');
	return value;
}

// #1056: MAIL_ALLOWED_TO, a test site's destination allowlist (comma-separated, at most 10), the same rule as c1
// (deploy/variants/c1-config.sh). The binding then sends to those addresses only. It needs a sender: without one
// the site sends nothing, so an allowlist would be a setting that silently does nothing.
const ALLOWED_RE = /^[A-Za-z0-9._%+-]+@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
export function allowedTo(env) {
	const raw = String((env && env.MAIL_ALLOWED_TO) || '').trim();
	if (!raw) return [];
	const list = raw.split(',').map((x) => x.trim()).filter(Boolean);
	if (!list.length || list.length > 10 || !list.every((a) => ALLOWED_RE.test(a))) {
		throw new Error('MAIL_ALLOWED_TO must be 1 to 10 comma-separated email addresses');
	}
	return list;
}

// One send_email binding. Restricted to the resolved address when there is one, and to MAIL_ALLOWED_TO's
// destinations when it is set (#1056).
export function sendEmailBinding(env) {
	const email = resolveMailFrom(env);
	const to = allowedTo(env);
	if (!email) {
		if (to.length) throw new Error('MAIL_ALLOWED_TO needs MAIL_FROM (or a site host that can send): with no sender the site sends nothing');
		return 'send_email = [{ name = "EMAIL" }]';
	}
	const dest = to.length ? ', allowed_destination_addresses = [' + to.map((a) => '"' + tomlString(a, 'MAIL_ALLOWED_TO') + '"').join(', ') + ']' : '';
	return 'send_email = [{ name = "EMAIL", allowed_sender_addresses = ["' + tomlString(email, 'MAIL_FROM') + '"]' + dest + ' }]';
}

// Var lines for the generated wrangler config. Empty when there is no address.
// #1135: MAIL_ALLOWED_TO is rendered from allowedTo(env), the SAME list sendEmailBinding renders as
// allowed_destination_addresses, so the runtime pre-check and the binding cannot drift (tests/mail-from.test.mjs).
export function mailVarLines(env) {
	const email = resolveMailFrom(env);
	if (!email) return '';
	const lines = ['MAIL_FROM = "' + tomlString(email, 'MAIL_FROM') + '"'];
	const name = String((env && env.MAIL_FROM_NAME) || '').trim();
	if (name) lines.push('MAIL_FROM_NAME = "' + tomlString(name, 'MAIL_FROM_NAME') + '"');
	const to = allowedTo(env);
	if (to.length) lines.push('MAIL_ALLOWED_TO = "' + tomlString(to.join(','), 'MAIL_ALLOWED_TO') + '"');
	return lines.join('\n');
}

// #1135 (the lead's ruling (a)): which recipients can be sent at all, decided inside wp_mail in 0 ms, before anything
// is queued (so #368's HOLD still decides at the request end). Refused: #198's undeliverable domains, and, when the
// MAIL_ALLOWED_TO var is set (rendered with the binding, mailVarLines), an address outside it: the binding would refuse
// it ("email to ... not allowed", measured on cf759hx). A malformed runtime list fails OPEN (the binding still guards).
export const REASON_UNDELIVERABLE = 'undeliverable recipient domain (#198)';
export const REASON_NOT_ALLOWED = 'email to [address] not allowed';
export function precheckRecipients(env, list) {
	const all = (Array.isArray(list) ? list : [list]).map((x) => String(x || '').trim()).filter(Boolean);
	let allow = null;
	try { const l = allowedTo(env); if (l.length) allow = new Set(l.map((a) => a.toLowerCase())); } catch { allow = null; }
	const send = [], refused = [];
	for (const to of all) {
		const addr = (to.match(/<([^>]+)>/) || [null, to])[1].trim();
		if (undeliverable(addr)) refused.push({ to, why: 'undeliverable' });
		else if (allow && !allow.has(addr.toLowerCase())) refused.push({ to, why: 'not-allowed' });
		else send.push(to);
	}
	const reason = refused.some((r) => r.why === 'not-allowed') ? REASON_NOT_ALLOWED : refused.length ? REASON_UNDELIVERABLE : null;
	return { send, refused, reason };
}

const invoked = process.argv[1] && process.argv[1].endsWith('mail-from.mjs');
if (invoked) {
	try {
		if (process.argv.includes('--binding')) process.stdout.write(sendEmailBinding(process.env) + '\n');
		else if (process.argv.includes('--vars')) {
			const lines = mailVarLines(process.env);
			process.stdout.write(lines ? lines + '\n' : '');
		} else process.stdout.write(resolveMailFrom(process.env));
	} catch (e) {
		console.error(String((e && e.message) || e));
		process.exit(1);
	}
}
