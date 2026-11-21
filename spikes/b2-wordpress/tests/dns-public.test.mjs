// node --test spikes/b2-wordpress/tests/dns-public.test.mjs (#1156)
// Inside the engine gethostbyname() returns emscripten's SYNTHETIC addresses (cldup.com 172.29.1.0, wordpress.org
// 172.29.2.0: measured locally), which are in 172.16.0.0/12, so wp_http_validate_url refused every external host. The
// Worker now resolves a name for real (DNS over HTTPS) and a host counts as external only when EVERY address is public,
// by stock WordPress's ranges plus loopback, link-local and the IPv6 private ranges.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPublicAddress, hostIsPublic, isSyntheticAddress } from '../dns-public.mjs';

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
