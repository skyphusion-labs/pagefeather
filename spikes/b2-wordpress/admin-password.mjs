// #1375: set one user's password on an installed site.
// The password arrives in a header and is handed to PHP as a file.
// It is not placed in the PHP source, a log line, or the response.
export const ADMIN_PASSWORD_PATH = '/_admin-password';
export const ADMIN_PASSWORD_FILE = '/tmp/admin-password';
export const ADMIN_USER_FILE = '/tmp/admin-user';
export const PASSWORD_HEADER = 'x-admin-password';
export const USER_HEADER = 'x-admin-user';

const REFUSAL = {
	'not-installed': 409,
	'password-too-short': 400,
	'user-not-found': 404,
};

// WordPress's own wp_set_password(), after is_blog_installed() and a login lookup.
// WP_INSTALLING matches /_install: without it, an uninstalled site dies inside
// wp-load with an install redirect and this script never answers.
export function adminPasswordPhp() {
	return `<?php
define( 'WP_INSTALLING', true );
require '/wordpress/wp-load.php';
$pw = (string) @file_get_contents( '${ADMIN_PASSWORD_FILE}' );
@unlink( '${ADMIN_PASSWORD_FILE}' );
$login = trim( (string) @file_get_contents( '${ADMIN_USER_FILE}' ) );
@unlink( '${ADMIN_USER_FILE}' );
if ( $login === '' ) { $login = 'admin'; }
if ( ! is_blog_installed() ) {
	echo json_encode( array( 'ok' => false, 'user' => $login, 'error' => 'not-installed' ) );
	exit;
}
if ( strlen( $pw ) < 12 ) {
	echo json_encode( array( 'ok' => false, 'user' => $login, 'error' => 'password-too-short' ) );
	exit;
}
if ( strlen( $login ) > 60 || ! preg_match( '/^[A-Za-z0-9 _.@-]+$/', $login ) ) {
	echo json_encode( array( 'ok' => false, 'user' => null, 'error' => 'user-not-found' ) );
	exit;
}
$u = get_user_by( 'login', $login );
if ( ! $u || ! isset( $u->ID ) ) {
	echo json_encode( array( 'ok' => false, 'user' => $login, 'error' => 'user-not-found' ) );
	exit;
}
wp_set_password( $pw, $u->ID );
echo json_encode( array( 'ok' => true, 'user' => $login ) );
`;
}

function loginFrom(req) {
	const raw = req.headers.get(USER_HEADER);
	const login = raw == null ? '' : String(raw).trim();
	return login === '' ? 'admin' : login;
}

function tryParse(text) {
	try {
		const j = JSON.parse(text);
		if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
		return j;
	} catch {
		return null;
	}
}

// Copy only ok, user, and a known error. Anything else in the PHP text is dropped,
// so a notice or an extra field cannot carry the password out.
function parseOut(text, login) {
	const raw = String(text ?? '').trim();
	let j = tryParse(raw);
	if (!j) {
		const a = raw.indexOf('{');
		const b = raw.lastIndexOf('}');
		if (a >= 0 && b > a) j = tryParse(raw.slice(a, b + 1));
	}
	if (!j) return null;
	if (j.ok === true && j.user === login) return { ok: true, user: login };
	if (j.ok !== false || !Object.prototype.hasOwnProperty.call(REFUSAL, j.error)) return null;
	if (j.error === 'user-not-found') {
		if (j.user !== login && j.user !== null) return null;
		return { ok: false, user: j.user === null ? null : login, error: j.error };
	}
	if (j.user !== login) return null;
	return { ok: false, user: login, error: j.error };
}

function wipe(php) {
	try { php.writeFile(ADMIN_PASSWORD_FILE, ''); } catch { /* the file is inside the runtime */ }
	try { php.writeFile(ADMIN_USER_FILE, ''); } catch { /* same */ }
}

function json(body, status) {
	return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

// spikeOk false is the same refusal the /_ gate already returned: 403 forbidden.
export async function adminPasswordRoute({ req, spikeOk, php }) {
	if (!spikeOk) return new Response('forbidden', { status: 403 });
	if (req.method !== 'POST') return new Response('method', { status: 405 });
	const header = req.headers.get(PASSWORD_HEADER);
	const pw = header == null ? '' : String(header);
	const login = loginFrom(req);
	php.writeFile(ADMIN_PASSWORD_FILE, pw);
	php.writeFile(ADMIN_USER_FILE, login);
	let text = '';
	try {
		const r = await php.run({ code: adminPasswordPhp() });
		text = r && r.text != null ? String(r.text) : '';
	} catch {
		console.log(JSON.stringify({ m: 'admin-password', ok: false }));
		return json({ ok: false, user: login, error: 'php' }, 500);
	} finally {
		wipe(php);
	}
	const parsed = parseOut(text, login);
	if (!parsed) {
		console.log(JSON.stringify({ m: 'admin-password', ok: false, error: 'bad-json' }));
		return json({ ok: false, user: login, error: 'bad-json' }, 500);
	}
	if (parsed.ok) return json({ ok: true, user: parsed.user }, 200);
	return json({ ok: false, user: parsed.user, error: parsed.error }, REFUSAL[parsed.error]);
}
