// #962: the email editor list goes ahead of templates/lookup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPhpLock } from '../php-lock.mjs';
import { isTemplateEditorGet, isTemplateLookupGet, templateQueuePriority, templateLookupYield, templateLookupForwardYield, TEMPLATE_LOOKUP_YIELD_MS } from '../template-boot.mjs';

const u = (href) => new URL(href);

test('the list and one template are the editor GET; lookup is not', () => {
	assert.equal(isTemplateEditorGet('GET', u('https://x/wp-json/wp/v2/templates?context=edit')), true);
	assert.equal(isTemplateEditorGet('GET', u('https://x/wp-json/wp/v2/templates?context=view&per_page=100&_woocommerce_email_editor=fetch-all-templates')), true);
	assert.equal(isTemplateEditorGet('GET', u('https://x/?rest_route=/wp/v2/templates&context=edit')), true);
	assert.equal(isTemplateEditorGet('GET', u('https://x/wp-json/wp/v2/templates/twentytwentyfive//email-general?context=edit')), true);
	assert.equal(isTemplateEditorGet('GET', u('https://x/wp-json/wp/v2/templates/lookup?slug=email-general')), false);
	assert.equal(isTemplateEditorGet('POST', u('https://x/wp-json/wp/v2/templates')), false);
	assert.equal(isTemplateEditorGet('OPTIONS', u('https://x/wp-json/wp/v2/templates')), false);
	assert.equal(isTemplateLookupGet('GET', u('https://x/wp-json/wp/v2/templates/lookup?slug=email-general')), true);
	assert.equal(isTemplateLookupGet('GET', u('https://x/?rest_route=/wp/v2/templates/lookup&slug=email-general')), true);
	assert.equal(isTemplateLookupGet('GET', u('https://x/wp-json/wp/v2/templates?context=edit')), false);
	assert.equal(templateQueuePriority('GET', u('https://x/wp-json/wp/v2/templates?context=edit')), 1);
	assert.equal(templateQueuePriority('GET', u('https://x/wp-json/wp/v2/templates/lookup?slug=email-general')), 0);
});

test('an idle lookup waits; a busy lookup and the list do not', () => {
	const lookup = u('https://x/wp-json/wp/v2/templates/lookup?slug=email-general');
	const list = u('https://x/wp-json/wp/v2/templates?context=edit');
	assert.equal(templateLookupYield('GET', lookup, { running: 0, waiting: 0 }), TEMPLATE_LOOKUP_YIELD_MS);
	assert.equal(templateLookupYield('GET', lookup, { running: 1, waiting: 0 }), 0, 'already running: another wait would only add delay');
	assert.equal(templateLookupYield('GET', lookup, { running: 0, waiting: 1 }), 0);
	assert.equal(templateLookupYield('GET', list, { running: 0, waiting: 0 }), 0);
	assert.equal(templateLookupForwardYield('GET', lookup), TEMPLATE_LOOKUP_YIELD_MS, 'the worker waits on every lookup');
	assert.equal(templateLookupForwardYield('GET', list), 0);
	assert.equal(TEMPLATE_LOOKUP_YIELD_MS > 0 && TEMPLATE_LOOKUP_YIELD_MS < 1000, true);
});

test('a queued list runs before an earlier lookup, and a lookup that has started is not stopped', async () => {
	let t = 0;
	const timers = [];
	const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
	const lock = createPhpLock({
		staleMs: 60000,
		now: () => t,
		setTimer: (fn, ms) => { const id = timers.length + 1; timers.push({ id, at: t + ms, fn }); return id; },
		clearTimer: (id) => { const i = timers.findIndex((x) => x.id === id); if (i >= 0) timers.splice(i, 1); },
	});
	const job = (ms, v) => () => new Promise((res) => { const id = timers.length + 1; timers.push({ id, at: t + ms, fn: () => res(v) }); });
	const order = [];
	let live = 0;
	let maxLive = 0;
	const run = (ms, v, priority) => lock.run(() => { live++; maxLive = Math.max(maxLive, live); return job(ms, v)().then((x) => { live--; order.push(x); return x; }); }, { priority });
	// A boot call has started. Lookup is queued ahead of the list. The list still runs first.
	const head = run(1000, 'head', 0);
	const lookup = run(5000, 'lookup', 0);
	const list = run(1000, 'list', 1);
	await flush();
	t = 1000;
	for (const x of timers.splice(0)) if (x.at <= t) x.fn();
	await flush();
	t = 2000;
	for (const x of timers.splice(0)) if (x.at <= t) x.fn();
	await flush();
	assert.equal(await list, 'list');
	assert.deepEqual(order.slice(0, 2), ['head', 'list'], 'the list finishes while lookup is still queued');
	t = 8000;
	for (const x of timers.splice(0)) if (x.at <= t) x.fn();
	await flush();
	assert.equal(await lookup, 'lookup');
	assert.equal(await head, 'head');
	assert.deepEqual(order, ['head', 'list', 'lookup']);
	assert.equal(maxLive, 1, 'still one PHP run');
});

test('index.js yields an idle lookup and passes the list priority on both PHP paths', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	const obj = src.slice(src.indexOf('\tasync fetch(raw) {'), src.indexOf('function phpObjectName('));
	const yieldAt = obj.indexOf('templateLookupYield(req.method, url, phpLock)');
	const run = obj.indexOf('const objectRun = await withPhp(');
	const between = obj.slice(yieldAt, run);
	assert.ok(yieldAt > 0 && yieldAt < run && between.includes('phpPending++'), 'the beat is before this request counts as pending, and before the lock');
	assert.ok(obj.includes('priority: templateQueuePriority(req.method, url)'), 'the object passes the priority');
	assert.ok(src.includes("const workerRun = await withPhp(() => handle(req, env, url, spikeOk, maxBody, ctx), { shedMs: phpShedMs(env, false), priority: templateQueuePriority(req.method, url), staleAction: 'shed' })"), 'the worker path too (with #1060 staleAction shed)');
	assert.ok(src.includes('templateLookupYield(req.method, url, phpLock)'), 'the worker yields too');
	const forward = src.indexOf('templateLookupForwardYield(req.method, url)');
	const send = src.indexOf('return toPhpObject(req, env, url, ctx);', forward);
	assert.ok(forward > 0 && send > forward, 'a lookup is forwarded after the beat');
});
