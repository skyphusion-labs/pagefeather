// node --test tests/cf-bridge.test.mjs
// Unit tests for the skyphusion-ai op bridge (issue #330). These are the
// aiEmbed and vectorize ops index.js serves, the SKYPHUSION_AI_CF_BRIDGE gate,
// and the topK and batch bounds. index.js cannot be imported under node (it
// loads php-wasm), so the wiring is checked as source, the same way the other
// op tests do.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
	AI_EMBED_MODEL,
	AI_EMBED_BATCH_MAX,
	VECTORIZE_TOPK_MAX,
	VECTORIZE_UPSERT_BATCH_MAX,
	VECTORIZE_ID_BATCH_MAX,
	VECTORIZE_ID_BYTES_MAX,
	VECTORIZE_DIMENSION_MAX,
	cfBridgeEnabled,
	aiEmbedOp,
	vectorizeOp,
} from '../cf-bridge.mjs';

function recording(impl) {
	const calls = [];
	const target = new Proxy({}, {
		get(_obj, prop) {
			if (prop === 'then') return undefined;
			if (typeof prop !== 'string') return undefined;
			return async (...args) => {
				calls.push({ name: prop, args });
				const fn = impl && impl[prop];
				if (typeof fn === 'function') return fn(...args);
				throw new Error('unexpected method ' + prop);
			};
		},
	});
	return { target, calls };
}

function many(n, make) {
	const out = [];
	for (let i = 0; i < n; i++) out.push(make(i));
	return out;
}

test('the bounds are the documented caps', () => {
	assert.equal(AI_EMBED_MODEL, '@cf/baai/bge-large-en-v1.5');
	assert.equal(AI_EMBED_BATCH_MAX, 100);
	assert.equal(VECTORIZE_TOPK_MAX, 50);
	assert.equal(VECTORIZE_UPSERT_BATCH_MAX, 1000);
	assert.equal(VECTORIZE_ID_BATCH_MAX, 1000);
	assert.equal(VECTORIZE_ID_BYTES_MAX, 64);
	assert.equal(VECTORIZE_DIMENSION_MAX, 1536);
});

test('aiEmbed returns { ok, data } from env.AI.run and sends only the bge-large model', async () => {
	const { target, calls } = recording({
		run(_model, input) {
			return { shape: [input.text.length, 2], data: input.text.map(() => [0.25, 0.5]) };
		},
	});
	const reply = await aiEmbedOp(target, { model: AI_EMBED_MODEL, text: ['red bats'] });
	assert.deepEqual(reply, { ok: true, data: [[0.25, 0.5]] });
	assert.equal(calls.length, 1);
	assert.equal(calls[0].name, 'run');
	assert.deepEqual(calls[0].args, [AI_EMBED_MODEL, { text: ['red bats'] }]);
});

test('aiEmbed refuses any other model and does not call the binding', async () => {
	const { target, calls } = recording({ run() { return { data: [[1]] }; } });
	const reply = await aiEmbedOp(target, { model: '@cf/baai/bge-base-en-v1.5', text: ['red bats'] });
	assert.deepEqual(reply, { ok: false, error: 'model not allowed' });
	assert.equal(calls.length, 0);
	const missing = await aiEmbedOp(target, { text: ['red bats'] });
	assert.equal(missing.ok, false);
	assert.equal(calls.length, 0);
});

test('aiEmbed refuses a text batch over AI_EMBED_BATCH_MAX and accepts one at the cap', async () => {
	const { target, calls } = recording({
		run(_model, input) {
			return { data: input.text.map(() => [0.1]) };
		},
	});
	const over = await aiEmbedOp(target, { model: AI_EMBED_MODEL, text: many(AI_EMBED_BATCH_MAX + 1, () => 'a') });
	assert.equal(over.ok, false);
	assert.equal(over.error, 'text batch exceeds AI_EMBED_BATCH_MAX');
	assert.equal(calls.length, 0);
	const at = await aiEmbedOp(target, { model: AI_EMBED_MODEL, text: many(AI_EMBED_BATCH_MAX, () => 'a') });
	assert.equal(at.ok, true);
	assert.equal(at.data.length, AI_EMBED_BATCH_MAX);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].args[1].text.length, AI_EMBED_BATCH_MAX);
});

test('aiEmbed with no AI binding returns { ok: false } and does not throw', async () => {
	for (const ai of [undefined, null, {}]) {
		const reply = await aiEmbedOp(ai, { model: AI_EMBED_MODEL, text: ['red bats'] });
		assert.equal(reply.ok, false);
		assert.equal(reply.error, 'no AI binding');
	}
});

test('aiEmbed turns a thrown binding error into { ok: false, error }', async () => {
	const { target } = recording({
		run() { throw new Error('x'.repeat(300)); },
	});
	const reply = await aiEmbedOp(target, { model: AI_EMBED_MODEL, text: ['red bats'] });
	assert.equal(reply.ok, false);
	assert.equal(reply.error.length, 200);
	assert.equal(reply.error, 'x'.repeat(200));
	await assert.doesNotReject(() => aiEmbedOp(target, { model: AI_EMBED_MODEL, text: ['red bats'] }));
});

test('vectorize query returns matches and forwards vector, topK and returnMetadata', async () => {
	const matches = [{ id: 'p6', score: 0.9, metadata: { title: 'Run', post_id: '6' } }];
	const { target, calls } = recording({
		query() { return { count: 1, matches }; },
	});
	const reply = await vectorizeOp(target, {
		op: 'query',
		vector: [0.1, 0.2],
		topK: 5,
		returnMetadata: 'all',
		filter: { post_type: 'post' },
	});
	assert.deepEqual(reply, { ok: true, matches });
	assert.equal(calls.length, 1);
	assert.equal(calls[0].name, 'query');
	assert.deepEqual(calls[0].args[0], [0.1, 0.2]);
	assert.deepEqual(calls[0].args[1], { topK: 5, returnMetadata: 'all' });
});

test('vectorize query reduces topK to VECTORIZE_TOPK_MAX', async () => {
	const { target, calls } = recording({
		query() { return { matches: [] }; },
	});
	const reply = await vectorizeOp(target, {
		op: 'query',
		vector: [0.1],
		topK: VECTORIZE_TOPK_MAX + 50,
		returnMetadata: 'all',
	});
	assert.equal(reply.ok, true);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].args[1].topK, VECTORIZE_TOPK_MAX);
	const exact = await vectorizeOp(target, { op: 'query', vector: [0.1], topK: VECTORIZE_TOPK_MAX });
	assert.equal(exact.ok, true);
	assert.equal(calls[1].args[1].topK, VECTORIZE_TOPK_MAX);
});

test('vectorize upsert sends vectors and returns { ok: true }', async () => {
	const vectors = [{ id: 'p6', values: [0.25, 0.5], metadata: { title: 'Run', post_id: '6' } }];
	const { target, calls } = recording({
		upsert() { return { mutationId: 'm1' }; },
	});
	const reply = await vectorizeOp(target, { op: 'upsert', vectors });
	assert.deepEqual(reply, { ok: true });
	assert.equal(calls.length, 1);
	assert.equal(calls[0].name, 'upsert');
	assert.deepEqual(calls[0].args[0], vectors);
});

test('vectorize upsert refuses a batch over VECTORIZE_UPSERT_BATCH_MAX and accepts one at the cap', async () => {
	const { target, calls } = recording({ upsert() { return { mutationId: 'm1' }; } });
	const row = () => ({ id: 'p', values: [0.1] });
	const over = await vectorizeOp(target, { op: 'upsert', vectors: many(VECTORIZE_UPSERT_BATCH_MAX + 1, row) });
	assert.equal(over.ok, false);
	assert.equal(over.error, 'vectors batch exceeds VECTORIZE_UPSERT_BATCH_MAX');
	assert.equal(calls.length, 0);
	const at = await vectorizeOp(target, { op: 'upsert', vectors: many(VECTORIZE_UPSERT_BATCH_MAX, row) });
	assert.deepEqual(at, { ok: true });
	assert.equal(calls.length, 1);
	assert.equal(calls[0].args[0].length, VECTORIZE_UPSERT_BATCH_MAX);
});

test('vectorize getByIds returns vectors', async () => {
	const vectors = [{ id: 'p6', values: [0.25], metadata: { title: 'Run' } }];
	const { target, calls } = recording({
		getByIds() { return vectors; },
	});
	const reply = await vectorizeOp(target, { op: 'getByIds', ids: ['p6'] });
	assert.deepEqual(reply, { ok: true, vectors });
	assert.equal(calls.length, 1);
	assert.equal(calls[0].name, 'getByIds');
	assert.deepEqual(calls[0].args[0], ['p6']);
});

test('vectorize deleteByIds returns { ok: true }', async () => {
	const { target, calls } = recording({
		deleteByIds() { return { mutationId: 'm2' }; },
	});
	const reply = await vectorizeOp(target, { op: 'deleteByIds', ids: ['p6'] });
	assert.deepEqual(reply, { ok: true });
	assert.equal(calls.length, 1);
	assert.equal(calls[0].name, 'deleteByIds');
	assert.deepEqual(calls[0].args[0], ['p6']);
});

test('vectorize refuses an id batch over VECTORIZE_ID_BATCH_MAX for getByIds and deleteByIds', async () => {
	const { target, calls } = recording({
		getByIds() { return []; },
		deleteByIds() { return { mutationId: 'm2' }; },
	});
	const ids = many(VECTORIZE_ID_BATCH_MAX + 1, (i) => 'p' + i);
	const got = await vectorizeOp(target, { op: 'getByIds', ids });
	const deleted = await vectorizeOp(target, { op: 'deleteByIds', ids });
	assert.equal(got.ok, false);
	assert.equal(got.error, 'ids batch exceeds VECTORIZE_ID_BATCH_MAX');
	assert.equal(deleted.ok, false);
	assert.equal(deleted.error, 'ids batch exceeds VECTORIZE_ID_BATCH_MAX');
	assert.equal(calls.length, 0);
	const at = await vectorizeOp(target, { op: 'deleteByIds', ids: many(VECTORIZE_ID_BATCH_MAX, (i) => 'p' + i) });
	assert.equal(at.ok, true);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].args[0].length, VECTORIZE_ID_BATCH_MAX);
});

test('vectorize refuses an id over VECTORIZE_ID_BYTES_MAX and a vector over VECTORIZE_DIMENSION_MAX', async () => {
	const { target, calls } = recording({
		deleteByIds() { return { mutationId: 'm' }; },
		upsert() { return { mutationId: 'm' }; },
	});
	const longId = 'a'.repeat(VECTORIZE_ID_BYTES_MAX + 1);
	const idReply = await vectorizeOp(target, { op: 'deleteByIds', ids: [longId] });
	assert.equal(idReply.ok, false);
	const wide = await vectorizeOp(target, {
		op: 'upsert',
		vectors: [{ id: 'p', values: many(VECTORIZE_DIMENSION_MAX + 1, () => 0.1) }],
	});
	assert.equal(wide.ok, false);
	assert.equal(calls.length, 0);
});

test('vectorize does not create, list or delete an index', async () => {
	const { target, calls } = recording({
		query() { return { matches: [] }; },
		describe() { return { dimensions: 1024 }; },
	});
	for (const op of ['create', 'list', 'delete', 'info', 'describe', 'insert']) {
		const reply = await vectorizeOp(target, { op, name: 'wp-wfp-demo-search' });
		assert.equal(reply.ok, false, op);
		assert.equal(reply.error, 'vectorize op not allowed');
	}
	assert.equal(calls.length, 0);
});

test('vectorize with no SEARCH_INDEX binding returns { ok: false } and does not throw', async () => {
	for (const index of [undefined, null]) {
		const reply = await vectorizeOp(index, { op: 'query', vector: [0.1], topK: 1, returnMetadata: 'all' });
		assert.equal(reply.ok, false);
		assert.equal(reply.error, 'no Vectorize binding');
	}
	const { target } = recording({
		query() { throw new Error('index down'); },
	});
	const thrown = await vectorizeOp(target, { op: 'query', vector: [0.1], topK: 1 });
	assert.equal(thrown.ok, false);
	assert.equal(thrown.error, 'index down');
	await assert.doesNotReject(() => vectorizeOp(target, { op: 'upsert', vectors: [{ id: 'p', values: [0.1] }] }));
});

test('SKYPHUSION_AI_CF_BRIDGE is on only when both AI and SEARCH_INDEX are bound', () => {
	const both = { AI: {}, SEARCH_INDEX: {} };
	assert.equal(cfBridgeEnabled(both), true);
	assert.equal(cfBridgeEnabled({ ...both, AI_ALT: 'off' }), true);
	assert.equal(cfBridgeEnabled({ AI: {} }), false);
	assert.equal(cfBridgeEnabled({ SEARCH_INDEX: {} }), false);
	assert.equal(cfBridgeEnabled({}), false);
	assert.equal(cfBridgeEnabled(null), false);
	assert.equal(cfBridgeEnabled(undefined), false);
});

test('index.js serves the two arms and boot writes the constant through the gate', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	assert.ok(src.includes("import { cfBridgeEnabled, aiEmbedOp, vectorizeOp } from './cf-bridge.mjs';"));
	assert.ok(src.includes('if (m.aiEmbed) return JSON.stringify(await aiEmbedOp(ENV && ENV.AI, m.aiEmbed));'));
	assert.ok(src.includes('if (m.vectorize) return JSON.stringify(await vectorizeOp(ENV && ENV.SEARCH_INDEX, m.vectorize));'));
	const gate = "if (cfBridgeEnabled(ENV)) lines.push(`define('SKYPHUSION_AI_CF_BRIDGE', true);`);";
	assert.equal(src.split(gate).length, 2);
	const alt = src.indexOf("define('SKYPHUSION_AI_ALT', true);");
	const bridge = src.indexOf("define('SKYPHUSION_AI_CF_BRIDGE', true);");
	assert.ok(alt > 0 && bridge > alt);
});
