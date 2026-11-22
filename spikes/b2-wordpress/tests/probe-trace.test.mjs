// node --test spikes/b2-wordpress/tests/probe-trace.test.mjs (#1328, the lead's ruling)
// Two reads of the same leaked cookie GET disagreed (#1328): each rested on timing alone, because nothing links the events
// of one request (every Observability row has its own traceId, and a request answered without PHP logs no m: line). A
// client sends x-pf-probe: <id>; the Worker logs m: probe-trace with that id at each entrypoint it reaches: the gateway's
// entry (and whether it is the placed loopback), the Pages entrypoint, and the start of a PHP run. A GET whose id appears on
// NO line was answered before our code ran (a cache in front); one with lines shows which entrypoints served it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const req = (h) => new Request('https://x.example/shop/?a=1', { headers: h });
test('probeTraceId: a safe id only (8 to 64 of A-Z a-z 0-9 -), else null', async () => {
	const m = await import('../probe-trace.mjs');
	assert.equal(m.PROBE_TRACE_HEADER, 'x-pf-probe');
	assert.equal(m.probeTraceId(req({ 'x-pf-probe': 'a1b2c3d4-0000' })), 'a1b2c3d4-0000');
	assert.equal(m.probeTraceId(req({})), null);
	assert.equal(m.probeTraceId(req({ 'x-pf-probe': 'short' })), null, 'too short');
	assert.equal(m.probeTraceId(req({ 'x-pf-probe': 'x'.repeat(65) })), null, 'too long');
	assert.equal(m.probeTraceId(req({ 'x-pf-probe': 'abc{}defgh"' })), null, 'no injection into the log');
});
test('probeTrace logs one m: probe-trace line with the id, the entrypoint and the path (never the query)', async () => {
	const m = await import('../probe-trace.mjs');
	const out = [];
	m.probeTrace(req({ 'x-pf-probe': 'abcdefgh' }), 'pages', { log: (o) => out.push(o) });
	assert.deepEqual(out, [{ m: 'probe-trace', id: 'abcdefgh', ep: 'pages', method: 'GET', path: '/shop/' }]);
	// The #1296 hand-off's loopback (x-pf-pages-render: 1, on the #1277 arms) is named at the gateway, with no import of
	// pages-render.mjs (main does not have it).
	m.probeTrace(req({ 'x-pf-probe': 'abcdefgh', 'x-pf-pages-render': '1' }), 'gateway', { log: (o) => out.push(o) });
	assert.equal(out[1].ep, 'gateway-loopback');
	m.probeTrace(req({ 'x-pf-probe': 'abcdefgh' }), 'gateway', { log: (o) => out.push(o) });
	assert.equal(out[2].ep, 'gateway');
	out.length = 1;
	m.probeTrace(req({}), 'pages', { log: (o) => out.push(o) });
	assert.equal(out.length, 1, 'no header: no line');
});
test('index.js logs it at the gateway entry, the Pages entry and the PHP run start', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	const gw = src.slice(src.indexOf('export default {'), src.indexOf('export default {') + 600);
	assert.match(gw, /async fetch\(req, env, ctx\) \{\n\t\tprobeTrace\(req, 'gateway'\);/, 'the first line of the gateway');
	const pages = src.slice(src.indexOf('export class Pages extends WorkerEntrypoint {'), src.indexOf('export default {'));
	assert.match(pages, /async fetch\(req\) \{\n\t\tprobeTrace\(req, 'pages'\);/, 'the first line of Pages');
	const h = src.slice(src.indexOf('async function handleInner(req, env, url, spikeOk, maxBody, ctx) {'), src.indexOf('async function handleInner(req, env, url, spikeOk, maxBody, ctx) {') + 300);
	assert.match(h, /probeTrace\(req, 'php'\);/, 'a PHP run');
});

// The lead's question on #1366: what does this cost on normal traffic (no x-pf-probe)? It must be NO line and no work past
// one header read. A counted url getter proves the URL is never read; a counted get() proves one header read.
test('no x-pf-probe (normal traffic): no line, and nothing past ONE header read (the URL is never touched)', async () => {
	const m = await import('../probe-trace.mjs');
	const out = [];
	const mk = (val) => {
		// Counted, not thrown: probeTrace reads the URL inside try/catch, which would swallow a throw (a mutant that read the
		// URL first survived the throwing version).
		const reads = [];
		const urlReads = { n: 0 };
		return { reads, urlReads, req: { method: 'GET', get url() { urlReads.n++; return 'https://x.example/shop/'; }, headers: { get: (k) => { reads.push(k); return val; } } } };
	};
	for (const [label, val] of [['no header', null], ['an invalid id', 'bad id!']]) {
		const { req, reads, urlReads } = mk(val);
		m.probeTrace(req, 'gateway', { log: (o) => out.push(o) });
		assert.deepEqual(reads, ['x-pf-probe'], label + ': exactly one header read');
		assert.equal(urlReads.n, 0, label + ': the URL is never read');
	}
	assert.equal(out.length, 0, 'no line at all');
});
