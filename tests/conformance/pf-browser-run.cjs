// PF_BROWSER=browser-run (#759 harness, Conrad 2026-11-20): run the upstream Playwright suites on Cloudflare Browser
// Run (hosted Chromium over CDP) instead of a local browser. Loaded with NODE_OPTIONS=--require into the Playwright
// runner and every worker. It replaces BrowserType.launch for chromium with connectOverCDP; firefox and webkit are
// refused (Browser Run is Chromium only). The token is read from PF_BROWSER_RUN_TOKEN_FILE and never printed.
// Each worker prints one line to stderr: "@event browser-run {...}" with the remote browser version.
'use strict';
if (process.env.PF_BROWSER === 'browser-run') {
	const fs = require('fs');
	const path = require('path');
	const account = process.env.PF_BROWSER_RUN_ACCOUNT || '';
	const tokenFile = process.env.PF_BROWSER_RUN_TOKEN_FILE || '';
	if (!/^[0-9a-f]{32}$/.test(account)) throw new Error('pf-browser-run: PF_BROWSER_RUN_ACCOUNT is not a 32-hex account id');
	let token = '';
	try { token = fs.readFileSync(tokenFile, 'utf8').trim(); } catch (e) { throw new Error('pf-browser-run: cannot read PF_BROWSER_RUN_TOKEN_FILE'); }
	if (!token) throw new Error('pf-browser-run: the token file is empty');
	const keepAlive = Number(process.env.PF_BROWSER_RUN_KEEPALIVE_MS || 600000);
	const ws = process.env.PF_BROWSER_RUN_WS ||
		'wss://api.cloudflare.com/client/v4/accounts/' + account + '/browser-run/devtools/browser?keep_alive=' + keepAlive;
	// Patch every playwright-core copy the suite can load (the runner resolves it from its own node_modules).
	// The test runner loads playwright-core through @playwright/test -> playwright, which under pnpm can be a different
	// copy than the one at the top of node_modules: patch each copy reachable from those packages too.
	const roots = [process.cwd()];
	for (const pkg of ['@playwright/test/package.json', 'playwright/package.json']) {
		try { roots.push(path.dirname(require.resolve(pkg, { paths: [process.cwd()] }))); } catch (e) { /* not installed here */ }
	}
	try { roots.push(path.dirname(require.resolve('playwright/package.json', { paths: [roots[1] || process.cwd()] }))); } catch (e) { /* none */ }
	const seen = new Set();
	for (const root of roots) {
		let core;
		try { core = require(require.resolve('playwright-core', { paths: [root] })); } catch (e) { continue; }
		const proto = Object.getPrototypeOf(core.chromium);
		if (seen.has(proto)) continue;
		seen.add(proto);
		const launch = proto.launch;
		proto.launch = async function (options) {
			if (this.name() !== 'chromium') throw new Error('pf-browser-run: Browser Run is Chromium only; ' + this.name() + ' refused');
			const browser = await this.connectOverCDP(ws, { headers: { Authorization: 'Bearer ' + token }, timeout: (options && options.timeout) || 60000 });
			process.stderr.write('@event browser-run ' + JSON.stringify({ pid: process.pid, version: browser.version(), endpoint: ws.replace(/accounts\/[0-9a-f]+/, 'accounts/<account>') }) + '\n');
			return browser;
		};
		proto.launch.pfOriginal = launch;
	}
	if (!seen.size) throw new Error('pf-browser-run: playwright-core not found from ' + process.cwd());
}
