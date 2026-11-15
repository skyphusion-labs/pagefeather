// node --test engine/tools/gd-freetype-smoke.test.mjs (#590)
// The decision only. The engine boot runs in pagefeather-engine.yml (lean-gates).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gdFreetypeReportFails, parseGdReport, GD_FREETYPE_PHP } from './gd-freetype-smoke.mjs';

const clean = {
	gd: true, freetype: false, linkage: null, png: true, jpeg: true,
	imagettftext: false, imagettfbbox: false, imagefttext: false, imageftbbox: false,
};

test('gd_info FreeType Support true fails, and so does imagettftext', () => {
	const reasons = gdFreetypeReportFails({
		...clean, freetype: true, linkage: 'with freetype',
		imagettftext: true, imagettfbbox: true, imagefttext: true, imageftbbox: true,
	});
	assert.ok(reasons.some((r) => r.includes('FreeType Support')));
	assert.ok(reasons.some((r) => r.includes('function_exists(imagettftext)')));
	assert.ok(reasons.some((r) => r.includes('function_exists(imagefttext)')));
});

test('FreeType Support false and the four functions absent passes', () => {
	assert.deepEqual(gdFreetypeReportFails(clean), []);
});

test('a missing FreeType Support key fails', () => {
	const reasons = gdFreetypeReportFails({ ...clean, freetype: null });
	assert.equal(reasons.length, 1);
	assert.match(reasons[0], /FreeType Support/);
});

test('the PHP probe asks gd_info and function_exists', () => {
	assert.match(GD_FREETYPE_PHP, /gd_info/);
	assert.match(GD_FREETYPE_PHP, /function_exists/);
	assert.match(GD_FREETYPE_PHP, /FreeType Support/);
	assert.match(GD_FREETYPE_PHP, /imagettftext/);
});

test('parseGdReport reads the JSON line', () => {
	const report = parseGdReport('warning\n' + JSON.stringify(clean) + '\n');
	assert.equal(report.freetype, false);
	assert.equal(report.imagettftext, false);
});
