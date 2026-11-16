// #704: the Worker logs WHY edge-cache.php asked a page-cache purge (m: purge-why), from the message
// {cache: 'purge', why: '<hook>:<name>'}. One line per distinct reason in a request; the purge itself is
// asked as before. The reason is cut to 120 characters and is a name only (edge-cache.php).
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const i = src.indexOf("if (m.cache === 'purge') {");
const block = src.slice(i, src.indexOf('\n\t}\n', i) + 3);

test('the purge message still asks the purge', () => {
	assert.ok(i > 0, 'the handler exists');
	assert.match(block, /purgeRequested = true;/);
	assert.match(block, /return '\{\}';/);
});

test('it logs m: purge-why with the reason cut to 120 characters, only when a reason came', () => {
	assert.match(block, /if \(m\.why\) console\.log\(JSON\.stringify\(\{ m: 'purge-why', why: String\(m\.why\)\.slice\(0, 120\) \}\)\);/);
});
