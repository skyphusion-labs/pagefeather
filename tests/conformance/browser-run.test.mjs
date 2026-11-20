// PF_BROWSER=browser-run (pf-browser-run.cjs): against a stub playwright-core, no network. chromium.launch becomes
// connectOverCDP to the account's Browser Run endpoint with the Bearer token; the token never reaches stdout or
// stderr; firefox and webkit are refused; a missing account or token file stops before any connect.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const PRELOAD = new URL('./pf-browser-run.cjs', import.meta.url).pathname;
const ACCOUNT = '0123456789abcdef0123456789abcdef';
const TOKEN = 'tok_SECRET_stub_value_1234567890';

function stubSite() {
	const d = mkdtempSync(join(tmpdir(), 'pf-br-'));
	mkdirSync(join(d, 'node_modules', 'playwright-core'), { recursive: true });
	writeFileSync(join(d, 'node_modules', 'playwright-core', 'index.js'), `
class BrowserType { constructor(n) { this._n = n; } name() { return this._n; }
  async launch() { return { version: () => 'LOCAL' }; }
  async connectOverCDP(ws, opts) { globalThis.__calls = (globalThis.__calls || []).concat([{ ws, auth: opts.headers.Authorization }]); return { version: () => '152.0.0.0' }; } }
module.exports = { chromium: new BrowserType('chromium'), firefox: new BrowserType('firefox'), webkit: new BrowserType('webkit') };`);
	writeFileSync(join(d, 'tok'), TOKEN + '\n');
	writeFileSync(join(d, 'probe.cjs'), `
const pw = require('playwright-core');
(async () => {
  const b = await pw.chromium.launch({ headless: true });
  const c = globalThis.__calls || [];
  let ff = 'launched';
  try { await pw.firefox.launch(); } catch (e) { ff = e.message; }
  console.log(JSON.stringify({ version: b.version(), calls: c.map((x) => ({ ws: x.ws, bearer: x.auth === 'Bearer ${TOKEN}' })), ff }));
})().catch((e) => { console.log(JSON.stringify({ error: e.message })); });`);
	return d;
}

function run(d, env) {
	return spawnSync(process.execPath, ['--require', PRELOAD, join(d, 'probe.cjs')], { cwd: d, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
}

test('browser-run: chromium.launch is connectOverCDP to the account endpoint, with the Bearer token', () => {
	const d = stubSite();
	const p = run(d, { PF_BROWSER: 'browser-run', PF_BROWSER_RUN_ACCOUNT: ACCOUNT, PF_BROWSER_RUN_TOKEN_FILE: join(d, 'tok') });
	const out = JSON.parse(p.stdout.trim());
	assert.equal(out.version, '152.0.0.0');
	assert.equal(out.calls.length, 1);
	assert.match(out.calls[0].ws, new RegExp('^wss://api\\.cloudflare\\.com/client/v4/accounts/' + ACCOUNT + '/browser-run/devtools/browser\\?keep_alive=600000$'));
	assert.equal(out.calls[0].bearer, true);
	assert.match(p.stderr, /@event browser-run .*"version":"152\.0\.0\.0"/);
	assert.match(p.stderr, /accounts\/<account>/);
	assert.ok(!p.stdout.includes(TOKEN) && !p.stderr.includes(TOKEN), 'the token is never printed');
	assert.match(out.ff, /Chromium only; firefox refused/);
	rmSync(d, { recursive: true });
});

test('without PF_BROWSER the preload changes nothing (a local launch)', () => {
	const d = stubSite();
	const p = run(d, {});
	assert.equal(JSON.parse(p.stdout.trim()).version, 'LOCAL');
	rmSync(d, { recursive: true });
});

test('a missing account or token file stops before any connect', () => {
	const d = stubSite();
	const a = run(d, { PF_BROWSER: 'browser-run', PF_BROWSER_RUN_TOKEN_FILE: join(d, 'tok') });
	assert.notEqual(a.status, 0);
	assert.match(a.stderr, /PF_BROWSER_RUN_ACCOUNT is not a 32-hex account id/);
	const t = run(d, { PF_BROWSER: 'browser-run', PF_BROWSER_RUN_ACCOUNT: ACCOUNT, PF_BROWSER_RUN_TOKEN_FILE: join(d, 'none') });
	assert.notEqual(t.status, 0);
	assert.match(t.stderr, /cannot read PF_BROWSER_RUN_TOKEN_FILE/);
	rmSync(d, { recursive: true });
});
