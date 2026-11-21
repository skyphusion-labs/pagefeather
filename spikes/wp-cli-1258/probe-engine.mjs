// Engine-only probe for issue 1258. It boots the same wasm the Worker uses.
// It does not boot WordPress and it does not open a site database.
//
//   node probe-engine.mjs <wp-cli.phar> <out.json>

import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot, engine } from '../b2-wordpress/tests/engine-contract.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const b2 = join(here, '../b2-wordpress');
const require = createRequire(join(b2, 'package.json'));
const { __private__dont__use } = require('@php-wasm/universal');
const PRIV = __private__dont__use;

const pharPath = process.argv[2];
const outPath = process.argv[3];
if (!pharPath || !outPath) {
	console.error('usage: node probe-engine.mjs <wp-cli.phar> <out.json>');
	process.exit(2);
}

const expect = JSON.parse(readFileSync(join(here, '../../engine/expect/lean.json'), 'utf8'));
const built = engine(
	'pagefeather',
	join(b2, 'vendor/php_8_3.js'),
	join(b2, 'vendor/php_8_3.wasm'),
	expect,
);

function heap(php) {
	try { return php[PRIV].HEAPU8.length; } catch (e) { return null; }
}

async function runCaught(php, opts) {
	try {
		const r = await php.run(opts);
		return { thrown: false, exitCode: r.exitCode, text: r.text, errors: r.errors };
	} catch (e) {
		const r = e && e.response;
		return {
			thrown: true,
			name: e && e.name,
			message: String((e && e.message) || e).slice(0, 1500),
			exitCode: r ? r.exitCode : null,
			text: r && typeof r.text === 'string' ? r.text.slice(0, 2000) : '',
			errors: r && typeof r.errors === 'string' ? r.errors.slice(0, 2000) : '',
		};
	}
}

async function streamText(stream) {
	if (!stream || typeof stream.getReader !== 'function') return '';
	const reader = stream.getReader();
	const parts = [];
	for (;;) {
		const step = await reader.read();
		if (step.done) break;
		parts.push(Buffer.from(step.value));
	}
	return Buffer.concat(parts).toString('utf8');
}

const exportNames = WebAssembly.Module.exports(built.module).map((item) => item.name);
const want = ['wasm_set_sapi_name', 'wasm_add_cli_arg', 'run_cli', 'wasm_sapi_handle_request', 'php_wasm_init'];
const exportsPresent = {};
for (const name of want) exportsPresent[name] = exportNames.includes(name);

const report = {
	engine: expect.engine,
	php: expect.php,
	expectSapi: expect.sapi,
	exportsPresent,
	steps: {},
};

const phar = readFileSync(pharPath);

// 1. Request path, no SAPI change. Include the real phar from a PHP file.
{
	const { php } = await boot(built, { env: { USE_ZEND_ALLOC: '0' } });
	php.writeFile('/tmp/wp-cli.phar', phar);
	php.writeFile('/tmp/run-phar.php', `<?php
$GLOBALS['argv'] = array('wp', 'cli', 'version');
$GLOBALS['argc'] = 2;
include '/tmp/wp-cli.phar';
`);
	const before = heap(php);
	const t = Date.now();
	const ran = await runCaught(php, { scriptPath: '/tmp/run-phar.php' });
	report.steps.phar_run = { ms: Date.now() - t, before, after: heap(php), ...ran };
}

// 2. setSapiName('cli') before the first request, then the same include.
{
	const { php } = await boot(built, { env: { USE_ZEND_ALLOC: '0' } });
	let setError = null;
	try {
		await php.setSapiName('cli');
	} catch (e) {
		setError = String((e && e.message) || e).slice(0, 800);
	}
	php.writeFile('/tmp/wp-cli.phar', phar);
	php.writeFile('/tmp/run-phar.php', `<?php
chdir('/tmp');
$GLOBALS['argv'] = array('wp', 'cli', 'version');
$GLOBALS['argc'] = 2;
include '/tmp/wp-cli.phar';
`);
	const before = heap(php);
	const t = Date.now();
	const ran = setError ? null : await runCaught(php, { scriptPath: '/tmp/run-phar.php' });
	report.steps.phar_after_set_sapi = { ms: Date.now() - t, setError, before, after: heap(php), ran };
}

// 3. php.cli(), the Playground CLI entry. One boot, php -r, then a second boot for the phar.
{
	const { php } = await boot(built, { env: { USE_ZEND_ALLOC: '0' } });
	const before = heap(php);
	const t = Date.now();
	try {
		const streamed = await php.cli(['php', '-r', 'echo PHP_SAPI;']);
		const stdout = await streamText(streamed.stdout);
		const stderr = await streamText(streamed.stderr);
		const exitCode = await streamed.exitCode;
		report.steps.cli_version = { ms: Date.now() - t, before, after: heap(php), exitCode, stdout: stdout.slice(0, 500), stderr: stderr.slice(0, 800) };
	} catch (e) {
		report.steps.cli_version = { ms: Date.now() - t, before, after: heap(php), error: String((e && e.message) || e).slice(0, 800) };
	}
}
{
	const { php } = await boot(built, { env: { USE_ZEND_ALLOC: '0' } });
	php.writeFile('/tmp/wp-cli.phar', phar);
	const before = heap(php);
	const t = Date.now();
	try {
		const streamed = await php.cli(['php', '/tmp/wp-cli.phar', 'cli', 'version']);
		const stdout = await streamText(streamed.stdout);
		const stderr = await streamText(streamed.stderr);
		const exitCode = await streamed.exitCode;
		report.steps.cli_phar = { ms: Date.now() - t, before, after: heap(php), exitCode, stdout: stdout.slice(0, 800), stderr: stderr.slice(0, 800) };
	} catch (e) {
		report.steps.cli_phar = { ms: Date.now() - t, before, after: heap(php), error: String((e && e.message) || e).slice(0, 800) };
	}
}

writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({
	exportsPresent,
	phar_run: (report.steps.phar_run.text || report.steps.phar_run.message || '').slice(0, 240),
	set_sapi: report.steps.phar_after_set_sapi.setError,
	cli: report.steps.cli_version.error || report.steps.cli_version.stdout || report.steps.cli_version.stderr,
}, null, 2));
