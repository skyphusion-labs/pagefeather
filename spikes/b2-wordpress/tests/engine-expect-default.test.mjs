// node --test spikes/b2-wordpress/tests/engine-expect-default.test.mjs (#771). The engine contract's default
// expectation follows the engine prepare.sh vendored (vendor/engine.mjs). Does not boot an engine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultExpect } from './engine-contract.mjs';

const dir = mkdtempSync(join(tmpdir(), 'pf-expect-'));
const at = (kind) => {
	const f = join(dir, 'engine-' + kind + '.mjs');
	writeFileSync(f, "export const PHP_ENGINE = '" + kind + "';\nexport const ENGINE_RECYCLE_MIB = 140;\n");
	return f;
};

test('#771 the lean engine is judged by lean.json, the npm engine by the upstream 3.1.62 file', () => {
	try {
		assert.equal(basename(defaultExpect(at('lean'))), 'lean.json');
		assert.equal(basename(defaultExpect(at('npm'))), 'upstream-3.1.62.json');
		assert.equal(basename(defaultExpect(join(dir, 'absent.mjs'))), 'upstream-3.1.62.json', 'no marker (an older prepare.sh): npm');
		assert.throws(() => defaultExpect(at('custom')), /set ENGINE_EXPECT/, 'a custom engine must name its expectation');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
