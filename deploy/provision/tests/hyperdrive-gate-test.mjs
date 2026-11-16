// #650: an approach-A site may set OBJECT_CACHE_VERSIONS=on (#643, #296 (2)) only when its Hyperdrive config
// does NOT cache queries: the exact versions are read once per request from MySQL, and a cached read (Hyperdrive
// caching: up to max_age, blind to writes) would serve an old version and so old options and transients.
// Read at provision time from the Cloudflare API, fail closed. No network: every fetch is a fake, and the fake
// FAILS on any call it does not expect (this suite's fence: a case past its refusal cannot reach a real API).
import { versionsGate, cachingDisabled, versionsFlagOn } from '../hyperdrive-gate.mjs';
import { provisionSite } from '../provision.mjs';
import { aBindings, aVars, mediaBucketName } from '../wp-site-config.mjs';

const ACCT = 'fabcb25d9c7eb087110ec474a03e50d2';
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('PASS', n); } else { fail++; console.log('FAIL', n); } };

// A fake Cloudflare API with one Hyperdrive config answer. Any other call is recorded and answered 599, so a test
// that expects "no call" sees it.
function api(hd) {
	const calls = [];
	const fetchImpl = async (url, init) => {
		calls.push({ url, method: init.method });
		if (init.method === 'GET' && /\/hyperdrive\/configs\/[^/]+$/.test(url)) {
			if (hd === 'fail') return { ok: false, status: 500, text: async () => '{"success":false,"errors":[{"code":10000,"message":"Authentication error"}]}' };
			return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, result: hd, errors: [] }) };
		}
		// The registry and script lookups answer "not found" (as tests/provision-test.mjs does), so provisioning
		// without the gate runs on to its FIRST WRITE, which then shows up as a mutating call (and fails here).
		if (init.method === 'GET' && /\/storage\/kv\/namespaces\/[^/]+\/values\//.test(url)) return { ok: false, status: 404, text: async () => '{"success":false,"errors":[{"code":10009,"message":"key not found"}]}' };
		if (init.method === 'GET' && /\/scripts\/[^/]+$/.test(url)) return { ok: false, status: 404, text: async () => '{"success":false,"errors":[{"code":10090}]}' };
		return { ok: false, status: 599, text: async () => '{"success":false,"errors":[{"code":599,"message":"fake: unexpected call"}]}' };
	};
	return { fetchImpl, calls };
}
const ctx = (a) => ({ acct: ACCT, token: 'T', fetchImpl: a.fetchImpl });
const throwsAsync = async (fn, re) => { try { await fn(); return false; } catch (e) { return re.test(String(e.message)); } };

// The reading.
ok('cachingDisabled: only an explicit caching.disabled === true', cachingDisabled({ caching: { disabled: true } }) === true
	&& cachingDisabled({ caching: { disabled: false } }) === false && cachingDisabled({ caching: {} }) === false
	&& cachingDisabled({}) === false && cachingDisabled(null) === false && cachingDisabled({ caching: { disabled: 'true' } }) === false);
ok('versionsFlagOn: reads the plain_text var from a binding list', versionsFlagOn([{ type: 'plain_text', name: 'OBJECT_CACHE_VERSIONS', text: 'on' }]) === true
	&& versionsFlagOn([{ type: 'plain_text', name: 'OBJECT_CACHE_VERSIONS', text: 'off' }]) === false && versionsFlagOn([]) === false);

// The gate.
{
	const a = api({ id: 'HDID', caching: { disabled: true } });
	const r = await versionsGate(ctx(a), { hyperdriveId: 'HDID', flagOn: true });
	ok('caching off: the gate passes, after one read of that config', r.checked === true && a.calls.length === 1 && /\/accounts\/fabcb25d9c7eb087110ec474a03e50d2\/hyperdrive\/configs\/HDID$/.test(a.calls[0].url));
}
{
	const a = api({ id: 'HDID', caching: { disabled: false, max_age: 60 } });
	ok('caching ON: refused, naming the config', await throwsAsync(() => versionsGate(ctx(a), { hyperdriveId: 'HDID', flagOn: true }), /HDID.*caches queries|caches queries.*HDID/));
}
{
	const a = api('fail');
	ok('the read fails: refused (fail closed)', await throwsAsync(() => versionsGate(ctx(a), { hyperdriveId: 'HDID', flagOn: true }), /could not read/));
}
{
	const a = api({ id: 'HDID' });
	ok('the caching field is missing: refused (fail closed)', await throwsAsync(() => versionsGate(ctx(a), { hyperdriveId: 'HDID', flagOn: true }), /caches queries|caching/));
}
{
	const a = api({ id: 'HDID', caching: { disabled: false } });
	const r = await versionsGate(ctx(a), { hyperdriveId: 'HDID', flagOn: false });
	ok('the flag off: no read at all, and no refusal', r.checked === false && a.calls.length === 0);
}
{
	const a = api({ id: 'HDID', caching: { disabled: true } });
	ok('the flag on without a Hyperdrive id: refused', await throwsAsync(() => versionsGate(ctx(a), { hyperdriveId: '', flagOn: true }), /Hyperdrive config id/));
}
{
	const a = api({ id: 'HDID', caching: { disabled: false } });
	const e = await (async () => { try { await versionsGate({ acct: ACCT, token: 'SECRET-TOKEN-VALUE', fetchImpl: a.fetchImpl }, { hyperdriveId: 'HDID', flagOn: true }); } catch (x) { return String(x.message); } return ''; })();
	ok('the refusal never carries the token', e && !e.includes('SECRET-TOKEN-VALUE'));
}

// #296: the flag is ON by default for approach A (the step 3 series; the lead's ruling). An explicit false turns it off.
ok('aVars: OBJECT_CACHE_VERSIONS=on by default', aVars({ siteOrigin: 'https://x' }).some((b) => b.name === 'OBJECT_CACHE_VERSIONS' && b.text === 'on'));
ok('aVars: objectCacheVersions false renders none', !aVars({ siteOrigin: 'https://x', objectCacheVersions: false }).some((b) => b.name === 'OBJECT_CACHE_VERSIONS'));
ok('aVars: a value that is not a boolean is refused', (() => { try { aVars({ siteOrigin: 'https://x', objectCacheVersions: 'no' }); return false; } catch { return true; } })());
ok('aVars: objectCacheVersions true renders OBJECT_CACHE_VERSIONS=on', aVars({ siteOrigin: 'https://x', objectCacheVersions: true }).some((b) => b.name === 'OBJECT_CACHE_VERSIONS' && b.text === 'on'));

// provisionSite: a kind 'a' site with the flag on and a caching config is refused BEFORE any resource is made.
async function provisionA(hd, versions) {
	const a = api(hd);
	const name = 'agate';
	const cfg = {
		kind: 'a', name, namespace: 'wp-wfp', kvId: 'KV', hostname: 'agate.skyphusionwp.dev',
		compatibilityDate: '2026-07-01', mainModule: 'index.js', modules: [{ name: 'index.js', content: 'export default {}' }],
		buckets: { media: mediaBucketName(name) },
		resourceBindings: aBindings({ mediaBucket: mediaBucketName(name), hyperdriveId: 'HDID', siteOrigin: 'https://agate.skyphusionwp.dev', objectCacheVersions: versions }),
	};
	let err = null;
	try { await provisionSite(ctx(a), cfg); } catch (e) { err = e; }
	return { err, calls: a.calls };
}
{
	const r = await provisionA({ id: 'HDID', caching: { disabled: false } }, true);
	const mutating = r.calls.filter((c) => c.method !== 'GET');
	ok('provisionSite (a, flag on, caching on): refused', r.err && /caches queries/.test(String(r.err.message)));
	ok('provisionSite: refused BEFORE any mutating call (no bucket, no KV, no upload)', mutating.length === 0);
}
{
	const r = await provisionA({ id: 'HDID', caching: { disabled: true } }, true);
	ok('provisionSite (a, flag on, caching off): the gate passes (provisioning goes on past it)', !r.err || !/caches queries|could not read/.test(String(r.err.message)));
	ok('provisionSite: the Hyperdrive read is the first call', r.calls.length > 0 && /\/hyperdrive\/configs\/HDID$/.test(r.calls[0].url));
}
{
	const r = await provisionA({ id: 'HDID', caching: { disabled: false } }, false);
	ok('provisionSite (a, flag off): no Hyperdrive read', !r.calls.some((c) => /hyperdrive/.test(c.url)));
}

console.log(`${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
