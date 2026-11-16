// #734: the Worker logs a missing versions table ONCE per isolate (m: ocv, table: missing), from PHP's vmiss op, so
// deploy/doctor can warn that OBJECT_CACHE_VERSIONS=on does nothing on this site.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
test('#734: objectCacheOp answers vmiss and logs m: ocv once per isolate', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	const fn = src.slice(src.indexOf('async function objectCacheOp('), src.indexOf("\n}\n", src.indexOf('async function objectCacheOp(')));
	assert.ok(/if \(op\.op === 'vmiss'\) \{/.test(fn), 'the op is handled');
	assert.ok(/if \(!ocvMissLogged\) \{\n\t+ocvMissLogged = true;\n\t+console\.log\(JSON\.stringify\(\{ m: 'ocv', table: 'missing'/.test(fn), 'logged once per isolate');
	assert.ok(/^let ocvMissLogged = false;/m.test(src), 'one flag per isolate');
});
