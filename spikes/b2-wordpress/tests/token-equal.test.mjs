// node --test spikes/b2-wordpress/tests/token-equal.test.mjs (#1431)
// A plain === of the spike token can return at the first different byte. tokensEqual hashes both
// sides and compares the digests, so a wrong guess of any length is refused the same way.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { tokensEqual } from '../token-equal.mjs';

const SECRET = 'spike-token-value';

test('tokensEqual accepts the secret and refuses a wrong token of either length', async () => {
	assert.equal(await tokensEqual(SECRET, SECRET), true);
	assert.equal(await tokensEqual('spike-token-valuX', SECRET), false, 'same length, one byte off');
	assert.equal(await tokensEqual('nope', SECRET), false, 'shorter');
	assert.equal(await tokensEqual(SECRET + 'x', SECRET), false, 'longer');
	assert.equal(await tokensEqual('', SECRET), false);
	assert.equal(await tokensEqual(SECRET, ''), false);
	assert.equal(await tokensEqual('', ''), false);
	assert.equal(await tokensEqual(null, SECRET), false);
	assert.equal(await tokensEqual(SECRET, undefined), false);
	assert.equal(await tokensEqual(SECRET, SECRET + ''), true);
});

// A request header compared to a secret with === or !==. The local-dev gate compares the
// configured secret to a fixed string, not a request value, so it is not this pattern.
const PLAIN = /headers\.get\(\s*['"]x-(?:spike|snapshot)-token['"]\s*\)\s*[!=]==|[!=]==\s*(?:env\.)?(?:SPIKE_TOKEN|SNAPSHOT_TOKEN)\b/;

const SOURCES = [
	['index.js', '../index.js'],
	['sql-import.js', '../sql-import.js'],
	['perf-headers.mjs', '../perf-headers.mjs'],
	['db-snapshot.mjs', '../db-snapshot.mjs'],
	['wp-cli-access.mjs', '../wp-cli-access.mjs'],
	['wp-cli-endpoint.mjs', '../wp-cli-endpoint.mjs'],
	['worker.js', '../../c1-woo-container/worker.js'],
];

test('no request token is compared with === or !==', () => {
	const bad = [];
	for (const [name, rel] of SOURCES) {
		const src = readFileSync(new URL(rel, import.meta.url), 'utf8');
		for (const line of src.split('\n')) {
			const t = line.trim();
			if (t.startsWith('//') || t.startsWith('*')) continue;
			if (PLAIN.test(line)) bad.push(name + ': ' + t);
		}
	}
	assert.deepEqual(bad, []);
});

test('every token check calls the shared helper', () => {
	for (const [name, rel] of SOURCES) {
		const src = readFileSync(new URL(rel, import.meta.url), 'utf8');
		const direct = src.includes('tokensEqual(');
		const through = name === 'wp-cli-endpoint.mjs' && src.includes('timingSafeEqualString(');
		assert.ok(direct || through, name + ' does not call tokensEqual');
	}
	const helper = readFileSync(new URL('../token-equal.mjs', import.meta.url), 'utf8');
	assert.match(helper, /SHA-256/);
	assert.match(helper, /for \(let i = 0; i < 32; i\+\+\)/);
});
