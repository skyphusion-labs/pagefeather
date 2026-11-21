// node --test spikes/b2-wordpress/tests/fileinfo-sniff.test.mjs (#582 S2b). Needs npm ci and ./prepare.sh
// in spikes/b2-wordpress, python3, and a node with JSPI (24 or later).
//
// The trimmed fileinfo database (engine/fileinfo) must sniff every fixture of engine/fileinfo/fixtures.py
// exactly as the FULL database does. The oracle is the npm @php-wasm/web-8-3 3.1.62 engine: libmagic 5.43
// with php-src's full database, the "standard host". The engine under test is vendor/ (or ENGINE_JS and
// ENGINE_WASM); MAGIC_FILE=<a .mgc> makes the ORACLE engine open that database instead of its own, to try
// a database before it is built in (the red control below uses that).
//   accepted   the same MIME type as the full database (and wp-quirk: a type WordPress refuses itself)
//   disguise   the same MIME type, and the full database names a rejection signature (rejection.txt)
//   known-diff a DIFFERENT type: the documented limit of a trimmed database (#582); a change is noticed
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { B2, boot, engineUnderTest, upstreamRaw } from './engine-contract.mjs';
import { REASON_MAGIC, applyGate } from './require-env.mjs';

const ENG = join(B2, '../../engine/fileinfo');
const fx = mkdtempSync(join(tmpdir(), 'fileinfo582-'));
execFileSync('python3', ['-I', join(ENG, 'fixtures.py'), fx]);
const man = JSON.parse(readFileSync(join(fx, 'manifest.json'), 'utf8')).filter((m) => m.class !== 'refused');
const REJ = readFileSync(join(ENG, 'rejection.txt'), 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#')).map((l) => new RegExp(l.trim()));

// finfo_file MIME of every fixture, with the engine's own database or the .mgc at magic.
async function sniff(e, magic) {
	const { php } = await boot(e);
	php.mkdir('/fx');
	for (const m of man) php.writeFile('/fx/' + m.file, readFileSync(join(fx, m.file)));
	if (magic) php.writeFile('/db.mgc', readFileSync(magic));
	const code = `<?php $f = ${magic ? "finfo_open(FILEINFO_MIME_TYPE, '/db.mgc')" : 'finfo_open(FILEINFO_MIME_TYPE)'};
if (!$f) { echo json_encode(array('error' => 'no fileinfo database')); exit; }
$o = array(); foreach (glob('/fx/*') as $x) if (substr($x, -5) !== '.json') $o[basename($x)] = finfo_file($f, $x);
echo json_encode($o);`;
	const t = (await php.run({ code })).text;
	try { return JSON.parse(t); } catch { assert.fail('PHP printed no JSON: ' + t.slice(0, 200)); }
}

const oracle = upstreamRaw({});
const full = await sniff(oracle);
const target = process.env.MAGIC_FILE ? oracle : engineUnderTest();
const got = await sniff(target, process.env.MAGIC_FILE);
const label = process.env.MAGIC_FILE ? 'the database ' + process.env.MAGIC_FILE : target.name;

test('the oracle is the full database (it names the disguises)', () => {
	assert.ok(!full.error, full.error);
	for (const m of man.filter((x) => x.class === 'disguise')) assert.ok(REJ.some((r) => r.test(full[m.file])), m.file + ': the full database says ' + full[m.file] + ', not a rejection signature');
});
for (const cls of ['accepted', 'wp-quirk', 'disguise']) {
	test(label + ': every ' + cls + ' fixture sniffs as the full database does', () => {
		assert.ok(!got.error, got.error);
		const bad = man.filter((m) => m.class === cls && got[m.file] !== full[m.file]).map((m) => m.file + ': ' + got[m.file] + ', full ' + full[m.file]);
		assert.deepEqual(bad, [], bad.length + ' of ' + man.filter((m) => m.class === cls).length + ' differ');
	});
}
test(label + ': the known differences are still different (the documented limit, #582)', (t) => {
	assert.ok(!got.error, got.error);
	assert.ok(!full.error, full.error);
	const known = man.filter((x) => x.class === 'known-diff');
	const same = known.filter((m) => got[m.file] === full[m.file]);
	// No MAGIC_FILE, and every known-diff fixture matches the full database: this is
	// not the trimmed database. The lean-trim engine and a set MAGIC_FILE still run.
	if (!process.env.MAGIC_FILE && known.length > 0 && same.length === known.length) {
		if (applyGate(t, { reason: REASON_MAGIC })) return;
	}
	for (const m of known) assert.notEqual(got[m.file], full[m.file], m.file + ' now sniffs as the full database does: update the limit in #582');
});
