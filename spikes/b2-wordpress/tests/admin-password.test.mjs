// #1375: POST /_admin-password sets a user's password on an installed site.
// The password is a header. It is never a URL, a log line, or the answer.
//   node --test spikes/b2-wordpress/tests/admin-password.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
	ADMIN_PASSWORD_FILE,
	ADMIN_PASSWORD_PATH,
	ADMIN_USER_FILE,
	PASSWORD_HEADER,
	USER_HEADER,
	adminPasswordPhp,
	adminPasswordRoute,
} from '../admin-password.mjs';

const PW = 'p@ss"w0rd-1375';
const URL_PW = 'url-secret-should-not-be-used';

const STUBS = `<?php
error_reporting(E_ERROR | E_PARSE);
ini_set('display_errors', '0');
$GLOBALS['pf_calls'] = array();
function is_blog_installed() {
	$GLOBALS['pf_calls'][] = array( 'is_blog_installed' );
	return getenv( 'PF_INSTALLED' ) === '1';
}
function get_user_by( $field, $login ) {
	$GLOBALS['pf_calls'][] = array( 'get_user_by', $field, $login );
	$want = getenv( 'PF_USER' );
	if ( is_string( $want ) && $want !== '' && $login === $want ) {
		return (object) array( 'ID' => (int) getenv( 'PF_USER_ID' ) );
	}
	return false;
}
function wp_set_password( $password, $user_id ) {
	$GLOBALS['pf_calls'][] = array( 'wp_set_password', $password, $user_id );
}
register_shutdown_function( function () {
	file_put_contents( getenv( 'PF_CALLS' ), json_encode( $GLOBALS['pf_calls'] ) );
} );
`;

function consoleLogArgs(src) {
	const args = [];
	let i = 0;
	while ((i = src.indexOf('console.log', i)) !== -1) {
		const start = src.indexOf('(', i);
		let depth = 0;
		let j = start;
		for (; j < src.length; j++) {
			if (src[j] === '(') depth++;
			else if (src[j] === ')') {
				depth--;
				if (depth === 0) {
					args.push(src.slice(start + 1, j));
					break;
				}
			}
		}
		i = j + 1;
	}
	return args;
}

// Run the shipped PHP with WordPress stubbed out. The requires stay in the
// source the Worker runs. Here they are removed so the CLI can execute the
// same checks and the same wp_set_password call.
function runSnippet(code, files, env) {
	const dir = mkdtempSync(join(tmpdir(), 'pf1375-'));
	try {
		const pwPath = join(dir, 'pw');
		const userPath = join(dir, 'user');
		const callsPath = join(dir, 'calls.json');
		writeFileSync(pwPath, files.get(ADMIN_PASSWORD_FILE) ?? '');
		writeFileSync(userPath, files.get(ADMIN_USER_FILE) ?? '');
		let body = code.replace(/^<\?php\s*/, '');
		body = body.replaceAll("require '/wordpress/wp-load.php';", '');
		body = body.replaceAll("require_once ABSPATH . 'wp-admin/includes/upgrade.php';", '');
		body = body.replaceAll(ADMIN_PASSWORD_FILE, pwPath);
		body = body.replaceAll(ADMIN_USER_FILE, userPath);
		const script = join(dir, 'run.php');
		writeFileSync(script, STUBS + body);
		const r = spawnSync('php', [script], {
			encoding: 'utf8',
			env: { ...process.env, PF_CALLS: callsPath, ...env },
		});
		let calls = [];
		try { calls = JSON.parse(readFileSync(callsPath, 'utf8')); } catch { calls = []; }
		return { status: r.status, stdout: r.stdout, stderr: r.stderr, calls };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function fakePhp(env) {
	const files = new Map();
	const writes = [];
	const runs = [];
	return {
		files,
		writes,
		runs,
		calls: [],
		writeFile(path, data) {
			writes.push([path, String(data)]);
			files.set(path, String(data));
		},
		async run({ code }) {
			runs.push(code);
			// The route wipes the files after this returns. Copy them now.
			const snap = new Map(files);
			const out = runSnippet(code, snap, env);
			if (out.status !== 0) {
				throw new Error('php ' + out.status + ' ' + out.stderr);
			}
			this.calls = out.calls;
			return { text: out.stdout, errors: out.stderr };
		},
	};
}

function post(headers, url = 'https://shop.example' + ADMIN_PASSWORD_PATH) {
	return new Request(url, { method: 'POST', headers });
}

async function route(php, headers, extra = {}) {
	const logs = [];
	const orig = console.log;
	console.log = (...a) => { logs.push(a.map(String).join(' ')); };
	try {
		const res = await adminPasswordRoute({ req: post(headers, extra.url), spikeOk: extra.spikeOk !== false, php, ...extra.route });
		const text = await res.text();
		return { res, text, logs, php };
	} finally {
		console.log = orig;
	}
}

function jsonOf(text) {
	return JSON.parse(text);
}

test('#1375 no token is the existing refusal, and PHP does not run', async () => {
	const php = fakePhp({ PF_INSTALLED: '1', PF_USER: 'admin', PF_USER_ID: '1' });
	const logs = [];
	const orig = console.log;
	console.log = (...a) => { logs.push(a.map(String).join(' ')); };
	try {
		const res = await adminPasswordRoute({
			req: post({ [PASSWORD_HEADER]: PW }),
			spikeOk: false,
			php,
		});
		assert.equal(res.status, 403);
		assert.equal(await res.text(), 'forbidden');
	} finally {
		console.log = orig;
	}
	assert.equal(php.runs.length, 0);
	assert.equal(php.writes.length, 0);
	assert.equal(logs.some((l) => l.includes(PW)), false);
});

test('#1375 a site that is not installed is refused before any password is set', async () => {
	const php = fakePhp({ PF_INSTALLED: '0', PF_USER: 'admin', PF_USER_ID: '1' });
	const { res, text, logs } = await route(php, { [PASSWORD_HEADER]: PW });
	assert.equal(res.status, 409);
	assert.deepEqual(jsonOf(text), { ok: false, user: 'admin', error: 'not-installed' });
	assert.equal(text.includes(PW), false);
	assert.equal(logs.some((l) => l.includes(PW)), false);
	assert.equal(php.runs.length, 1);
	assert.deepEqual(php.calls, [['is_blog_installed']]);
});

test('#1375 an unknown user is refused', async () => {
	const env = { PF_INSTALLED: '1', PF_USER: 'admin', PF_USER_ID: '4' };
	const php = fakePhp(env);
	const { res, text, logs } = await route(php, { [PASSWORD_HEADER]: PW, [USER_HEADER]: 'no-such' });
	assert.equal(res.status, 404);
	assert.deepEqual(jsonOf(text), { ok: false, user: 'no-such', error: 'user-not-found' });
	assert.equal(text.includes(PW), false);
	assert.equal(logs.some((l) => l.includes(PW)), false);
	assert.deepEqual(php.calls, [
		['is_blog_installed'],
		['get_user_by', 'login', 'no-such'],
	]);
});

test('#1375 a password shorter than 12 characters is refused', async () => {
	const short = 'abcdefghijk';
	assert.equal(short.length, 11);
	const env = { PF_INSTALLED: '1', PF_USER: 'admin', PF_USER_ID: '4' };
	const php = fakePhp(env);
	const { res, text, logs } = await route(php, { [PASSWORD_HEADER]: short });
	assert.equal(res.status, 400);
	assert.deepEqual(jsonOf(text), { ok: false, user: 'admin', error: 'password-too-short' });
	assert.equal(text.includes(short), false);
	assert.equal(logs.some((l) => l.includes(short)), false);
	assert.deepEqual(php.calls, [['is_blog_installed']]);
});

test('#1375 success calls wp_set_password with the given value', async () => {
	const env = { PF_INSTALLED: '1', PF_USER: 'admin', PF_USER_ID: '4' };
	const php = fakePhp(env);
	const { res, text, logs } = await route(php, { [PASSWORD_HEADER]: PW });
	assert.equal(res.status, 200);
	assert.deepEqual(jsonOf(text), { ok: true, user: 'admin' });
	assert.deepEqual(Object.keys(jsonOf(text)).sort(), ['ok', 'user']);
	assert.equal(text.includes(PW), false);
	assert.equal(logs.some((l) => l.includes(PW)), false);
	assert.equal(php.runs[0].includes(PW), false, 'the password is not in the PHP source');
	assert.equal(php.writes.some(([p, d]) => p === ADMIN_PASSWORD_FILE && d === PW), true);
	assert.equal(php.files.get(ADMIN_PASSWORD_FILE), '', 'the file is wiped after the run');
	assert.deepEqual(php.calls, [
		['is_blog_installed'],
		['get_user_by', 'login', 'admin'],
		['wp_set_password', PW, 4],
	]);
	const exact = 'abcdefghijkl';
	assert.equal(exact.length, 12);
	const php12 = fakePhp(env);
	const ok12 = await route(php12, { [PASSWORD_HEADER]: exact });
	assert.equal(ok12.res.status, 200, ok12.text);
	assert.deepEqual(php12.calls.at(-1), ['wp_set_password', exact, 4]);
});

test('#1375 the user header selects the login, and the default is admin', async () => {
	const env = { PF_INSTALLED: '1', PF_USER: 'editor', PF_USER_ID: '9' };
	const php = fakePhp(env);
	const { res, text } = await route(php, { [PASSWORD_HEADER]: PW, [USER_HEADER]: ' editor ' });
	assert.equal(res.status, 200);
	assert.deepEqual(jsonOf(text), { ok: true, user: 'editor' });
	const files = new Map();
	for (const [p, d] of php.writes) if (!files.has(p)) files.set(p, d);
	assert.equal(files.get(ADMIN_USER_FILE), 'editor');
	assert.deepEqual(php.calls.at(-1), ['wp_set_password', PW, 9]);

	const phpDefault = fakePhp({ PF_INSTALLED: '1', PF_USER: 'admin', PF_USER_ID: '1' });
	await route(phpDefault, { [PASSWORD_HEADER]: PW });
	const firstUser = phpDefault.writes.find(([p]) => p === ADMIN_USER_FILE);
	assert.deepEqual(firstUser, [ADMIN_USER_FILE, 'admin']);
});

test('#1375 a password in the URL is ignored', async () => {
	const env = { PF_INSTALLED: '1', PF_USER: 'admin', PF_USER_ID: '4' };
	const php = fakePhp(env);
	const url = 'https://shop.example' + ADMIN_PASSWORD_PATH + '?x-admin-password=' + encodeURIComponent(URL_PW);
	const { res, text, logs } = await route(php, { [PASSWORD_HEADER]: PW }, { url });
	assert.equal(res.status, 200);
	assert.equal(text.includes(URL_PW), false);
	assert.equal(logs.some((l) => l.includes(URL_PW)), false);
	assert.equal(php.runs[0].includes(URL_PW), false);
	const files = new Map();
	for (const [p, d] of php.writes) if (!files.has(p)) files.set(p, d);
	assert.equal(files.get(ADMIN_PASSWORD_FILE), PW);
	assert.deepEqual(php.calls.at(-1), ['wp_set_password', PW, 4]);
	assert.equal(JSON.stringify(php.calls).includes(URL_PW), false);
});

test('#1375 a PHP failure does not log or return the password', async () => {
	const php = {
		writes: [],
		runs: [],
		files: new Map(),
		writeFile(path, data) { this.writes.push([path, String(data)]); this.files.set(path, String(data)); },
		async run() { throw new Error('runtime said ' + PW); },
	};
	const { res, text, logs } = await route(php, { [PASSWORD_HEADER]: PW });
	assert.equal(res.status, 500);
	assert.equal(text.includes(PW), false);
	assert.deepEqual(jsonOf(text), { ok: false, user: 'admin', error: 'php' });
	assert.equal(logs.some((l) => l.includes(PW)), false);
	assert.equal(php.files.get(ADMIN_PASSWORD_FILE), '');
});

test('#1375 a raw PHP answer that echoes the password is not forwarded', async () => {
	const php = {
		writes: [],
		files: new Map(),
		writeFile(path, data) { this.writes.push([path, String(data)]); this.files.set(path, String(data)); },
		async run() { return { text: JSON.stringify({ ok: true, user: 'admin', leak: PW }) }; },
	};
	const { res, text, logs } = await route(php, { [PASSWORD_HEADER]: PW });
	assert.equal(res.status, 200);
	assert.deepEqual(jsonOf(text), { ok: true, user: 'admin' });
	assert.equal(text.includes(PW), false);
	assert.equal(logs.some((l) => l.includes(PW)), false);
});

test('#1375 source: the password value is in no log line, and the script calls wp_set_password', () => {
	const src = readFileSync(new URL('../admin-password.mjs', import.meta.url), 'utf8');
	const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	for (const arg of consoleLogArgs(src)) {
		assert.equal(/\bpw\b/.test(arg), false, arg);
		assert.equal(arg.includes('$pw'), false, arg);
		assert.equal(arg.includes('x-admin-password'), false, arg);
		assert.equal(arg.includes(PW), false, arg);
	}
	assert.equal(src.includes('searchParams'), false, 'the password is not read from the URL');
	const php = adminPasswordPhp();
	assert.match(php, /require '\/wordpress\/wp-load\.php'/);
	assert.match(php, /define\(\s*'WP_INSTALLING',\s*true\s*\)/);
	assert.match(php, /is_blog_installed\(\)/);
	assert.match(php, /get_user_by\(\s*'login',\s*\$login\s*\)/);
	assert.match(php, /wp_set_password\(\s*\$pw,\s*\$u->ID\s*\)/);
	assert.doesNotMatch(php, /echo[^;]*\$pw/);
	assert.doesNotMatch(php, /error_log/);
	assert.doesNotMatch(php, /json_encode\([^)]*\$pw/);
	assert.equal(php.includes(PW), false);
	const routeAt = index.indexOf('url.pathname === ADMIN_PASSWORD_PATH');
	assert.ok(routeAt > 0, 'index.js handles the route');
	const installAt = index.indexOf("if (url.pathname === '/_install')");
	const block = index.slice(routeAt, installAt);
	assert.equal(block.includes('console.log'), false);
	const gate = "if (url.pathname.startsWith('/_') && !spikeOk) return new Response('forbidden', { status: 403 });";
	const gates = [];
	let from = 0;
	while (true) {
		const at = index.indexOf(gate, from);
		if (at < 0) break;
		gates.push(at);
		from = at + 1;
	}
	assert.equal(gates.length, 2, 'the worker and the object each keep the existing gate');
	assert.ok(gates.every((at) => at < routeAt), 'no token or a wrong token is refused before this route');
	const handleInner = index.indexOf('async function handleInner');
	assert.ok(handleInner > gates[1] && routeAt > handleInner, 'both variants run it from handleInner, where /_install runs');
	assert.ok(installAt > routeAt, 'the route sits with /_install, after PHP has booted');
	assert.equal(index.slice(routeAt, installAt).includes('dropRuntime'), false, 'the runtime stays, as /_install does (#756)');
	const workerGate = gates[1];
	const workerHandle = index.indexOf('handle(req, env, url, spikeOk, maxBody, ctx)', workerGate);
	assert.ok(workerHandle > workerGate);
	const forward = index.indexOf("if (env.PHP_IN_DO === 'on')", workerGate);
	assert.ok(forward > workerGate && forward < workerHandle, 'b-dosql forwards to the object after the worker gate');
	const objectHandle = index.indexOf('handle(req, env, url, spikeOk, maxBody, ctx)', gates[0]);
	assert.ok(objectHandle > gates[0] && objectHandle < workerGate, 'the object runs handle after its own gate');
	assert.equal(ADMIN_PASSWORD_PATH, '/_admin-password');
});
