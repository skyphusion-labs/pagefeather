// redirect-com-ruleset.json: one 301 to www.pagefeather.dev for both .com hosts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const ruleset = JSON.parse(readFileSync(join(DIR, 'redirect-com-ruleset.json'), 'utf8'));

test('one redirect rule for pagefeather.com and www', () => {
	assert.equal(ruleset.rules.length, 1);
	const r = ruleset.rules[0];
	assert.equal(r.action, 'redirect');
	assert.match(r.expression, /http\.host eq "pagefeather\.com"/);
	assert.match(r.expression, /http\.host eq "www\.pagefeather\.com"/);
	const fv = r.action_parameters.from_value;
	assert.equal(fv.status_code, 301);
	assert.equal(fv.preserve_query_string, true);
	assert.match(fv.target_url.expression, /https:\/\/www\.pagefeather\.dev/);
	assert.match(fv.target_url.expression, /http\.request\.uri\.path/);
});
