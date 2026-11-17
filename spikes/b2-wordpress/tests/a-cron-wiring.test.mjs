// #855: approach A Workers Cron scaffold (offline). Live acceptance is issue #855 bullets 1 to 4.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
	approachACronEnabled,
	approachACronScheduled,
	CRON_OBJECT_NAME,
	CRON_TICK_PATH,
	CRON_TICK_HEADER,
	cronTickRequest,
} from '../a-cron.mjs';
import {
	aCronTriggersToml,
	aPhpRuntimeBindingsToml,
	A_CRON_SCHEDULE_DEFAULT,
} from '../../../deploy/a-cron.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const indexSrc = readFileSync(join(here, '..', 'index.js'), 'utf8');

test('approachACronEnabled is off unless A_CRON=on and not PHP_IN_DO', () => {
	assert.equal(approachACronEnabled({}), false);
	assert.equal(approachACronEnabled({ A_CRON: 'on', PHP_IN_DO: 'on' }), false);
	assert.equal(approachACronEnabled({ A_CRON: 'on', SITE_ORIGIN: 'https://x/' }), true);
});

test('cronTickRequest targets the named object with the internal headers', () => {
	const calls = [];
	const PhpRuntime = {
		idFromName: (n) => {
			assert.equal(n, CRON_OBJECT_NAME);
			return 'id-cron';
		},
		get: (id) => {
			calls.push({ id });
			return {
				fetch: async (req) => {
					calls.push({ url: req.url, method: req.method, origin: req.headers.get('x-wp-public-origin'), tick: req.headers.get(CRON_TICK_HEADER) });
					return new Response('{"ok":true}', { status: 200 });
				},
			};
		},
	};
	const { stub, req } = cronTickRequest('https://site.example/', { PhpRuntime });
	assert.equal(req.method, 'POST');
	assert.ok(req.url.endsWith(CRON_TICK_PATH));
	assert.equal(req.headers.get(CRON_TICK_HEADER), '1');
	return stub.fetch(req).then(() => {
		assert.equal(calls.length, 2);
		assert.equal(calls[1].tick, '1');
		assert.equal(calls[1].origin, 'https://site.example/');
	});
});

test('approachACronScheduled waitUntils a cron object fetch and logs @event cron-tick', async () => {
	const got = [];
	const PhpRuntime = {
		idFromName: () => 'id',
		get: () => ({
			fetch: async () => new Response('{"ok":true}', { status: 200 }),
		}),
	};
	const logs = [];
	const orig = console.log;
	console.log = (m) => logs.push(String(m));
	const waited = [];
	try {
		await approachACronScheduled(
			{ scheduledTime: 1, cron: '* * * * *' },
			{ A_CRON: 'on', SITE_ORIGIN: 'https://pf.test/', PHP_RUNTIME: PhpRuntime },
			{ waitUntil: (p) => waited.push(p) },
			() => 'https://pf.test/',
		);
		assert.equal(waited.length, 1);
		await waited[0];
		assert.ok(logs.some((l) => l.startsWith('@event cron-tick ')));
	} finally {
		console.log = orig;
	}
});

test('deploy render helpers match a-settings.sh output shape', () => {
	assert.equal(aCronTriggersToml(), `[triggers]\ncrons = ["${A_CRON_SCHEDULE_DEFAULT}"]`);
	assert.match(aPhpRuntimeBindingsToml(), /name = "PHP_RUNTIME"/);
	assert.match(aPhpRuntimeBindingsToml(), /new_sqlite_classes = \["PhpRuntime"\]/);
});

test('index.js wires scheduled, the tick path, and PhpRuntime alarm on tick', () => {
	assert.match(indexSrc, /async scheduled\(event, env, ctx\)/);
	assert.match(indexSrc, /approachACronScheduled/);
	assert.match(indexSrc, /objectUrl\.pathname === CRON_TICK_PATH/);
	assert.match(indexSrc, /url\.pathname === CRON_TICK_PATH/);
	assert.ok(indexSrc.includes('await this.alarm();'), 'PhpRuntime tick runs alarm()');
});