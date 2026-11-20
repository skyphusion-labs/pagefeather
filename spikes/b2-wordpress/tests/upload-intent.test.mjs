// node --test spikes/b2-wordpress/tests/upload-intent.test.mjs (#1039, approach A). The lead's conditions (2026-11-20):
// markers only on media upload paths; the sweep deletes a file only for an UPLOAD marker older than 15 minutes AND no
// attachment referencing it (_wp_attached_file, every metadata size, original_image); each delete is an
// upload-orphan-swept event; the trigger is the throttled start of a media upload. A marker-less file is never touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isMediaUploadRequest, markerKey, MARKER_PREFIX, STALE_MS, sweepUploadOrphans, metadataNames, referenceQueries } from '../upload-intent.mjs';

test('markers only on the media upload paths that create an attachment', () => {
	for (const [m, p, s] of [
		['POST', '/wp-admin/async-upload.php', ''],
		['POST', '/wp-admin/media-new.php', ''],
		['POST', '/wp-admin/media-upload.php', '?type=image'],
		['POST', '/wp-json/wp/v2/media', ''],
		['POST', '/wp-json/wp/v2/media/', ''],
		['POST', '/', '?rest_route=/wp/v2/media'],
		['POST', '/index.php', '?rest_route=%2Fwp%2Fv2%2Fmedia'],
	]) assert.equal(isMediaUploadRequest(m, p, s), true, `${m} ${p}${s}`);
	for (const [m, p, s] of [
		['GET', '/wp-admin/async-upload.php', ''],
		['GET', '/wp-json/wp/v2/media', ''],
		['POST', '/wp-json/wp/v2/media/12', ''], // an update, not a create
		['POST', '/wp-json/wp/v2/font-faces', ''],
		['POST', '/wp-admin/admin-ajax.php', ''],
		['POST', '/wp-json/wc/v3/products', ''],
		['POST', '/', '?rest_route=/wp/v2/media/12'],
		['POST', '/wp-admin/post.php', ''],
	]) assert.equal(isMediaUploadRequest(m, p, s), false, `${m} ${p}${s}`);
});

test('a marker sits beside the file under its own prefix', () => {
	assert.equal(markerKey('uploads/2026/11/a.png'), MARKER_PREFIX + 'uploads/2026/11/a.png');
	assert.equal(STALE_MS, 15 * 60 * 1000);
});

test('metadataNames: the main file, every size and the -scaled original, from WordPress serialized metadata', () => {
	const meta = 'a:6:{s:5:"width";i:2560;s:6:"height";i:1920;s:4:"file";s:22:"2026/11/big-scaled.png";s:8:"filesize";i:9;s:5:"sizes";a:2:{s:9:"thumbnail";a:4:{s:4:"file";s:15:"big-150x150.png";s:5:"width";i:150;s:6:"height";i:150;s:9:"mime-type";s:9:"image/png";}s:6:"medium";a:4:{s:4:"file";s:15:"big-300x225.png";s:5:"width";i:300;s:6:"height";i:225;s:9:"mime-type";s:9:"image/png";}}s:14:"original_image";s:7:"big.png";}';
	assert.deepEqual(metadataNames(meta).sort(), ['big-150x150.png', 'big-300x225.png', 'big-scaled.png', 'big.png']);
	assert.deepEqual(metadataNames('not serialized'), []);
	assert.deepEqual(metadataNames(null), []);
});

test('referenceQueries: hex literals only (no user text in the SQL), the table prefix, and the directory', () => {
	const q = referenceQueries('wp_', "uploads/2026/11/o'brien.png");
	assert.equal(q.rel, "2026/11/o'brien.png");
	for (const s of [q.attached, q.meta]) {
		assert.doesNotMatch(s, /o'brien|brien/, 'the name never appears as text');
		assert.match(s, /X'[0-9a-f]+'/);
		assert.match(s, /wp_postmeta/);
	}
	assert.equal(referenceQueries('wp_', 'fonts/x.woff2'), null, 'not under uploads/: never a sweep candidate');
});

// A fake bucket and database for the sweep decision.
function world({ files = {}, markers = {}, attached = {}, metas = [] } = {}) {
	const objects = new Map();
	for (const [k, v] of Object.entries(files)) objects.set(k, { body: v, uploaded: new Date(0) });
	for (const [k, at] of Object.entries(markers)) objects.set(markerKey(k), { body: JSON.stringify({ kind: 'upload' }), uploaded: new Date(at), customMetadata: { kind: 'upload' } });
	const deleted = [];
	const bucket = {
		async list({ prefix }) { return { objects: [...objects.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, o]) => ({ key, uploaded: o.uploaded, customMetadata: o.customMetadata })), truncated: false }; },
		async delete(k) { deleted.push(k); objects.delete(k); },
	};
	const query = async (sql) => {
		if (/meta_key = '_wp_attached_file' AND meta_value = /.test(sql)) {
			const hex = /X'([0-9a-f]*)'/.exec(sql)[1];
			const rel = Buffer.from(hex, 'hex').toString('utf8');
			return { ok: true, columns: ['n'], rows: [[String(attached[rel] ? 1 : 0)]] };
		}
		if (/_wp_attachment_metadata/.test(sql)) return { ok: true, columns: ['v'], rows: metas.map((m) => [m]) };
		return { ok: false, error: 'unexpected sql' };
	};
	const events = [];
	return { objects, deleted, bucket, query, events, log: (e) => events.push(e), released: [] };
}
const NOW = 10 * 60 * 60 * 1000;
const OLD = NOW - 16 * 60 * 1000;
const FRESH = NOW - 2 * 60 * 1000;

test('a killed upload (file and marker left, no attachment) is swept after 15 minutes: file and marker both go, one event each', async () => {
	const w = world({ files: { 'uploads/2026/11/k.png': 'x', 'uploads/2026/11/k-150x150.png': 'x' }, markers: { 'uploads/2026/11/k.png': OLD, 'uploads/2026/11/k-150x150.png': OLD } });
	const r = await sweepUploadOrphans({ bucket: w.bucket, query: w.query, prefix: 'wp_', now: NOW, log: w.log, release: async (k) => w.released.push(k) });
	assert.deepEqual([...w.objects.keys()], [], 'nothing left');
	assert.equal(r.swept, 2);
	assert.deepEqual(w.events.map((e) => [e.m, e.key]).sort(), [['upload-orphan-swept', 'uploads/2026/11/k-150x150.png'], ['upload-orphan-swept', 'uploads/2026/11/k.png']]);
	assert.deepEqual(w.released.sort(), ['uploads/2026/11/k-150x150.png', 'uploads/2026/11/k.png'], 'the name reservations go too');
});

test('a FRESH marker is kept (its request may still be running)', async () => {
	const w = world({ files: { 'uploads/2026/11/f.png': 'x' }, markers: { 'uploads/2026/11/f.png': FRESH } });
	const r = await sweepUploadOrphans({ bucket: w.bucket, query: w.query, prefix: 'wp_', now: NOW, log: w.log });
	assert.deepEqual(w.deleted, []);
	assert.equal(r.swept, 0);
});

test('a -scaled original and every size of a LIVE attachment are never swept: only their markers go', async () => {
	const meta = 'a:3:{s:4:"file";s:22:"2026/11/big-scaled.png";s:5:"sizes";a:1:{s:9:"thumbnail";a:1:{s:4:"file";s:15:"big-150x150.png";}}s:14:"original_image";s:7:"big.png";}';
	const keys = ['uploads/2026/11/big.png', 'uploads/2026/11/big-scaled.png', 'uploads/2026/11/big-150x150.png'];
	const w = world({ files: Object.fromEntries(keys.map((k) => [k, 'x'])), markers: Object.fromEntries(keys.map((k) => [k, OLD])), attached: { '2026/11/big-scaled.png': true }, metas: [meta] });
	const r = await sweepUploadOrphans({ bucket: w.bucket, query: w.query, prefix: 'wp_', now: NOW, log: w.log });
	for (const k of keys) assert.equal(w.objects.has(k), true, `${k} is kept`);
	for (const k of keys) assert.equal(w.objects.has(markerKey(k)), false, `${k} marker is dropped`);
	assert.equal(r.swept, 0);
	assert.equal(r.kept, 3);
});

test('a file with NO marker is never touched, even with no attachment', async () => {
	const w = world({ files: { 'uploads/2026/11/plain.png': 'x', 'uploads/2026/11/form-upload.pdf': 'x' } });
	const r = await sweepUploadOrphans({ bucket: w.bucket, query: w.query, prefix: 'wp_', now: NOW, log: w.log });
	assert.deepEqual(w.deleted, []);
	assert.equal(r.markers, 0);
});

test('a database error keeps the file (fail safe) and the marker (the next sweep tries again)', async () => {
	const w = world({ files: { 'uploads/2026/11/e.png': 'x' }, markers: { 'uploads/2026/11/e.png': OLD } });
	const r = await sweepUploadOrphans({ bucket: w.bucket, query: async () => ({ ok: false, error: 'down' }), prefix: 'wp_', now: NOW, log: w.log });
	assert.deepEqual(w.deleted, []);
	assert.equal(r.errors, 1);
});

test('a marker that is not an upload marker is never acted on', async () => {
	const w = world({ files: { 'uploads/2026/11/n.png': 'x' } });
	w.objects.set(markerKey('uploads/2026/11/n.png'), { uploaded: new Date(OLD), customMetadata: { kind: 'other' } });
	const r = await sweepUploadOrphans({ bucket: w.bucket, query: w.query, prefix: 'wp_', now: NOW, log: w.log });
	assert.deepEqual(w.deleted, []);
	assert.equal(r.swept, 0);
});

test('index.js wires it on approach A only: marker BEFORE the put on an upload request, markers dropped when PHP answered, the throttled sweep before an upload PHP run', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	assert.match(src, /await uploadIntentMark\(B, op\.key\);[^\n]*\s*(?:await r2RecordIfNew\(B, op\.key\);[^\n]*\s*)?await B\.put\(op\.key/);
	assert.match(src, /uploadRun = dbHandler && isMediaUploadRequest\(req\.method, url\.pathname, url\.search\) \? \[\] : null;/);
	assert.match(src, /if \(uploadRun\) await uploadSweepThrottled\(env\);/);
	assert.match(src, /if \(uploadRun && uploadRun\.length\) \{[\s\S]{0,200}uploadIntentClear/);
});
