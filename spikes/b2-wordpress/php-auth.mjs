// #761: Apache with mod_php sets PHP_AUTH_USER and PHP_AUTH_PW from
// Authorization: Basic before PHP runs. php-wasm only copies that header to
// HTTP_AUTHORIZATION, so WordPress application passwords and WooCommerce keys
// in the Basic header fail closed, the same as a request with no credentials.
//
// Decode the token, then split on the first colon (the password may contain
// colons). A Bearer header, bad base64, or a value with no colon sets nothing
// and does not throw. Nothing here logs the header or the decoded values.

const INSTALLED = Symbol('pfPhpBasicAuth');

function authorizationValue(headers) {
	if (typeof headers === 'string') return headers;
	if (!headers || typeof headers !== 'object') return null;
	if (typeof headers.get === 'function') {
		const value = headers.get('authorization');
		return typeof value === 'string' ? value : null;
	}
	for (const key of Object.keys(headers)) {
		if (String(key).toLowerCase() === 'authorization') {
			const value = headers[key];
			return typeof value === 'string' ? value : null;
		}
	}
	return null;
}

// Strict enough that a bad token does not become a user. atob accepts some
// short strings; the re-encode drops those. A failed decode returns null.
function decodeBasic(token) {
	if (typeof token !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(token)) return null;
	if (token.length % 4 === 1) return null;
	let decoded;
	try {
		decoded = atob(token);
	} catch {
		return null;
	}
	let again;
	try {
		again = btoa(decoded);
	} catch {
		return null;
	}
	if (again.replace(/=+$/, '') !== token.replace(/=+$/, '')) return null;
	const colon = decoded.indexOf(':');
	if (colon < 0) return null;
	return { PHP_AUTH_USER: decoded.slice(0, colon), PHP_AUTH_PW: decoded.slice(colon + 1) };
}

// headers: a Fetch Headers, a plain object, or the header value itself.
// Returns { PHP_AUTH_USER, PHP_AUTH_PW } or null. Never throws.
export function phpBasicAuthEntries(headers) {
	try {
		const raw = authorizationValue(headers);
		if (typeof raw !== 'string') return null;
		const match = /^basic\s+(\S+)\s*$/i.exec(raw.trim());
		if (!match) return null;
		return decodeBasic(match[1]);
	} catch {
		return null;
	}
}

// A PHP run request. Keeps headers (so HTTP_AUTHORIZATION still arrives) and
// merges the two $_SERVER entries. Returns the same object when there is
// nothing to add.
export function applyPhpBasicAuth(request) {
	if (!request || typeof request !== 'object') return request;
	const entries = phpBasicAuthEntries(request.headers);
	if (!entries) return request;
	const prev = request.$_SERVER;
	const base = prev && typeof prev === 'object' && !Array.isArray(prev) ? prev : {};
	return { ...request, $_SERVER: { ...base, ...entries } };
}

// One runtime serves the object and approach A's Worker. Wrap its runStream,
// which is where php-wasm builds $_SERVER for every PHP request.
export function installPhpBasicAuth(php) {
	if (!php || typeof php !== 'object' || typeof php.runStream !== 'function' || php[INSTALLED]) return php;
	const orig = php.runStream;
	php.runStream = function (request) {
		return orig.call(this, applyPhpBasicAuth(request));
	};
	php[INSTALLED] = true;
	return php;
}
