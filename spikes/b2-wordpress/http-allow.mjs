// Hosts PHP's wp_remote_*() may call. Unset uses the default list. An empty
// list denies every host. "*" allows every http(s) host. A leading dot matches
// that name and its subdomains (.wordpress.org matches api.wordpress.org and
// wordpress.org). Anything else is one host.
//
// The site's own host is refused separately: the PHP object runs one request
// at a time, so a request to itself would wait on itself. Payment and other
// plugin hosts are not in the default. Add them by setting HTTP_ALLOW_HOSTS
// to the whole list, including the WordPress hosts the site still needs.

export const DEFAULT_HTTP_ALLOW_HOSTS = '.wordpress.org,.woocommerce.com,.gravatar.com';

export function resolveHttpAllowHosts(value) {
	if (value === undefined || value === null) return DEFAULT_HTTP_ALLOW_HOSTS;
	return String(value);
}

export function httpHostAllowed(hostname, list) {
	const host = String(hostname || '').toLowerCase();
	const items = String(list == null ? '' : list).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
	if (!items.length) return false;
	if (items.includes('*')) return true;
	return items.some((item) => {
		if (item.startsWith('.')) return host === item.slice(1) || host.endsWith(item);
		return host === item;
	});
}

function tomlString(value) {
	if (/["\\\r\n]/.test(value)) throw new Error('HTTP_ALLOW_HOSTS has a character a toml string cannot hold');
	return value;
}

// The list a generated wrangler config should set. Unset in the environment
// means the default. Set, including empty, is kept.
export function configuredHttpAllowHosts(env) {
	if (!env || !Object.prototype.hasOwnProperty.call(env, 'HTTP_ALLOW_HOSTS')) return DEFAULT_HTTP_ALLOW_HOSTS;
	return tomlString(resolveHttpAllowHosts(env.HTTP_ALLOW_HOSTS));
}

const invoked = process.argv[1] && process.argv[1].endsWith('http-allow.mjs');
if (invoked) {
	try {
		process.stdout.write(configuredHttpAllowHosts(process.env));
	} catch (e) {
		console.error(String((e && e.message) || e));
		process.exit(1);
	}
}
