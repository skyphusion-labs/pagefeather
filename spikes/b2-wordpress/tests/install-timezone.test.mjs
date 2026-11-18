// #759: /_install sets timezone_string at wp_install time (product default, not conformance seed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const install = src.slice(src.indexOf('const INSTALL = `'), src.indexOf('const site = {'));

test('#759 INSTALL sets timezone_string after wp_install', () => {
	assert.match(install, /update_option\(\s*'timezone_string'/);
	assert.match(install, /\/tmp\/site-timezone/);
	assert.match(install, /America\/Detroit/);
	assert.match(install, /timezone_identifiers_list\(\)/);
});

test('#759 /_install passes SITE_TIMEZONE (or default) into INSTALL', () => {
	const h = src.indexOf("if (url.pathname === '/_install') {");
	const end = src.indexOf('return Response.json({ bootMs', h);
	const block = src.slice(h, end);
	assert.match(block, /\/tmp\/site-timezone/);
	assert.match(block, /env\.SITE_TIMEZONE/);
	assert.match(block, /America\/Detroit/);
});
