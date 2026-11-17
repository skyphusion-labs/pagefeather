import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { asyncEmailDefine } from '../async-email-wiring.mjs';

const LINE = "define('SKYPHUSION_ASYNC_EMAIL', true);";

test('b-dosql: PHP_IN_DO and DB_IN_DO on', () => {
	assert.equal(asyncEmailDefine({ PHP_IN_DO: 'on', DB_IN_DO: 'on' }, false), LINE);
});

test('approach A: dbHandler set, DB not in the object', () => {
	assert.equal(asyncEmailDefine({ DB_IN_DO: 'off' }, true), LINE);
	assert.equal(asyncEmailDefine({}, true), LINE);
});

test('approach B without D1 in DO: no define', () => {
	assert.equal(asyncEmailDefine({ PHP_IN_DO: 'on', DB_IN_DO: 'off' }, false), null);
});

test('ASYNC_EMAIL=off disables both tiers', () => {
	assert.equal(asyncEmailDefine({ PHP_IN_DO: 'on', DB_IN_DO: 'on', ASYNC_EMAIL: 'off' }, false), null);
	assert.equal(asyncEmailDefine({ ASYNC_EMAIL: 'off' }, true), null);
});

test('index.js wires asyncEmailDefine at boot', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	assert.ok(src.includes("import { asyncEmailDefine } from './async-email-wiring.mjs';"));
	assert.ok(src.includes('asyncEmailDefine(ENV, Boolean(dbHandler))'));
	assert.ok(!src.includes('PHP_IN_DO === \'on\' && ENV.DB_IN_DO === \'on\' && ENV.ASYNC_EMAIL'), 'the old b-dosql-only gate must be gone');
});