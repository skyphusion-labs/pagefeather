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

// One send_email binding. Restricted to the resolved address when there is one.
export function sendEmailBinding(env) {
	const email = resolveMailFrom(env);
	if (!email) return 'send_email = [{ name = "EMAIL" }]';
	return 'send_email = [{ name = "EMAIL", allowed_sender_addresses = ["' + tomlString(email, 'MAIL_FROM') + '"] }]';
}

// Var lines for the generated wrangler config. Empty when there is no address.
export function mailVarLines(env) {
	const email = resolveMailFrom(env);
	if (!email) return '';
	const lines = ['MAIL_FROM = "' + tomlString(email, 'MAIL_FROM') + '"'];
	const name = String((env && env.MAIL_FROM_NAME) || '').trim();
	if (name) lines.push('MAIL_FROM_NAME = "' + tomlString(name, 'MAIL_FROM_NAME') + '"');
	return lines.join('\n');
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
