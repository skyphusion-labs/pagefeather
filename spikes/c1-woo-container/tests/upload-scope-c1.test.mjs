// node --test spikes/c1-woo-container/tests/upload-scope-c1.test.mjs
// Variant c1 serves GET /wp-content/uploads/<path> from R2 in its own worker.js (serveUpload), not through b2's.
// It must refuse the folders a stock web server denies, with the SAME rule as b2: one protectedUploadKey, imported
// from spikes/b2-wordpress/upload-scope.mjs, so the two variants cannot drift. worker.js imports cloudflare:workers
// and @cloudflare/containers, so it cannot load under node; this reads its source, as the other c1 tests do.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');

test('c1 imports the one shared rule from b2 (no second copy to drift)', () => {
	assert.match(src, /import \{ protectedUploadKey \} from '\.\.\/b2-wordpress\/upload-scope\.mjs';/);
	assert.ok(!/function protectedUploadKey\(/.test(src), 'no local copy of the rule');
});
test('c1 serveUpload refuses a protected key with 403 BEFORE it reads R2', () => {
	const at = src.indexOf('async function serveUpload(');
	assert.ok(at > 0);
	const fn = src.slice(at, src.indexOf('\n}\n', at));
	const refuse = fn.indexOf("if (protectedUploadKey(key)) return new Response('forbidden', { status: 403 });");
	const get = fn.indexOf('env.MEDIA.get(key');
	assert.ok(refuse > 0, 'the refusal is there');
	assert.ok(get > refuse, 'and before the R2 read');
});
test('c1 serves uploads only through that function', () => {
	assert.equal((src.match(/env\.MEDIA\.get\(key/g) || []).length, 1, 'one uploads read');
	assert.equal((src.match(/return serveUpload\(req, env/g) || []).length, 1, 'one call site');
});
