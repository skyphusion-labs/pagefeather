// Unit test of deploy/wfp/dispatcher/worker.js (issue #35), with a stand-in
// site map (KV) and dispatch namespace.
//   node deploy/wfp/tests/dispatcher-test.mjs [path to a worker.js]
// Exit 0 only when every case gives what it must.
import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const path = resolve(process.argv[2] || resolve(here, '../dispatcher/worker.js'));
const worker = (await import(pathToFileURL(path).href + '?t=' + Date.now())).default;

function env(map, deployed) {
	const calls = [];
	const ns = (name) => ({
		get(script, args, opts) {
			calls.push({ binding: name, script, opts });
			return {
				async fetch(request) {
					if (!deployed.includes(script)) throw new Error('Worker not found.');
					if (script === 'site-broken') throw new Error('Internal error');
					const body = request.method === 'GET' || request.method === 'HEAD' ? '' : await request.text();
					return new Response(JSON.stringify({ script, url: request.url, method: request.method, body, cookie: request.headers.get('cookie') }), { status: 200 });
				},
			};
		},
	});
	return {
		calls,
		SITES: { async get(k) { return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null; } },
		DISPATCHER: ns('DISPATCHER'),
		DISPATCHER_OUT: ns('DISPATCHER_OUT'),
	};
}

const MAP = {
	'wp-one.sub.workers.dev': JSON.stringify({ script: 'site-one', cpuMs: 30000, subRequests: 1000, outbound: true }),
	'wp-two.sub.workers.dev': JSON.stringify({ script: 'site-two' }),
	'wp-raw.sub.workers.dev': JSON.stringify({ script: 'site-raw', outbound: false, cpuMs: 0, subRequests: 'many' }),
	'wp-probe.sub.workers.dev': JSON.stringify({ script: 'site-probe', outbound: true }),
	'wp-junk.sub.workers.dev': '{not json',
	'wp-evil.sub.workers.dev': JSON.stringify({ script: '../other' }),
	'wp-null.sub.workers.dev': 'null',
	'wp-broken.sub.workers.dev': JSON.stringify({ script: 'site-broken' }),
	// #479: a store move closes the site until its time; a past time is ignored; a bad flag closes.
	'wp-moving.sub.workers.dev': JSON.stringify({ script: 'site-one', moving: { until: Date.now() + 600000 } }),
	'wp-moved.sub.workers.dev': JSON.stringify({ script: 'site-one', moving: { until: Date.now() - 1 } }),
	'wp-movebad.sub.workers.dev': JSON.stringify({ script: 'site-one', moving: 'yes' }),
	'wp-moveoff.sub.workers.dev': JSON.stringify({ script: 'site-one', moving: false }),
};
const DEPLOYED = ['site-one', 'site-two', 'site-raw', 'site-broken'];

let fails = 0;
async function check(name, url, init, want) {
	const e = env(MAP, DEPLOYED);
	const r = await worker.fetch(new Request(url, init), e);
	const text = await r.text();
	const got = { status: r.status, error: r.headers.get('x-wfp-error'), calls: e.calls, retry: r.headers.get('retry-after'), cache: r.headers.get('cache-control') };
	const problems = want(got, text);
	if (problems.length) {
		fails++;
		console.log('FAIL ' + name + ': ' + problems.join('; ') + ' (status ' + r.status + ', x-wfp-error ' + got.error + ', calls ' + JSON.stringify(e.calls) + ')');
	} else console.log('PASS ' + name);
}
const p = (cond, msg) => (cond ? [] : [msg]);

await check('a listed site: its script, its limits, through the outbound Worker', 'https://wp-one.sub.workers.dev/hello/?a=1', {}, (g, t) => [
	...p(g.status === 200, 'status 200'),
	...p(JSON.parse(t).script === 'site-one', 'script site-one'),
	...p(g.calls.length === 1 && g.calls[0].binding === 'DISPATCHER_OUT', 'the outbound binding'),
	...p(JSON.stringify(g.calls[0]?.opts) === JSON.stringify({ limits: { cpuMs: 30000, subRequests: 1000 }, outbound: { SITE: 'site-one' } }), 'limits and outbound parameter'),
]);
await check('the request reaches the site unchanged (URL, method, body, cookie)', 'https://wp-two.sub.workers.dev/wp-login.php?x=y', { method: 'POST', body: 'log=admin', headers: { cookie: 'a=b' } }, (g, t) => {
	const j = JSON.parse(t);
	return [...p(j.url === 'https://wp-two.sub.workers.dev/wp-login.php?x=y', 'url'), ...p(j.method === 'POST' && j.body === 'log=admin', 'method and body'), ...p(j.cookie === 'a=b', 'cookie')];
});
await check('no limits in the entry: none set; outbound by default', 'https://wp-two.sub.workers.dev/', {}, (g) => [
	...p(g.calls[0]?.binding === 'DISPATCHER_OUT', 'outbound by default'),
	...p(!('limits' in (g.calls[0]?.opts || {})), 'no limits'),
]);
await check('outbound false, and invalid limits (0, a string) are left out', 'https://wp-raw.sub.workers.dev/', {}, (g) => [
	...p(g.status === 200, 'status 200'),
	...p(g.calls[0]?.binding === 'DISPATCHER', 'the plain binding'),
	...p(JSON.stringify(g.calls[0]?.opts) === '{}', 'no options'),
]);
await check('the hostname is matched without regard to case', 'https://WP-ONE.sub.workers.dev/', {}, (g, t) => [...p(g.status === 200 && JSON.parse(t).script === 'site-one', 'site-one')]);
await check('an unlisted host: 404 no-site, no script called', 'https://wp-nobody.sub.workers.dev/', {}, (g) => [
	...p(g.status === 404 && g.error === 'no-site', '404 no-site'),
	...p(g.calls.length === 0, 'no namespace call'),
]);
await check('a stale entry (its script is not deployed): 404 not-deployed (#35 condition b)', 'https://wp-probe.sub.workers.dev/', {}, (g) => [...p(g.status === 404 && g.error === 'not-deployed', '404 not-deployed')]);
await check('an entry that is not JSON: 500 bad-entry', 'https://wp-junk.sub.workers.dev/', {}, (g) => [...p(g.status === 500 && g.error === 'bad-entry', '500 bad-entry'), ...p(g.calls.length === 0, 'no call')]);
await check('an entry whose script is not a site-<name>: 500, no call', 'https://wp-evil.sub.workers.dev/', {}, (g) => [...p(g.status === 500 && g.error === 'bad-entry', '500 bad-entry'), ...p(g.calls.length === 0, 'no call')]);
await check('an entry that is JSON null: 500 bad-entry', 'https://wp-null.sub.workers.dev/', {}, (g) => [...p(g.status === 500 && g.error === 'bad-entry', '500 bad-entry')]);
await check('any other namespace error: 502 dispatch, no internals in the body', 'https://wp-broken.sub.workers.dev/', {}, (g, t) => [...p(g.status === 502 && g.error === 'dispatch', '502 dispatch'), ...p(!t.includes('Internal error'), 'no error text')]);
// #479: the move freeze at the front door.
for (const [m, init] of [['GET', {}], ['POST', { method: 'POST', body: 'x=1' }], ['HEAD', { method: 'HEAD' }]]) {
	await check(`a site being moved: ${m} / answers 503 moving, Retry-After 120, no-store, no script called`, 'https://wp-moving.sub.workers.dev/', init, (g) => [
		...p(g.status === 503 && g.error === 'moving', '503 moving'),
		...p(g.retry === '120', 'Retry-After 120'),
		...p(g.cache === 'no-store', 'no-store'),
		...p(g.calls.length === 0, 'no namespace call'),
	]);
}
await check('a site being moved: the admin is closed too (WordPress writes on GETs)', 'https://wp-moving.sub.workers.dev/wp-admin/post-new.php', {}, (g) => [...p(g.status === 503 && g.calls.length === 0, '503, no call')]);
await check('a site being moved: an operator /_ path still reaches the site (the export runs)', 'https://wp-moving.sub.workers.dev/_mysqlexport?stats=1', {}, (g, t) => [...p(g.status === 200 && JSON.parse(t).script === 'site-one', 'reaches site-one')]);
await check('a move whose time has passed is ignored: the site answers', 'https://wp-moved.sub.workers.dev/', {}, (g, t) => [...p(g.status === 200 && JSON.parse(t).script === 'site-one', 'site-one answers')]);
await check('a moving flag that is not {until: <ms>} closes the site', 'https://wp-movebad.sub.workers.dev/', {}, (g) => [...p(g.status === 503 && g.error === 'moving' && g.calls.length === 0, '503 moving')]);
await check('moving: false is no move', 'https://wp-moveoff.sub.workers.dev/', {}, (g, t) => [...p(g.status === 200 && JSON.parse(t).script === 'site-one', 'site-one answers')]);
await check('/_dbsnapshot from a visitor: 404 not-public, no site map read, no script called (#533)', 'https://wp-one.sub.workers.dev/_dbsnapshot', { method: 'POST', headers: { 'x-snapshot-token': 't' } }, (g) => [
	...p(g.status === 404 && g.error === 'not-public', '404 not-public'),
	...p(g.calls.length === 0, 'no namespace call'),
]);
await check('a path that only starts like it is still dispatched', 'https://wp-one.sub.workers.dev/_dbsnapshotx', {}, (g) => [...p(g.status === 200 && g.calls.length === 1, 'dispatched')]);

// scheduled() (#533): one site, the plain binding, the token, a timeout; a failure throws.
function cronEnv(vars, answer) {
	const calls = [];
	const ns = (binding) => ({
		get(script, args, opts) {
			calls.push({ binding, script, opts });
			return { fetch: (req) => answer(req, calls) };
		},
	});
	return { calls, SITES: { get: async () => { throw new Error('the cron must not read the site map'); } }, DISPATCHER: ns('DISPATCHER'), DISPATCHER_OUT: ns('DISPATCHER_OUT'), ...vars };
}
async function cron(name, vars, answer, want) {
	const e = cronEnv(vars, answer);
	const logs = [];
	const orig = console.log;
	console.log = (m) => logs.push(String(m));
	let err = null;
	try {
		await worker.scheduled({ scheduledTime: 1794640000000, cron: '17 7 * * *' }, e, { waitUntil() {} });
	} catch (x) {
		err = x;
	} finally {
		console.log = orig;
	}
	const ev = logs.filter((l) => l.startsWith('@event snapshot ')).map((l) => JSON.parse(l.slice(16)));
	const problems = want({ err, calls: e.calls, ev });
	if (problems.length) {
		fails++;
		console.log('FAIL ' + name + ': ' + problems.join('; ') + ' (err ' + (err && err.message) + ', calls ' + JSON.stringify(e.calls) + ', events ' + JSON.stringify(ev) + ')');
	} else console.log('PASS ' + name);
}
const okAnswer = async (req, calls) => {
	calls.push({ method: req.method, url: req.url, token: req.headers.get('x-snapshot-token') });
	return new Response(JSON.stringify({ ok: true, key: '_snapshots/auto/20261114T071700Z.ndjson.gz', rows: 8616 }), { status: 200 });
};
const CONF = { SNAPSHOT_SCRIPT: 'site-one', SNAPSHOT_TOKEN: 'tok-one' };
await cron('scheduled: POST /_dbsnapshot to its one site, plain binding, its token; resolves on ok', CONF, okAnswer, ({ err, calls, ev }) => [
	...p(err === null, 'no throw'),
	...p(calls[0]?.binding === 'DISPATCHER' && calls[0]?.script === 'site-one', 'site-one on the plain binding'),
	...p(calls[1]?.method === 'POST' && new URL(calls[1]?.url || 'x:').pathname === '/_dbsnapshot' && calls[1]?.token === 'tok-one', 'POST /_dbsnapshot with the token'),
	...p(ev.length === 1 && ev[0].ok === true && ev[0].result?.rows === 8616 && ev[0].script === 'site-one', 'one ok event with the result'),
	...p(!JSON.stringify(ev).includes('tok-one'), 'the token is never logged'),
]);
await cron('scheduled: the site answers 500: the run throws, one failed event', CONF, async () => new Response('{"ok":false,"error":"dump-error"}', { status: 500 }), ({ err, ev }) => [
	...p(err && /HTTP 500/.test(err.message), 'throws HTTP 500'),
	...p(ev.length === 1 && ev[0].ok === false && ev[0].status === 500, 'failed event'),
]);
await cron('scheduled: 200 but ok is not true: the run throws', CONF, async () => new Response('{"ok":false}', { status: 200 }), ({ err }) => [...p(err !== null, 'throws')]);
await cron('scheduled: 200 with a body that is not JSON: the run throws', CONF, async () => new Response('fine', { status: 200 }), ({ err }) => [...p(err !== null, 'throws')]);
await cron('scheduled: 409 import-held: the run throws (not stored)', CONF, async () => new Response('{"ok":false,"error":"import-held"}', { status: 409 }), ({ err }) => [...p(err && /409/.test(err.message), 'throws 409')]);
await cron('scheduled: the namespace throws: the run throws, the event names it', CONF, async () => { throw new Error('Worker not found.'); }, ({ err, ev }) => [
	...p(err && /Worker not found/.test(err.message), 'throws'),
	...p(ev[0]?.ok === false && /Worker not found/.test(ev[0]?.error || ''), 'event names it'),
]);
await cron('scheduled: a site that never answers: timeout after SNAPSHOT_TIMEOUT_MS', { ...CONF, SNAPSHOT_TIMEOUT_MS: '50' }, () => new Promise(() => {}), ({ err, ev }) => [
	...p(err && /timeout after 50 ms/.test(err.message), 'timeout after 50 ms'),
	...p(ev[0]?.ok === false, 'failed event'),
]);
await cron('scheduled: no SNAPSHOT_TOKEN: throws not-configured, no call', { SNAPSHOT_SCRIPT: 'site-one' }, okAnswer, ({ err, calls }) => [...p(err && /not configured/.test(err.message), 'not configured'), ...p(calls.length === 0, 'no call')]);
await cron('scheduled: no SNAPSHOT_SCRIPT: throws not-configured, no call', { SNAPSHOT_TOKEN: 't' }, okAnswer, ({ err, calls }) => [...p(err && /not configured/.test(err.message), 'not configured'), ...p(calls.length === 0, 'no call')]);
await cron('scheduled: a SNAPSHOT_SCRIPT that is not a site-<name>: throws, no call', { SNAPSHOT_SCRIPT: '../other', SNAPSHOT_TOKEN: 't' }, okAnswer, ({ err, calls }) => [...p(err !== null, 'throws'), ...p(calls.length === 0, 'no call')]);
console.log(fails + ' failing case(s)');
process.exit(fails ? 1 : 0);
