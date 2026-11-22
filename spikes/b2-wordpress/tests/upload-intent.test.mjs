// node --test spikes/b2-wordpress/tests/upload-intent.test.mjs (#1039, approach A).
// The lead's ruling (2026-11-22): a marker before each new key, cleared when PHP answers any status,
// and a bounded sweep (attached / not attached / sub-size / fresh / SELECT error / 200 per run).
// An overwrite makes no marker. A failed marker write does not fail the put.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
	isMediaUploadRequest,
	markerKey,
	MARKER_PREFIX,
	STALE_MS,
	SWEEP_MAX,
	sweepUploadOrphans,
	metadataNames,
	referenceQuery,
	markNewKey,
	clearMarkers,
} from '../upload-intent.mjs';

test('the sweep starts on the media upload paths that create an attachment', () => {
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

test('a marker sits beside the file under its own prefix, and one run judges at most 200', () => {
	assert.equal(markerKey('uploads/2026/11/a.png'), MARKER_PREFIX + 'uploads/2026/11/a.png');
	assert.equal(STALE_MS, 15 * 60 * 1000);
	assert.equal(SWEEP_MAX, 200);
});

test('metadataNames: the main file, every size and the -scaled original, from WordPress serialized metadata', () => {
	const meta = 'a:6:{s:5:"width";i:2560;s:6:"height";i:1920;s:4:"file";s:22:"2026/11/big-scaled.png";s:8:"filesize";i:9;s:5:"sizes";a:2:{s:9:"thumbnail";a:4:{s:4:"file";s:15:"big-150x150.png";s:5:"width";i:150;s:6:"height";i:150;s:9:"mime-type";s:9:"image/png";}s:6:"medium";a:4:{s:4:"file";s:15:"big-300x225.png";s:5:"width";i:300;s:6:"height";i:225;s:9:"mime-type";s:9:"image/png";}}s:14:"original_image";s:7:"big.png";}';
	assert.deepEqual(metadataNames(meta).sort(), ['big-150x150.png', 'big-300x225.png', 'big-scaled.png', 'big.png']);
	assert.deepEqual(metadataNames('not serialized'), []);
	assert.deepEqual(metadataNames(null), []);
});

test('referenceQuery: one statement, hex literals only, meta_key equality on both branches', () => {
	const q = referenceQuery('wp_', "uploads/2026/11/o'brien.png");
	assert.equal(q.rel, "2026/11/o'brien.png");
	assert.equal(q.sql.includes(';'), false, 'one statement');
	assert.equal((q.sql.match(/UNION ALL/g) || []).length, 1);
	assert.doesNotMatch(q.sql, /o'brien|brien/, 'the name never appears as text');
	assert.match(q.sql, /X'[0-9a-f]+'/);
	assert.match(q.sql, /wp_postmeta/);
	assert.match(q.sql, /WHERE meta_key = '_wp_attached_file' AND meta_value = /);
	assert.match(q.sql, /WHERE meta_key = '_wp_attachment_metadata' AND /);
	assert.equal(referenceQuery('wp_', 'invoices/x.pdf'), null, 'not under uploads/: never deleted');
	assert.equal(referenceQuery('wp_', 'uploads/fonts/x.woff2'), null, 'fonts/ is not the dated attachment shape');
	assert.equal(referenceQuery('wp_', 'uploads/woocommerce_uploads/x.zip'), null, 'woocommerce_uploads/ is not the dated attachment shape');
	assert.equal(referenceQuery('wp_', 'uploads/wc-logs/x.log'), null, 'wc-logs/ is not the dated attachment shape');
	assert.equal(referenceQuery('wp_', 'uploads/2026/11/nested/x.jpg'), null, 'a further folder is not the dated attachment shape');
	assert.equal(referenceQuery('wp_', 'uploads/2026/1/x.jpg'), null, 'a month must be two digits');
	assert.equal(referenceQuery('wp_', 'uploads/2026/00/x.jpg'), null, '00 is not a month');
	assert.equal(referenceQuery('wp_', 'uploads/2026/13/x.jpg'), null, '13 is not a month');
	assert.ok(referenceQuery('wp_', 'uploads/2026/01/x.jpg'), 'month 01 is the dated attachment shape');
	assert.ok(referenceQuery('wp_', 'uploads/2026/12/x.jpg'), 'month 12 is the dated attachment shape');
	assert.ok(referenceQuery('wp_', 'uploads/2026/11/x.jpg'), 'uploads/YYYY/MM/<file> is asked of MySQL');
	assert.doesNotMatch(referenceQuery('bad-prefix', 'uploads/2026/11/a.png').sql, /bad-prefix/, 'a hyphen in the prefix is not SQL');
	assert.match(referenceQuery('bad-prefix', 'uploads/2026/11/a.png').sql, /badprefixpostmeta/);
});

// A fake bucket and database for the sweep decision. list() ignores limit, so a test can prove the cap.
function world({ files = {}, markers = {}, attached = {}, metas = [] } = {}) {
	const objects = new Map();
	for (const [k, v] of Object.entries(files)) objects.set(k, { body: v, uploaded: new Date(0) });
	for (const [k, at] of Object.entries(markers)) objects.set(markerKey(k), { body: '{}', uploaded: new Date(at) });
	const deleted = [];
	let listedLimit = null;
	const bucket = {
		async list({ prefix, limit }) {
			listedLimit = limit;
			return { objects: [...objects.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, o]) => ({ key, uploaded: o.uploaded })), truncated: false };
		},
		async delete(k) { deleted.push(k); objects.delete(k); },
		async head(k) { return objects.has(k) ? { size: 1 } : null; },
		async put(k, body) { objects.set(k, { body, uploaded: new Date() }); },
	};
	const calls = [];
	const query = async (sql) => {
		calls.push(sql);
		if (!/UNION ALL/.test(sql) || (sql.match(/UNION ALL/g) || []).length !== 1) return { ok: false, error: 'expected one statement' };
		const hexes = [...sql.matchAll(/X'([0-9a-f]*)'/g)].map((m) => Buffer.from(m[1], 'hex').toString('utf8'));
		const rel = hexes[0] || '';
		const needle = hexes[1] || '';
		const rows = [];
		if (attached[rel]) rows.push(['a', rel]);
		for (const meta of metas) if (needle && String(meta).includes(needle)) rows.push(['m', meta]);
		return { ok: true, columns: ['k', 'v'], rows };
	};
	const events = [];
	return { objects, deleted, bucket, query, calls, events, log: (e) => events.push(e), released: [], listed: () => listedLimit };
}
const NOW = 10 * 60 * 60 * 1000;
const OLD = NOW - 16 * 60 * 1000;
const FRESH = NOW - 2 * 60 * 1000;
const line = (w) => w.events.find((e) => e.m === 'media-sweep');

test('not attached: a killed upload is deleted after 15 minutes, with its marker and its name reservation', async () => {
	const w = world({ files: { 'uploads/2026/11/k.png': 'x', 'uploads/2026/11/k-150x150.png': 'x' }, markers: { 'uploads/2026/11/k.png': OLD, 'uploads/2026/11/k-150x150.png': OLD } });
	const r = await sweepUploadOrphans({ bucket: w.bucket, query: w.query, prefix: 'wp_', now: NOW, log: w.log, release: async (k) => w.released.push(k) });
	assert.deepEqual([...w.objects.keys()], []);
	assert.equal(r.deleted, 2);
	assert.equal(r.seen, 2);
	assert.equal(w.calls.length, 2, 'one SELECT per stale marker');
	assert.deepEqual(w.released.sort(), ['uploads/2026/11/k-150x150.png', 'uploads/2026/11/k.png']);
	assert.equal(line(w).deleted, 2);
	assert.equal(line(w).seen, 2);
	assert.equal(line(w)['kept-attached'], 0);
	assert.equal(line(w)['kept-error'], 0);
	assert.equal(line(w)['skipped-fresh'], 0);
});

test('attached: the main file of a live attachment keeps the file and drops only the marker', async () => {
	const w = world({ files: { 'uploads/2026/11/k.png': 'x' }, markers: { 'uploads/2026/11/k.png': OLD }, attached: { '2026/11/k.png': true } });
	const r = await sweepUploadOrphans({ bucket: w.bucket, query: w.query, prefix: 'wp_', now: NOW, log: w.log, release: async (k) => w.released.push(k) });
	assert.equal(w.objects.has('uploads/2026/11/k.png'), true);
	assert.equal(w.objects.has(markerKey('uploads/2026/11/k.png')), false);
	assert.equal(r.keptAttached, 1);
	assert.equal(r.deleted, 0);
	assert.deepEqual(w.released, []);
	assert.equal(line(w)['kept-attached'], 1);
});

test('sub-size attached: a thumbnail named only inside attachment metadata is kept, and a same basename in another month is not', async () => {
	const meta = 'a:3:{s:4:"file";s:22:"2026/11/big-scaled.png";s:5:"sizes";a:1:{s:9:"thumbnail";a:1:{s:4:"file";s:15:"big-150x150.png";}}s:14:"original_image";s:7:"big.png";}';
	const keys = ['uploads/2026/11/big.png', 'uploads/2026/11/big-scaled.png', 'uploads/2026/11/big-150x150.png'];
	const w = world({
		files: Object.fromEntries([...keys, 'uploads/2026/10/big-150x150.png'].map((k) => [k, 'x'])),
		markers: Object.fromEntries([...keys, 'uploads/2026/10/big-150x150.png'].map((k) => [k, OLD])),
		attached: { '2026/11/big-scaled.png': true },
		metas: [meta],
	});
	const r = await sweepUploadOrphans({ bucket: w.bucket, query: w.query, prefix: 'wp_', now: NOW, log: w.log, release: async (k) => w.released.push(k) });
	for (const k of keys) assert.equal(w.objects.has(k), true, `${k} is kept`);
	for (const k of keys) assert.equal(w.objects.has(markerKey(k)), false, `${k} marker is dropped`);
	assert.equal(w.objects.has('uploads/2026/10/big-150x150.png'), false, 'same basename, other month, no attachment there');
	assert.equal(r.keptAttached, 3);
	assert.equal(r.deleted, 1);
	assert.deepEqual(w.released, ['uploads/2026/10/big-150x150.png']);
	assert.equal(w.calls.length, 4, 'one SELECT per stale marker');
});

test('a FRESH marker is kept and is not asked of MySQL', async () => {
	const w = world({ files: { 'uploads/2026/11/f.png': 'x' }, markers: { 'uploads/2026/11/f.png': FRESH } });
	const r = await sweepUploadOrphans({ bucket: w.bucket, query: w.query, prefix: 'wp_', now: NOW, log: w.log });
	assert.deepEqual(w.deleted, []);
	assert.equal(r.skippedFresh, 1);
	assert.equal(r.deleted, 0);
	assert.equal(w.calls.length, 0);
	assert.equal(line(w)['skipped-fresh'], 1);
});

test('a file with NO marker is never touched, even with no attachment', async () => {
	const w = world({ files: { 'uploads/2026/11/plain.png': 'x', 'uploads/2026/11/form-upload.pdf': 'x' } });
	const r = await sweepUploadOrphans({ bucket: w.bucket, query: w.query, prefix: 'wp_', now: NOW, log: w.log });
	assert.deepEqual(w.deleted, []);
	assert.equal(r.seen, 0);
	assert.equal(line(w).seen, 0);
});

test('a SELECT error keeps the file and the marker', async () => {
	const w = world({ files: { 'uploads/2026/11/e.png': 'x' }, markers: { 'uploads/2026/11/e.png': OLD } });
	const r = await sweepUploadOrphans({ bucket: w.bucket, query: async () => ({ ok: false, error: 'down' }), prefix: 'wp_', now: NOW, log: w.log, release: async (k) => w.released.push(k) });
	assert.equal(w.objects.has('uploads/2026/11/e.png'), true);
	assert.equal(w.objects.has(markerKey('uploads/2026/11/e.png')), true);
	assert.equal(r.keptError, 1);
	assert.equal(r.deleted, 0);
	assert.deepEqual(w.released, []);
	assert.equal(line(w)['kept-error'], 1);
});

test('a SELECT that throws keeps the file and the marker', async () => {
	const w = world({ files: { 'uploads/2026/11/e.png': 'x' }, markers: { 'uploads/2026/11/e.png': OLD } });
	const r = await sweepUploadOrphans({ bucket: w.bucket, query: async () => { throw new Error('reset'); }, prefix: 'wp_', now: NOW, log: w.log });
	assert.equal(w.objects.has('uploads/2026/11/e.png'), true);
	assert.equal(w.objects.has(markerKey('uploads/2026/11/e.png')), true);
	assert.equal(r.keptError, 1);
});

test('bound: one run judges at most 200 markers even when the list returns more', async () => {
	const files = {};
	const markers = {};
	for (let i = 0; i < 250; i++) {
		const k = `uploads/2026/11/b${String(i).padStart(3, '0')}.png`;
		files[k] = 'x';
		markers[k] = OLD;
	}
	const w = world({ files, markers });
	const r = await sweepUploadOrphans({ bucket: w.bucket, query: w.query, prefix: 'wp_', now: NOW, log: w.log, release: async (k) => w.released.push(k) });
	assert.equal(w.listed(), 200);
	assert.equal(r.seen, 200);
	assert.equal(r.deleted, 200);
	const left = [...w.objects.keys()].filter((k) => !k.startsWith(MARKER_PREFIX));
	assert.equal(left.length, 50);
	assert.equal(left.includes('uploads/2026/11/b200.png'), true, 'the marker past the cap is not judged');
	assert.equal(w.calls.length, 200);
});

test('a key that is not under uploads/ is never deleted; its stale marker is dropped', async () => {
	const w = world({ files: { 'invoices/42-abc.pdf': 'x' }, markers: { 'invoices/42-abc.pdf': OLD } });
	const r = await sweepUploadOrphans({ bucket: w.bucket, query: w.query, prefix: 'wp_', now: NOW, log: w.log, release: async (k) => w.released.push(k) });
	assert.equal(w.objects.has('invoices/42-abc.pdf'), true);
	assert.equal(w.objects.has(markerKey('invoices/42-abc.pdf')), false);
	assert.equal(r.deleted, 0);
	assert.equal(r.keptOther, 1);
	assert.equal(r.keptShape, 0);
	assert.equal(w.calls.length, 0, 'no SELECT for a key the attachment query cannot name');
	assert.deepEqual(w.released, []);
	assert.equal(line(w)['kept-other'], 1);
	assert.equal(line(w)['kept-shape'], 0);
});

test('a stale marker on uploads/fonts/x.woff2 keeps the file and counts kept-shape', async () => {
	const w = world({ files: { 'uploads/fonts/x.woff2': 'x' }, markers: { 'uploads/fonts/x.woff2': OLD } });
	const r = await sweepUploadOrphans({ bucket: w.bucket, query: w.query, prefix: 'wp_', now: NOW, log: w.log, release: async (k) => w.released.push(k) });
	assert.equal(w.objects.has('uploads/fonts/x.woff2'), true);
	assert.equal(w.objects.has(markerKey('uploads/fonts/x.woff2')), false);
	assert.equal(r.deleted, 0);
	assert.equal(r.keptShape, 1);
	assert.equal(r.keptOther, 0);
	assert.equal(w.calls.length, 0, 'no SELECT: fonts are not the dated attachment shape');
	assert.deepEqual(w.released, []);
	assert.equal(line(w)['kept-shape'], 1);
});

test('a stale marker on uploads/woocommerce_uploads/x.zip keeps the file and counts kept-shape', async () => {
	const w = world({ files: { 'uploads/woocommerce_uploads/x.zip': 'x' }, markers: { 'uploads/woocommerce_uploads/x.zip': OLD } });
	const r = await sweepUploadOrphans({ bucket: w.bucket, query: w.query, prefix: 'wp_', now: NOW, log: w.log, release: async (k) => w.released.push(k) });
	assert.equal(w.objects.has('uploads/woocommerce_uploads/x.zip'), true);
	assert.equal(w.objects.has(markerKey('uploads/woocommerce_uploads/x.zip')), false);
	assert.equal(r.deleted, 0);
	assert.equal(r.keptShape, 1);
	assert.equal(w.calls.length, 0, 'no SELECT: woocommerce_uploads is not the dated attachment shape');
	assert.deepEqual(w.released, []);
	assert.equal(line(w)['kept-shape'], 1);
});

test('a stale marker on any other uploads/ key that is not uploads/YYYY/MM/<file> keeps the file and counts kept-shape', async () => {
	const keys = ['uploads/wc-logs/x.log', 'uploads/some-plugin/cache.bin', 'uploads/2026/11/nested/x.jpg', 'uploads/2026/1/x.jpg', 'uploads/2026/00/x.jpg', 'uploads/2026/13/x.jpg', 'uploads/file.png'];
	const w = world({
		files: Object.fromEntries(keys.map((k) => [k, 'x'])),
		markers: Object.fromEntries(keys.map((k) => [k, OLD])),
	});
	const r = await sweepUploadOrphans({ bucket: w.bucket, query: w.query, prefix: 'wp_', now: NOW, log: w.log, release: async (k) => w.released.push(k) });
	for (const k of keys) {
		assert.equal(w.objects.has(k), true, `${k} is kept`);
		assert.equal(w.objects.has(markerKey(k)), false, `${k} marker is dropped`);
	}
	assert.equal(r.deleted, 0);
	assert.equal(r.keptShape, keys.length);
	assert.equal(w.calls.length, 0, 'no SELECT outside the dated attachment shape');
	assert.deepEqual(w.released, []);
	assert.equal(line(w)['kept-shape'], keys.length);
});

test('a stale marker on uploads/2026/11/x.jpg with no attachment deletes it', async () => {
	const w = world({ files: { 'uploads/2026/11/x.jpg': 'x' }, markers: { 'uploads/2026/11/x.jpg': OLD } });
	const r = await sweepUploadOrphans({ bucket: w.bucket, query: w.query, prefix: 'wp_', now: NOW, log: w.log, release: async (k) => w.released.push(k) });
	assert.equal(w.objects.has('uploads/2026/11/x.jpg'), false);
	assert.equal(w.objects.has(markerKey('uploads/2026/11/x.jpg')), false);
	assert.equal(r.deleted, 1);
	assert.equal(r.keptShape, 0);
	assert.equal(w.calls.length, 1, 'one SELECT for the dated attachment shape');
	assert.deepEqual(w.released, ['uploads/2026/11/x.jpg']);
	assert.equal(line(w).deleted, 1);
	assert.equal(line(w)['kept-shape'], 0);
});

test('a new key gets a marker whose body is the request id and the time', async () => {
	const stored = new Map();
	const bucket = {
		async head() { return null; },
		async put(k, body) { stored.set(k, body); },
	};
	const mark = await markNewKey(bucket, 'uploads/2026/11/a.png', { reqId: 'req-9', now: 1234, log: () => {} });
	assert.equal(mark.marked, true);
	assert.deepEqual(JSON.parse(stored.get(markerKey('uploads/2026/11/a.png'))), { req: 'req-9', t: 1234 });
	assert.equal(stored.has('uploads/2026/11/a.png'), false, 'the marker write is not the file put');
});

test('an overwrite makes no marker, and the file put still runs', async () => {
	const puts = [];
	const bucket = {
		async head() { return { size: 4 }; },
		async put(k) { puts.push(k); },
	};
	const mark = await markNewKey(bucket, 'uploads/2026/11/a.png', { reqId: 'req-9', now: 1, log: () => {} });
	assert.equal(mark.marked, false);
	assert.equal(mark.reason, 'exists');
	assert.deepEqual(puts, []);
	await bucket.put('uploads/2026/11/a.png', 'bytes');
	assert.deepEqual(puts, ['uploads/2026/11/a.png']);
});

test('a failed marker write does not fail the put', async () => {
	const puts = [];
	const logs = [];
	const bucket = {
		async head() { return null; },
		async put(k, body) {
			puts.push(k);
			if (String(k).startsWith(MARKER_PREFIX)) throw new Error('r2 down');
			return body;
		},
	};
	const mark = await markNewKey(bucket, 'uploads/2026/11/a.png', { reqId: 'req-9', now: 1, log: (e) => logs.push(e) });
	assert.equal(mark.marked, false);
	assert.equal(mark.reason, 'could-not-mark');
	assert.equal(logs[0].m, 'could-not-mark');
	assert.equal(logs[0].key, 'uploads/2026/11/a.png');
	await bucket.put('uploads/2026/11/a.png', 'bytes');
	assert.deepEqual(puts, [markerKey('uploads/2026/11/a.png'), 'uploads/2026/11/a.png']);
});

test('clearMarkers deletes each marker and ignores a delete that fails', async () => {
	const gone = [];
	const bucket = { async delete(k) { if (k.endsWith('b.png')) throw new Error('no'); gone.push(k); } };
	await clearMarkers(bucket, ['uploads/a.png', 'uploads/b.png']);
	assert.deepEqual(gone, [markerKey('uploads/a.png')]);
});

test('index.js: mark before the put and the copy, clear on any PHP answer, sweep on upload and on the A_CRON tick', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	assert.match(src, /await uploadIntentMark\(B, op\.key\);[^\n]*\n\t+await r2RecordIfNew\(B, op\.key\);\n\t+await B\.put\(op\.key/);
	assert.match(src, /await uploadIntentMark\(B, op\.to\);/);
	assert.match(src, /await uploadIntentMark\(B, job\.dest\);/);
	assert.match(src, /markNewKey\(B, key, \{ reqId: runCallId \|\| ''/);
	assert.match(src, /if \(dbHandler && isMediaUploadRequest\(req\.method, url\.pathname, url\.search\)\) await uploadSweepThrottled\(env\);/);
	assert.match(src, /uploadRun = dbHandler \? \[\] : null;\n\t+lastMemTrace = null;\n\t+const r = await handler\.request/);
	assert.match(src, /const p = clearMarkers\(ENV\.MEDIA, keys\);\n\t+if \(ctx && typeof ctx\.waitUntil === 'function'\) ctx\.waitUntil\(p\);\n\t+else await p;/);
	assert.doesNotMatch(src, /dropMarkersOn/);
	assert.match(src, /expirationTtl: 600/);
	assert.match(src, /pf:upload-sweep/);
	const tick = src.slice(src.indexOf('objectUrl.pathname === CRON_TICK_PATH'), src.indexOf('const origin = raw.headers.get(ORIGIN_HEADER);'));
	assert.match(tick, /await runMediaSweep\(env\);/);
	assert.ok(!tick.includes('this.alarm()'), 'the tick still does not run a cron leg');
});
