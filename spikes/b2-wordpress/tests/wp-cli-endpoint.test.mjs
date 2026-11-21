// node --test spikes/b2-wordpress/tests/wp-cli-endpoint.test.mjs (#1258 step 3)
// The operator route. Off unless WP_CLI_ENDPOINT=on. Both checks, then the allowlist.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { decideWpCli } from '../wp-cli-allow.mjs';
import { createCertCache, timingSafeEqualString } from '../wp-cli-access.mjs';
import { handleWpCli, wpCliEnabled, wpCliTestCtl } from '../wp-cli-endpoint.mjs';
import { devKeysFromEnv } from '../wp-cli-access.mjs';
import { WP_CLI_CWD, WP_CLI_PHAR, WP_CLI_STDERR_CAP, WP_CLI_STDOUT_CAP, WP_CLI_WALL_MS, projectConfigPaths, runWpCli } from '../wp-cli-run.mjs';

const AUD = 'a'.repeat(32);
const TEAM = 'testteam';
const TOKEN = 'spike-token-test';
const NOW = Date.parse('2026-11-21T16:00:00Z');

function b64url(bytes) {
	let bin = '';
	for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
	return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function testKeys() {
	const pair = await crypto.subtle.generateKey(
		{ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
		true,
		['sign', 'verify'],
	);
	const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
	const pub = { kty: 'RSA', kid: 'test-kid', alg: 'RS256', use: 'sig', n: jwk.n, e: jwk.e };
	return { privateKey: pair.privateKey, pub };
}

async function signJwt(privateKey, payload, header = { alg: 'RS256', kid: 'test-kid', typ: 'JWT' }) {
	const enc = new TextEncoder();
	const h = b64url(enc.encode(JSON.stringify(header)));
	const p = b64url(enc.encode(JSON.stringify(payload)));
	const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, enc.encode(h + '.' + p)));
	return h + '.' + p + '.' + b64url(sig);
}

function payload(extra = {}) {
	return {
		aud: AUD,
		email: 'operator@example.com',
		exp: Math.floor(NOW / 1000) + 600,
		iss: 'https://' + TEAM + '.cloudflareaccess.com',
		...extra,
	};
}

function env(extra = {}) {
	return {
		WP_CLI_ENDPOINT: 'on',
		ACCESS_TEAM: TEAM,
		ACCESS_AUD: AUD,
		SPIKE_TOKEN: TOKEN,
		CUSTOM_DOMAIN: 'shop.example.com',
		...extra,
	};
}

function post(jwt, token, body, headers = {}) {
	const h = { 'content-type': 'application/json', ...headers };
	if (jwt) h['Cf-Access-Jwt-Assertion'] = jwt;
	if (token !== null && token !== undefined) h['x-spike-token'] = token;
	return new Request('https://shop.example.com/_pf/wp-cli', { method: 'POST', headers: h, body });
}

test('the route flag is on only for the exact value', () => {
	assert.equal(wpCliEnabled({ WP_CLI_ENDPOINT: 'on' }), true);
	for (const v of [undefined, '', 'off', 'ON', '1', 'yes', 'true']) {
		assert.equal(wpCliEnabled({ WP_CLI_ENDPOINT: v }), false, String(v));
	}
	assert.equal(wpCliEnabled({}), false);
	assert.equal(wpCliEnabled(undefined), false);
});

test('index.js does not load WP-CLI code unless the flag is on, and /_pf/ stays a 404', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	assert.equal(src.includes("from './wp-cli-endpoint.mjs'"), false);
	assert.equal(src.includes("from './wp-cli-allow.mjs'"), false);
	assert.equal(src.includes("from './wp-cli-run.mjs'"), false);
	const parts = src.split("env.WP_CLI_ENDPOINT === 'on'");
	assert.equal(parts.length, 3);
	assert.equal(parts[0].includes('wp-cli-endpoint'), false);
	assert.equal(parts[0].includes('wp-cli-allow'), false);
	assert.match(parts[1], /await import\('\.\/wp-cli-endpoint\.mjs'\)/);
	assert.match(parts[2], /await import\('\.\/wp-cli-endpoint\.mjs'\)/);
	const runFn = src.slice(src.indexOf('async function runSiteWpCli'), src.indexOf('async function runSiteWpCli') + 700);
	assert.match(runFn, /dropRuntimeIdle\(\)/);
	assert.match(runFn, /finally \{\s*dropRuntime\(\);/);
	const found = src.match(/pathname\.startsWith\('\/_pf\/'\)\) return new Response\('Not Found', \{ status: 404 \}\)/g) || [];
	assert.equal(found.length, 2);
	assert.equal(src.includes('PHP_IN_DO'), true);
});

test('a token compare matches only the same string', async () => {
	assert.equal(await timingSafeEqualString('spike-token-test', 'spike-token-test'), true);
	assert.equal(await timingSafeEqualString('spike-token-test', 'spike-token-tesT'), false);
	assert.equal(await timingSafeEqualString('spike-token-test', 'spike-token-test '), false);
	assert.equal(await timingSafeEqualString('', 'spike-token-test'), false);
	assert.equal(await timingSafeEqualString('spike-token-test', ''), false);
});

test('the route is 404 when it is off, and php.cli is not called', async () => {
	const keys = await testKeys();
	const jwt = await signJwt(keys.privateKey, payload());
	let ran = 0;
	const res = await handleWpCli(post(jwt, TOKEN, '{"argv":["option","get","siteurl"]}'), env({ WP_CLI_ENDPOINT: undefined }), {
		keys: [keys.pub],
		now: () => NOW,
		lock: { running: false },
		runCli: async () => { ran += 1; return { exit: 0, stdout: '', stderr: '', truncated: false }; },
	});
	assert.equal(res.status, 404);
	assert.equal(await res.text(), 'Not Found');
	assert.equal(ran, 0);
});

test('auth failures are 404 and run nothing', async () => {
	const keys = await testKeys();
	const other = await testKeys();
	const good = await signJwt(keys.privateKey, payload());
	const badSig = good.slice(0, -2) + (good.endsWith('a') ? 'b' : 'a');
	const wrongAud = await signJwt(keys.privateKey, payload({ aud: 'b'.repeat(32) }));
	const expired = await signJwt(keys.privateKey, payload({ exp: Math.floor(NOW / 1000) - 5 }));
	const badIss = await signJwt(keys.privateKey, payload({ iss: 'https://other.cloudflareaccess.com' }));
	const noneAlg = await signJwt(keys.privateKey, payload(), { alg: 'none', kid: 'test-kid', typ: 'JWT' });
	const wrongKey = await signJwt(other.privateKey, payload());
	const noWho = await signJwt(keys.privateKey, payload({ email: undefined, common_name: undefined }));
	const cases = [
		['no jwt', post(null, TOKEN, '{"argv":["option","get","siteurl"]}')],
		['bad signature', post(badSig, TOKEN, '{"argv":["option","get","siteurl"]}')],
		['wrong aud', post(wrongAud, TOKEN, '{"argv":["option","get","siteurl"]}')],
		['expired', post(expired, TOKEN, '{"argv":["option","get","siteurl"]}')],
		['bad iss', post(badIss, TOKEN, '{"argv":["option","get","siteurl"]}')],
		['alg none', post(noneAlg, TOKEN, '{"argv":["option","get","siteurl"]}')],
		['wrong key', post(wrongKey, TOKEN, '{"argv":["option","get","siteurl"]}')],
		['no token', post(good, null, '{"argv":["option","get","siteurl"]}')],
		['wrong token', post(good, 'other-token', '{"argv":["option","get","siteurl"]}')],
		['no who', post(noWho, TOKEN, '{"argv":["option","get","siteurl"]}')],
	];
	for (const [name, req] of cases) {
		let ran = 0;
		const res = await handleWpCli(req, env(), {
			keys: [keys.pub],
			now: () => NOW,
		lock: { running: false },
			runCli: async () => { ran += 1; return { exit: 0, stdout: '', stderr: '', truncated: false }; },
		});
		assert.equal(res.status, 404, name);
		assert.equal(await res.text(), 'Not Found', name);
		assert.equal(res.headers.get('cache-control'), null, name);
		assert.equal(ran, 0, name);
	}
});

test('a refused command runs nothing and the audit line has no argument values', async () => {
	const keys = await testKeys();
	const jwt = await signJwt(keys.privateKey, payload());
	const secret = 'hello-dolly-SECRET';
	let ran = 0;
	const logs = [];
	const res = await handleWpCli(post(jwt, TOKEN, JSON.stringify({ argv: ['plugin', 'install', secret] })), env(), {
		keys: [keys.pub],
		now: () => NOW,
		lock: { running: false },
		log: (line) => logs.push(line),
		runCli: async () => { ran += 1; return { exit: 0, stdout: secret, stderr: secret, truncated: false }; },
	});
	assert.equal(res.status, 422);
	assert.equal(ran, 0);
	const text = await res.text();
	assert.equal(text.includes(secret), false);
	assert.match(text, /plugin install/);
	assert.equal(logs.length, 1);
	const line = logs[0];
	const event = JSON.parse(line);
	assert.equal(event['@event'], 'wp-cli');
	assert.equal(event.who, 'operator@example.com');
	assert.equal(event.cmd, 'plugin install');
	assert.equal(event.allowed, false);
	assert.equal(event.bytes, 0);
	assert.equal(line.includes(secret), false);
	assert.equal(line.includes(TOKEN), false);
	assert.equal(line.includes(jwt), false);
	assert.equal(decideWpCli(['plugin', 'install', secret]).allowed, false);
});

test('an allowed command returns the runner result, no-store, and logs the command name only', async () => {
	const keys = await testKeys();
	const jwt = await signJwt(keys.privateKey, payload());
	const secret = 'siteurl-SECRET';
	const logs = [];
	let got = null;
	const res = await handleWpCli(post(jwt, TOKEN, JSON.stringify({ argv: ['option', 'get', secret] })), env(), {
		keys: [keys.pub],
		now: () => NOW,
		lock: { running: false },
		log: (line) => logs.push(line),
		runCli: async (argv) => {
			got = argv;
			return { exit: 0, stdout: 'http://localhost\n', stderr: '', truncated: false };
		},
	});
	assert.deepEqual(got, ['option', 'get', secret]);
	assert.equal(res.status, 200);
	assert.equal(res.headers.get('cache-control'), 'private, no-store');
	assert.equal(res.headers.get('cloudflare-cdn-cache-control'), 'no-store');
	assert.equal(res.headers.get('cache-tag'), null);
	const body = await res.json();
	assert.deepEqual(body, { exit: 0, stdout: 'http://localhost\n', stderr: '', ms: body.ms, truncated: false });
	assert.equal(typeof body.ms, 'number');
	const event = JSON.parse(logs[0]);
	assert.equal(event.cmd, 'option get');
	assert.equal(event.allowed, true);
	assert.equal(event.exit, 0);
	assert.equal(event.who, 'operator@example.com');
	assert.equal(logs[0].includes(secret), false);
	assert.equal(logs[0].includes('http://localhost'), false);
	assert.equal(logs[0].includes(TOKEN), false);
	assert.equal(logs[0].includes(jwt), false);
});

test('a service token is logged as its client id', async () => {
	const keys = await testKeys();
	const jwt = await signJwt(keys.privateKey, payload({ email: undefined, common_name: 'svc-client-id' }));
	const logs = [];
	const res = await handleWpCli(post(jwt, TOKEN, '{"argv":["core","version"]}'), env(), {
		keys: [keys.pub],
		now: () => NOW,
		lock: { running: false },
		log: (line) => logs.push(line),
		runCli: async () => ({ exit: 0, stdout: '7.1.5\n', stderr: '', truncated: false }),
	});
	assert.equal(res.status, 200);
	assert.equal(JSON.parse(logs[0]).who, 'svc-client-id');
	assert.equal(logs[0].includes(jwt), false);
});

test('the body is argv only, at most 4 KiB, and a shell string runs nothing', async () => {
	const keys = await testKeys();
	const jwt = await signJwt(keys.privateKey, payload());
	const deps = (run) => ({
		keys: [keys.pub],
		now: () => NOW,
		lock: { running: false },
		log: () => {},
		runCli: run,
	});
	let ran = 0;
	const run = async () => { ran += 1; return { exit: 0, stdout: '', stderr: '', truncated: false }; };
	const shell = await handleWpCli(post(jwt, TOKEN, JSON.stringify({ argv: 'option get siteurl' })), env(), deps(run));
	assert.equal(shell.status, 422);
	assert.equal(ran, 0);
	const extra = await handleWpCli(post(jwt, TOKEN, JSON.stringify({ argv: ['cache', 'flush'], shell: 'rm' })), env(), deps(run));
	assert.equal(extra.status, 422);
	assert.equal(ran, 0);
	const big = 'x'.repeat(4097);
	const over = await handleWpCli(post(jwt, TOKEN, big), env(), deps(run));
	assert.equal(over.status, 422);
	assert.equal(ran, 0);
	assert.equal((await over.text()).includes('xxxx'), false);
});

test('a second run while one is running gets 429', async () => {
	const keys = await testKeys();
	const jwt = await signJwt(keys.privateKey, payload());
	let release;
	const gate = new Promise((ok) => { release = ok; });
	let mark;
	const started = new Promise((ok) => { mark = ok; });
	let ran = 0;
	const deps = {
		keys: [keys.pub],
		now: () => NOW,
		lock: { running: false },
		log: () => {},
		runCli: () => {
			ran += 1;
			mark();
			return gate.then(() => ({ exit: 0, stdout: 'ok', stderr: '', truncated: false }));
		},
	};
	const body = '{"argv":["cache","flush"]}';
	const first = handleWpCli(post(jwt, TOKEN, body), env(), deps);
	await started;
	const second = await handleWpCli(post(jwt, TOKEN, body), env(), deps);
	assert.equal(second.status, 429);
	assert.equal(second.headers.get('cache-control'), 'private, no-store');
	assert.equal(ran, 1);
	release();
	const done = await first;
	assert.equal(done.status, 200);
});

test('the runner does not load a site wp-cli.yml require', async () => {
	const yml = 'require:\n  - /tmp/pwn.php\n';
	const opened = [];
	const php = fakePhp({
		'/wordpress/wp-cli.yml': yml,
	}, (args, opts) => {
		const cfg = php.readFile(opts.env.WP_CLI_CONFIG_PATH);
		opened.push(opts.env.WP_CLI_CONFIG_PATH);
		assert.equal(cfg, '');
		for (const path of projectConfigPaths(opts.cwd)) {
			opened.push(path);
			const text = php.readFile(path);
			assert.equal(String(text).includes('require:'), false, path);
		}
		assert.equal(opts.cwd, WP_CLI_CWD);
		assert.equal(opts.stdin, undefined);
		assert.equal(opts.env.WP_CLI_DISABLE_AUTO_CHECK_UPDATE, '1');
		assert.equal(php.readFile('/wordpress/wp-cli.yml'), yml);
		return { exitCode: Promise.resolve(0), stdout: streamOf('ok'), stderr: streamOf('') };
	});
	const out = await runWpCli(php, ['option', 'get', 'siteurl']);
	assert.equal(out.exit, 0);
	assert.deepEqual(php.cliArgs, ['php', WP_CLI_PHAR, 'option', 'get', 'siteurl']);
	assert.equal(opened.includes('/wordpress/wp-cli.yml'), false);
	assert.equal(php.spawnSet, true);
});

test('the wall limit returns exit 124 and truncated', async () => {
	assert.equal(WP_CLI_WALL_MS, 25000);
	const php = fakePhp({}, () => ({
		exitCode: new Promise((ok) => setTimeout(() => ok(0), 400)),
		stdout: hangStream(),
		stderr: streamOf(''),
	}));
	const out = await runWpCli(php, ['option', 'get', 'siteurl'], { wallMs: 30 });
	assert.equal(out.exit, 124);
	assert.equal(out.truncated, true);
});

test('the output cap sets truncated', async () => {
	assert.equal(WP_CLI_STDOUT_CAP, 1024 * 1024);
	assert.equal(WP_CLI_STDERR_CAP, 64 * 1024);
	const php = fakePhp({}, () => ({
		exitCode: Promise.resolve(0),
		stdout: streamOf('y'.repeat(100)),
		stderr: streamOf(''),
	}));
	const out = await runWpCli(php, ['core', 'version'], { stdoutCap: 16 });
	assert.equal(out.exit, 0);
	assert.equal(out.truncated, true);
	assert.equal(out.stdout.length, 16);
});

test('the team certs are fetched once and then cached', async () => {
	const keys = await testKeys();
	const jwt = await signJwt(keys.privateKey, payload());
	let fetched = 0;
	const deps = {
		fetch: async (url) => {
			fetched += 1;
			assert.equal(url, 'https://testteam.cloudflareaccess.com/cdn-cgi/access/certs');
			return {
				ok: true,
				headers: { get: () => 'max-age=120' },
				json: async () => ({ keys: [keys.pub] }),
			};
		},
		cache: createCertCache(),
		now: () => NOW,
		lock: { running: false },
		log: () => {},
		runCli: async () => ({ exit: 0, stdout: 'ok', stderr: '', truncated: false }),
	};
	const a = await handleWpCli(post(jwt, TOKEN, '{"argv":["core","version"]}'), env(), deps);
	const b = await handleWpCli(post(jwt, TOKEN, '{"argv":["core","version"]}'), env(), deps);
	assert.equal(a.status, 200);
	assert.equal(b.status, 200);
	assert.equal(fetched, 1);
});

test('a dev key is ignored unless the spike token is the local one', () => {
	const keys = [{ kid: 'test-kid', kty: 'RSA', n: 'aa', e: 'AQAB' }];
	const b64 = btoa(JSON.stringify(keys));
	assert.equal(devKeysFromEnv({ SPIKE_TOKEN: TOKEN, WP_CLI_DEV_KEYS_B64: b64 }), null);
	assert.equal(devKeysFromEnv({ SPIKE_TOKEN: 'local-spike-token' }), null);
	assert.deepEqual(devKeysFromEnv({ SPIKE_TOKEN: 'local-spike-token', WP_CLI_DEV_KEYS_B64: b64 }), keys);
	assert.equal(devKeysFromEnv({ SPIKE_TOKEN: 'local-spike-token', WP_CLI_DEV_KEYS_B64: '%%%' }), null);
});

test('the local token accepts the test JWT without fetching certs', async () => {
	const keys = await testKeys();
	const b64 = btoa(JSON.stringify([keys.pub]));
	const jwt = await signJwt(keys.privateKey, payload());
	let fetched = 0;
	let ran = 0;
	const res = await handleWpCli(
		post(jwt, 'local-spike-token', '{"argv":["option","get","siteurl"]}'),
		env({ SPIKE_TOKEN: 'local-spike-token', WP_CLI_DEV_KEYS_B64: b64 }),
		{
			now: () => NOW,
			lock: { running: false },
			log: () => {},
			fetch: async () => { fetched += 1; throw new Error('fetch'); },
			runCli: async () => { ran += 1; return { exit: 0, stdout: 'http://localhost\n', stderr: '', truncated: false }; },
		},
	);
	assert.equal(fetched, 0);
	assert.equal(ran, 1);
	assert.equal(res.status, 200);
	const blocked = await handleWpCli(
		post(jwt, TOKEN, '{"argv":["option","get","siteurl"]}'),
		env({ WP_CLI_DEV_KEYS_B64: b64 }),
		{
			now: () => NOW,
			lock: { running: false },
			log: () => {},
			fetch: async () => { fetched += 1; throw new Error('fetch'); },
			runCli: async () => { ran += 1; return { exit: 0, stdout: '', stderr: '', truncated: false }; },
		},
	);
	assert.equal(blocked.status, 404);
	assert.equal(ran, 1);
	assert.equal(fetched, 1);
});

test('a short wall and a slow hook are local only', async () => {
	assert.deepEqual(wpCliTestCtl(env({ WP_CLI_WALL_MS: '200', WP_CLI_SLOW_MS: '3000' })), {});
	assert.deepEqual(wpCliTestCtl({ SPIKE_TOKEN: 'local-spike-token', WP_CLI_WALL_MS: '25000', WP_CLI_SLOW_MS: '0' }), {});
	assert.deepEqual(
		wpCliTestCtl({ SPIKE_TOKEN: 'local-spike-token', WP_CLI_WALL_MS: '200', WP_CLI_SLOW_MS: '3000' }),
		{ wallMs: 200, slowMs: 3000 },
	);
	const keys = await testKeys();
	const jwt = await signJwt(keys.privateKey, payload());
	let seen = null;
	await handleWpCli(
		post(jwt, 'local-spike-token', '{"argv":["option","get","siteurl"]}'),
		env({ SPIKE_TOKEN: 'local-spike-token', WP_CLI_WALL_MS: '200', WP_CLI_SLOW_MS: '3000' }),
		{
			keys: [keys.pub],
			now: () => NOW,
			lock: { running: false },
			log: () => {},
			runCli: async (argv, ctl) => { seen = ctl; return { exit: 0, stdout: '', stderr: '', truncated: false }; },
		},
	);
	assert.deepEqual(seen, { wallMs: 200, slowMs: 3000 });
});

test('a wall timeout stops the runtime and the next run is not blocked', async () => {
	let exited = 0;
	let cancelled = 0;
	const php = fakePhp({}, () => ({
		exitCode: new Promise(() => {}),
		stdout: new ReadableStream({
			start() {},
			cancel() { cancelled += 1; },
		}),
		stderr: streamOf(''),
	}));
	php.exit = () => { exited += 1; };
	const out = await runWpCli(php, ['option', 'get', 'siteurl'], { wallMs: 30 });
	assert.equal(out.exit, 124);
	assert.equal(out.truncated, true);
	assert.equal(exited, 1);
	assert.equal(cancelled, 1);
	const keys = await testKeys();
	const jwt = await signJwt(keys.privateKey, payload());
	let n = 0;
	const deps = {
		keys: [keys.pub],
		now: () => NOW,
		lock: { running: false },
		log: () => {},
		runCli: async () => {
			n += 1;
			if (n === 1) return { exit: 124, stdout: '', stderr: '', truncated: true };
			return { exit: 0, stdout: 'ok', stderr: '', truncated: false };
		},
	};
	const body = '{"argv":["core","version"]}';
	const first = await handleWpCli(post(jwt, TOKEN, body), env(), deps);
	const second = await handleWpCli(post(jwt, TOKEN, body), env(), deps);
	assert.equal(first.status, 200);
	assert.equal((await first.json()).exit, 124);
	assert.equal(second.status, 200);
	assert.equal((await second.json()).exit, 0);
	assert.equal(n, 2);
});

test('the slow hook is written only when a local check asks', async () => {
	const php = fakePhp({}, () => ({
		exitCode: Promise.resolve(0),
		stdout: streamOf('ok'),
		stderr: streamOf(''),
	}));
	await runWpCli(php, ['option', 'get', 'siteurl'], { slowMs: 2500 });
	const hook = php.readFile('/wordpress/wp-content/mu-plugins/wp-cli-slow-test.php');
	assert.match(hook, /usleep\(2500000\)/);
	assert.match(hook, /WP_CLI/);
	const plain = fakePhp({}, () => ({
		exitCode: Promise.resolve(0),
		stdout: streamOf(''),
		stderr: streamOf(''),
	}));
	await runWpCli(plain, ['core', 'version']);
	assert.equal(plain.readFile('/wordpress/wp-content/mu-plugins/wp-cli-slow-test.php'), '');
});

test('engine check: a test key injected for the test runs option get siteurl', async () => {
	const keys = await testKeys();
	const jwt = await signJwt(keys.privateKey, payload());
	let fetched = 0;
	const phpCalls = [];
	const res = await handleWpCli(post(jwt, TOKEN, '{"argv":["option","get","siteurl"]}'), env(), {
		keys: [keys.pub],
		now: () => NOW,
		lock: { running: false },
		log: () => {},
		fetch: async () => { fetched += 1; throw new Error('fetch'); },
		runCli: async (argv) => {
			phpCalls.push(argv);
			const php = fakePhp({}, () => ({
				exitCode: Promise.resolve(0),
				stdout: streamOf('http://localhost\n'),
				stderr: streamOf(''),
			}));
			return runWpCli(php, argv);
		},
	});
	assert.equal(fetched, 0);
	assert.deepEqual(phpCalls, [['option', 'get', 'siteurl']]);
	assert.equal(res.status, 200);
	const body = await res.json();
	assert.equal(body.exit, 0);
	assert.equal(body.stdout, 'http://localhost\n');
	assert.equal(body.truncated, false);
});

function streamOf(text) {
	const bytes = new TextEncoder().encode(text);
	return new ReadableStream({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	});
}

function hangStream() {
	return new ReadableStream({
		start() {},
	});
}

function fakePhp(files, cli) {
	const php = {
		files: { ...files },
		spawnSet: false,
		cliArgs: null,
		mkdir() {},
		writeFile(path, data) { php.files[path] = String(data); },
		readFile(path) { return Object.prototype.hasOwnProperty.call(php.files, path) ? php.files[path] : ''; },
		setSpawnHandler() { php.spawnSet = true; },
		cli(args, opts) {
			php.cliArgs = args;
			return cli(args, opts);
		},
	};
	return php;
}
