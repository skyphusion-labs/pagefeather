import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

// The mu-plugins every build ships are one entry per line (MU_PLUGINS in build.sh). On one line, any two PRs that each
// added a plugin conflicted wherever the name went (three rebases of #1167 in one night, 2026-11-21).
test('build.sh: MU_PLUGINS is one existing php/ file per line, no duplicates, copied in one cp', () => {
	const build = readFileSync(new URL('../build.sh', import.meta.url), 'utf8');
	const m = /\nMU_PLUGINS=\(\n((?:\t[^\n]*\n)+)\)\ncp "\$\{MU_PLUGINS\[@\]\}" "\$wp\/wp-content\/mu-plugins\/"\n/.exec(build);
	assert.ok(m, 'the array and its cp');
	const entries = m[1].split('\n').filter(Boolean).map((l) => l.slice(1));
	assert.ok(entries.length > 30, 'the whole list: ' + entries.length);
	for (const e of entries) {
		assert.match(e, /^php\/[a-z0-9-]+\.php$/, 'one plain path per line: ' + e);
		assert.ok(existsSync(new URL('../' + e, import.meta.url)), e + ' exists');
	}
	assert.equal(new Set(entries).size, entries.length, 'no duplicates');
	assert.doesNotMatch(build, /\ncp php\/r2-uploads\.php /, 'never the one-line list again');
});
