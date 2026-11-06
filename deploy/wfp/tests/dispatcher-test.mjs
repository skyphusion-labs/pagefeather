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
};
const DEPLOYED = ['site-one', 'site-two', 'site-raw', 'site-broken'];

let fails = 0;
async function check(name, url, init, want) {
	const e = env(MAP, DEPLOYED);
	const r = await worker.fetch(new Request(url, init), e);
	const text = await r.text();
	const got = { status: r.status, error: r.headers.get('x-wfp-error'), calls: e.calls };
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
console.log(fails + ' failing case(s)');
process.exit(fails ? 1 : 0);
