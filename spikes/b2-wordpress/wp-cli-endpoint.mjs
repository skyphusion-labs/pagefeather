// POST /_pf/wp-cli (issue #1258). Off unless WP_CLI_ENDPOINT=on.
//
// Every request needs a valid Cloudflare Access JWT and the operator token.
// Either miss is a 404, the same answer as a path under /_pf/ that is not this
// route. The argv array goes only through decideWpCli. There is no shell string.

import { decideWpCli } from './wp-cli-allow.mjs';
import { devKeysFromEnv, localDevGate, timingSafeEqualString, verifyAccessJwt } from './wp-cli-access.mjs';
import { noStoreAnywhere } from './perf-headers.mjs';

const BODY_CAP = 4096;
const BODY_MSG = 'Refused: the body must be a JSON object {"argv":[...]} of at most 4 KiB. See issue #1258.';

const siteLock = { running: false };

export function wpCliEnabled(env) {
	return !!(env && env.WP_CLI_ENDPOINT === 'on');
}

// A short wall and a slow hook exist only for the local engine check. Both
// gates must hold: the local spike token, and DEV_LOCAL=1 from run.sh. A deploy
// refuses both vars. Anything else keeps the 25 s cap and does not write the slow file.
export function wpCliTestCtl(env) {
	if (!localDevGate(env)) return {};
	const ctl = {};
	const wall = Number(env.WP_CLI_WALL_MS);
	if (Number.isFinite(wall) && wall >= 50 && wall < 25000) ctl.wallMs = wall;
	const slow = Number(env.WP_CLI_SLOW_MS);
	if (Number.isFinite(slow) && slow >= 1 && slow <= 120000) ctl.slowMs = slow;
	return ctl;
}

function depsWithLocalKeys(env, deps) {
	const d = deps ? { ...deps } : {};
	if (!d.keys) {
		const keys = devKeysFromEnv(env);
		if (keys) d.keys = keys;
	}
	return d;
}

function notFound() {
	return new Response('Not Found', { status: 404 });
}

function withNoStore(status, body, type) {
	const headers = new Headers();
	if (type) headers.set('content-type', type);
	noStoreAnywhere(headers);
	return new Response(body, { status, headers });
}

function audit(deps, fields) {
	const line = JSON.stringify({
		'@event': 'wp-cli',
		who: fields.who,
		cmd: fields.cmd,
		allowed: fields.allowed,
		exit: fields.exit,
		ms: fields.ms,
		bytes: fields.bytes,
	});
	(deps.log || console.log)(line);
}

async function authorize(req, env, deps) {
	const jwt = await verifyAccessJwt(req.headers.get('Cf-Access-Jwt-Assertion'), env, deps);
	const secret = env && typeof env.SPIKE_TOKEN === 'string' ? env.SPIKE_TOKEN : '';
	const token = req.headers.get('x-spike-token');
	const tokenOk = secret.length > 0 && typeof token === 'string' && await timingSafeEqualString(token, secret);
	if (!jwt || !tokenOk) return null;
	return jwt.who;
}

async function readBody(req) {
	const declared = Number(req.headers.get('content-length') || 0);
	if (Number.isFinite(declared) && declared > BODY_CAP) return null;
	if (!req.body || typeof req.body.getReader !== 'function') return null;
	const reader = req.body.getReader();
	const chunks = [];
	let n = 0;
	for (;;) {
		const step = await reader.read();
		if (step.done) break;
		n += step.value.byteLength;
		if (n > BODY_CAP) {
			try { await reader.cancel(); } catch { /* already closed */ }
			return null;
		}
		chunks.push(step.value);
	}
	const all = new Uint8Array(n);
	let o = 0;
	for (const chunk of chunks) {
		all.set(chunk, o);
		o += chunk.byteLength;
	}
	return new TextDecoder().decode(all);
}

function argvFrom(text) {
	let data;
	try { data = JSON.parse(text); } catch { return null; }
	if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
	const keys = Object.keys(data);
	if (keys.length !== 1 || keys[0] !== 'argv') return null;
	return data.argv;
}

function tryLock(lock) {
	if (lock.running) return false;
	lock.running = true;
	return true;
}

// The front Worker. On b-dosql and b-do the run is inside the site object.
// On approach A it is this Worker. A failed check is 404.
export async function serveWpCli(req, env, deps) {
	if (!wpCliEnabled(env)) return notFound();
	const d = depsWithLocalKeys(env, deps);
	if (env && env.PHP_IN_DO === 'on') {
		if (!env.PHP_RUNTIME || typeof d.forward !== 'function') return notFound();
		const who = await authorize(req, env, d);
		if (!who) return notFound();
		return d.forward(req);
	}
	return handleWpCli(req, env, d);
}

// Auth, the allowlist, then one run. deps.runCli receives the argv array only.
// deps.keys is the test JWT key. Callers in index.js do not pass it.
export async function handleWpCli(req, env, deps) {
	const d = depsWithLocalKeys(env, deps);
	if (!wpCliEnabled(env)) return notFound();
	const who = await authorize(req, env, d);
	if (!who) return notFound();
	if (!req || req.method !== 'POST') return notFound();
	const text = await readBody(req);
	if (text === null) return withNoStore(422, BODY_MSG, 'text/plain; charset=utf-8');
	const argv = argvFrom(text);
	if (argv === null) return withNoStore(422, BODY_MSG, 'text/plain; charset=utf-8');
	const decision = decideWpCli(argv);
	if (!decision.allowed) {
		audit(d, { who, cmd: decision.command, allowed: false, exit: null, ms: 0, bytes: 0 });
		return withNoStore(422, decision.message, 'text/plain; charset=utf-8');
	}
	const lock = d.lock || siteLock;
	if (!tryLock(lock)) return withNoStore(429, 'busy', 'text/plain; charset=utf-8');
	const t0 = typeof d.now === 'function' ? d.now() : Date.now();
	try {
		const out = await d.runCli(argv, wpCliTestCtl(env));
		const ms = Math.max(0, (typeof d.now === 'function' ? d.now() : Date.now()) - t0);
		const stdout = out && typeof out.stdout === 'string' ? out.stdout : '';
		const stderr = out && typeof out.stderr === 'string' ? out.stderr : '';
		const exit = out && Number.isFinite(out.exit) ? out.exit : 1;
		const truncated = !!(out && out.truncated);
		audit(d, { who, cmd: decision.command, allowed: true, exit, ms, bytes: stdout.length + stderr.length });
		return withNoStore(200, JSON.stringify({ exit, stdout, stderr, ms, truncated }), 'application/json');
	} finally {
		lock.running = false;
	}
}
