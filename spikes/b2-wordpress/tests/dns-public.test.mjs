// node --test spikes/b2-wordpress/tests/dns-public.test.mjs (#1156)
// Inside the engine gethostbyname() returns emscripten's SYNTHETIC addresses (cldup.com 172.29.1.0, wordpress.org
// 172.29.2.0: measured locally), which are in 172.16.0.0/12, so wp_http_validate_url refused every external host. The
// Worker now resolves a name for real (DNS over HTTPS) and a host counts as external only when EVERY address is public,
// by stock WordPress's ranges plus loopback, link-local and the IPv6 private ranges.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPublicAddress, hostIsPublic, isSyntheticAddress, DOH_URL, DOH_TIMEOUT_MS } from '../dns-public.mjs';

test('#1156 isPublicAddress: the private, loopback, link-local and special ranges are not public', () => {
	for (const ip of ['10.0.0.1', '127.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.1.1', '0.0.0.0', '100.64.0.1', '::1', 'fc00::1', 'fd12::1', 'fe80::1', '::', '::ffff:10.0.0.1']) assert.equal(isPublicAddress(ip), false, ip);
	for (const ip of ['1.1.1.1', '104.16.1.1', '172.15.0.1', '172.32.0.1', '2606:4700::1111']) assert.equal(isPublicAddress(ip), true, ip);
	for (const ip of ['', 'x', '999.1.1.1', null]) assert.equal(isPublicAddress(ip), false, String(ip));
});
test('#1156 isSyntheticAddress: the engine DNS range only', () => {
	assert.equal(isSyntheticAddress('172.29.1.0'), true);
	assert.equal(isSyntheticAddress('172.29.255.0'), true);
	assert.equal(isSyntheticAddress('172.30.1.0'), false);
	assert.equal(isSyntheticAddress('10.0.0.1'), false);
});
const doh = (answers) => async (url) => {
	const type = new URL(url).searchParams.get('type');
	const a = answers[type] || [];
	return new Response(JSON.stringify({ Status: 0, Answer: a.map((d) => ({ type: type === 'A' ? 1 : 28, data: d, TTL: 120 })) }), { headers: { 'content-type': 'application/dns-json' } });
};
test('#1156 hostIsPublic: public only when every A and AAAA answer is public; a private answer or no answer is not', async () => {
	assert.equal(await hostIsPublic('cldup.com', { fetch: doh({ A: ['104.21.1.1'], AAAA: ['2606:4700::1'] }), cache: new Map(), now: 0 }), true);
	assert.equal(await hostIsPublic('evil.example', { fetch: doh({ A: ['104.21.1.1', '10.0.0.5'] }), cache: new Map(), now: 0 }), false, 'one private address is enough to refuse');
	assert.equal(await hostIsPublic('localtest.me', { fetch: doh({ A: ['127.0.0.1'] }), cache: new Map(), now: 0 }), false);
	assert.equal(await hostIsPublic('nx.example', { fetch: doh({}), cache: new Map(), now: 0 }), false, 'no address');
	assert.equal(await hostIsPublic('down.example', { fetch: async () => { throw new Error('net'); }, cache: new Map(), now: 0 }), false, 'a failed lookup is not public');
	assert.equal(await hostIsPublic('bad host!', { fetch: doh({ A: ['1.1.1.1'] }), cache: new Map(), now: 0 }), false, 'not a host name');
});
test('#1156 hostIsPublic caches by host for the record TTL (at most 300 s), so a host costs one lookup per isolate', async () => {
	let calls = 0;
	const f = doh({ A: ['104.21.1.1'] });
	const counting = async (u) => { calls++; return f(u); };
	const cache = new Map();
	assert.equal(await hostIsPublic('cldup.com', { fetch: counting, cache, now: 1000 }), true);
	const first = calls;
	assert.equal(await hostIsPublic('cldup.com', { fetch: counting, cache, now: 1000 + 60_000 }), true);
	assert.equal(calls, first, 'a minute later: from the cache');
	await hostIsPublic('cldup.com', { fetch: counting, cache, now: 1000 + 200_000 });
	assert.ok(calls > first, 'past the 120 s TTL: looked up again');
});
test('#1156 index.js answers the dnsPublic bridge op with hostIsPublic', async () => {
	const { readFileSync } = await import('node:fs');
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	assert.match(src, /import \{ hostIsPublic \} from '\.\/dns-public\.mjs';/);
	assert.match(src, /if \(m\.dnsPublic\) return \(await hostIsPublic\(m\.dnsPublic && m\.dnsPublic\.host\)\) \? '1' : '0';/);
});
// #1156 review (the lead): privacy first, so the resolver is Cloudflare's own DoH and nothing else; a short bound, so a
// lookup that hangs is a refusal (as a failed lookup is on stock); no new SSRF surface (a name that resolves to a
// private or loopback address is refused, pinned above and here).
test('#1156 review: the resolver is cloudflare-dns.com, and only it', async () => {
	const seen = [];
	await hostIsPublic('cldup.com', { fetch: async (u) => { seen.push(new URL(u).host); return new Response(JSON.stringify({ Answer: [{ type: 1, data: '104.21.1.1', TTL: 60 }] })); }, cache: new Map(), now: 0 });
	assert.ok(seen.length > 0 && seen.every((h) => h === 'cloudflare-dns.com'), JSON.stringify(seen));
	assert.equal(DOH_URL, 'https://cloudflare-dns.com/dns-query');
});
test('#1156 review: a lookup that hangs is refused within the bound (DOH_TIMEOUT_MS 1.5 s)', async () => {
	assert.equal(DOH_TIMEOUT_MS, 1500);
	const t0 = Date.now();
	const ok = await hostIsPublic('slow.example', { fetch: (u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted')))), cache: new Map(), now: 0, timeoutMs: 50 });
	assert.equal(ok, false);
	assert.ok(Date.now() - t0 < 1000, 'bounded: ' + (Date.now() - t0) + ' ms');
});
test('#1156 review: no new SSRF surface: names resolving to loopback or private addresses are refused', async () => {
	for (const [name, addr] of [['localtest.me', '127.0.0.1'], ['lan.example', '192.168.0.10'], ['meta.example', '169.254.169.254'], ['v6.example', '::1'], ['ula.example', 'fd00::1']]) {
		const v6 = addr.includes(':');
		const f = async (u) => { const t = new URL(u).searchParams.get('type'); const ans = (t === 'AAAA') === v6 ? [{ type: v6 ? 28 : 1, data: addr, TTL: 60 }] : []; return new Response(JSON.stringify({ Answer: ans })); };
		const fv6 = async (u) => { const t = new URL(u).searchParams.get('type'); if (t === 'A') return new Response(JSON.stringify({ Answer: [{ type: 1, data: '104.21.1.1', TTL: 60 }] })); return f(u); };
		assert.equal(await hostIsPublic(name, { fetch: v6 ? fv6 : f, cache: new Map(), now: 0 }), false, name + ' -> ' + addr);
	}
});
