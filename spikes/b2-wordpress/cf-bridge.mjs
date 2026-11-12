// Op bridge for skyphusion-ai embeddings and Vectorize (issue #330, the Worker
// half of skyphusion-ai#193). index.js imports these for the aiEmbed and
// vectorize arms of handleMessage, and for the SKYPHUSION_AI_CF_BRIDGE gate.
// tests/cf-bridge.test.mjs tests them. No side effects, so both can import
// without booting a Worker.
//
// The plugin sends one JSON object, { aiEmbed: {...} } or { vectorize: {...} },
// and accepts { ok: true, data } or { ok: true } plus matches or vectors.
// A failure is { ok: false, error }. This module never throws: a binding
// error stays on that object, so it does not cross the PHP bridge.
//
// Bounds, named here and nowhere else. Read 2026-11-12.
//   bge-large text array maxItems 100:
//     https://developers.cloudflare.com/workers-ai/models/bge-large-en-v1.5/
//   Vectorize topK 50 when values or metadata are returned, upsert 1000 per
//   Workers batch, id 64 bytes, dimensions 1536:
//     https://developers.cloudflare.com/vectorize/platform/limits/
//   deleteByIds is 1000 ids per call (Workers binding). getByIds uses the
//   same cap, so one id batch cannot outgrow the upsert batch.
// The plugin asks for returnMetadata "all" and never sends a larger batch
// than these caps. topK above the cap is reduced to it (a result limit).
// A batch above its cap is refused: dropping part of an upsert or an id
// list would write or delete a different set than the caller asked for.

export const AI_EMBED_MODEL = '@cf/baai/bge-large-en-v1.5';
export const AI_EMBED_BATCH_MAX = 100;
export const VECTORIZE_TOPK_MAX = 50;
export const VECTORIZE_UPSERT_BATCH_MAX = 1000;
export const VECTORIZE_ID_BATCH_MAX = 1000;
export const VECTORIZE_ID_BYTES_MAX = 64;
export const VECTORIZE_DIMENSION_MAX = 1536;

const ERROR_MAX = 200;
const RETURN_METADATA = new Set(['all', 'indexed', 'none']);

// Both bindings, or neither. Binding presence is the switch, the same way
// SKYPHUSION_AI_ALT is a define in boot(). No gate var: the vectorize-search
// descriptor adds AI and SEARCH_INDEX and nothing else.
export function cfBridgeEnabled(env) {
	return !!(env && env.AI && env.SEARCH_INDEX);
}

function fail(error) {
	let s = error == null ? '' : String(error);
	s = s.replace(/\s+/g, ' ').trim();
	if (!s) s = 'bridge error';
	if (s.length > ERROR_MAX) s = s.slice(0, ERROR_MAX);
	return { ok: false, error: s };
}

function asArray(v) {
	if (Array.isArray(v)) return v;
	if (ArrayBuffer.isView(v)) return Array.from(v);
	return null;
}

// A dense list of finite numbers, or null. Empty is null: a vector and an
// embedding row both have a length.
function numberList(v) {
	const list = asArray(v);
	if (!list || list.length === 0 || list.length > VECTORIZE_DIMENSION_MAX) return null;
	for (let i = 0; i < list.length; i++) {
		if (typeof list[i] !== 'number' || !Number.isFinite(list[i])) return null;
	}
	return list;
}

function idBytes(id) {
	return new TextEncoder().encode(id).byteLength;
}

export async function aiEmbedOp(ai, op) {
	try {
		if (!ai || typeof ai.run !== 'function') return fail('no AI binding');
		if (!op || op.model !== AI_EMBED_MODEL) return fail('model not allowed');
		if (!Array.isArray(op.text) || op.text.length === 0) return fail('text must be a list of strings');
		if (op.text.length > AI_EMBED_BATCH_MAX) return fail('text batch exceeds AI_EMBED_BATCH_MAX');
		const text = [];
		for (let i = 0; i < op.text.length; i++) {
			if (typeof op.text[i] !== 'string' || op.text[i].length === 0) return fail('text must be a list of strings');
			text.push(op.text[i]);
		}
		// The model id is the constant, not the request field, so a caller
		// cannot point env.AI.run at another model.
		const result = await ai.run(AI_EMBED_MODEL, { text });
		const raw = result && Array.isArray(result.data) ? result.data : Array.isArray(result) ? result : null;
		if (!raw || raw.length !== text.length) return fail('embeddings returned no data');
		const data = [];
		for (let i = 0; i < raw.length; i++) {
			const row = numberList(raw[i]);
			if (!row) return fail('embeddings returned no data');
			data.push(row);
		}
		return { ok: true, data };
	} catch (e) {
		return fail(e && e.message ? e.message : e);
	}
}

function boundTopK(value) {
	if (value == null) return { ok: true, topK: undefined };
	if (typeof value !== 'number' || !Number.isFinite(value)) return fail('topK is not a number');
	let n = Math.trunc(value);
	if (n < 1) n = 1;
	if (n > VECTORIZE_TOPK_MAX) n = VECTORIZE_TOPK_MAX;
	return { ok: true, topK: n };
}

function readIds(ids) {
	if (!Array.isArray(ids) || ids.length === 0) return fail('ids must be a list of strings');
	if (ids.length > VECTORIZE_ID_BATCH_MAX) return fail('ids batch exceeds VECTORIZE_ID_BATCH_MAX');
	const out = [];
	for (let i = 0; i < ids.length; i++) {
		const id = ids[i];
		if (typeof id !== 'string' || id.length === 0 || idBytes(id) > VECTORIZE_ID_BYTES_MAX) return fail('ids must be a list of strings');
		out.push(id);
	}
	return { ok: true, ids: out };
}

function readVectors(vectors) {
	if (!Array.isArray(vectors) || vectors.length === 0) return fail('vectors must be a list');
	if (vectors.length > VECTORIZE_UPSERT_BATCH_MAX) return fail('vectors batch exceeds VECTORIZE_UPSERT_BATCH_MAX');
	const out = [];
	for (let i = 0; i < vectors.length; i++) {
		const row = vectors[i];
		if (!row || typeof row !== 'object' || typeof row.id !== 'string' || row.id.length === 0 || idBytes(row.id) > VECTORIZE_ID_BYTES_MAX) {
			return fail('vectors must be a list');
		}
		const values = numberList(row.values);
		if (!values) return fail('vectors must be a list');
		const one = { id: row.id, values };
		if (row.metadata !== undefined) {
			if (!row.metadata || typeof row.metadata !== 'object' || Array.isArray(row.metadata)) return fail('vectors must be a list');
			one.metadata = row.metadata;
		}
		out.push(one);
	}
	return { ok: true, vectors: out };
}

async function vectorizeQuery(index, op) {
	const vector = numberList(op.vector);
	if (!vector) return fail('vector must be a list of numbers');
	const top = boundTopK(op.topK);
	if (!top.ok) return top;
	const options = {};
	if (top.topK !== undefined) options.topK = top.topK;
	if (op.returnMetadata !== undefined) {
		const meta = op.returnMetadata;
		const allowed = meta === true || meta === false || (typeof meta === 'string' && RETURN_METADATA.has(meta));
		if (!allowed) return fail('returnMetadata is not allowed');
		options.returnMetadata = meta;
	}
	const result = await index.query(vector, options);
	if (!result || !Array.isArray(result.matches)) return fail('vectorize query returned no matches');
	return { ok: true, matches: result.matches };
}

async function vectorizeUpsert(index, op) {
	const parsed = readVectors(op.vectors);
	if (!parsed.ok) return parsed;
	await index.upsert(parsed.vectors);
	return { ok: true };
}

async function vectorizeGetByIds(index, op) {
	const parsed = readIds(op.ids);
	if (!parsed.ok) return parsed;
	const result = await index.getByIds(parsed.ids);
	const vectors = Array.isArray(result) ? result : result && Array.isArray(result.vectors) ? result.vectors : null;
	if (!vectors) return fail('vectorize getByIds returned no vectors');
	return { ok: true, vectors };
}

async function vectorizeDeleteByIds(index, op) {
	const parsed = readIds(op.ids);
	if (!parsed.ok) return parsed;
	await index.deleteByIds(parsed.ids);
	return { ok: true };
}

// Data plane only. create, list, delete, describe and anything else are
// refused before a method is read, so this cannot create, list or delete
// the index. The binding has no method that does those three; the
// provisioner creates the index.
export async function vectorizeOp(index, op) {
	try {
		if (!index) return fail('no Vectorize binding');
		if (!op || typeof op !== 'object') return fail('vectorize op not allowed');
		if (op.op === 'query') return await vectorizeQuery(index, op);
		if (op.op === 'upsert') return await vectorizeUpsert(index, op);
		if (op.op === 'getByIds') return await vectorizeGetByIds(index, op);
		if (op.op === 'deleteByIds') return await vectorizeDeleteByIds(index, op);
		return fail('vectorize op not allowed');
	} catch (e) {
		return fail(e && e.message ? e.message : e);
	}
}
