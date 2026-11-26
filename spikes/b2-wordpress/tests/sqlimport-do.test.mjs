// /_sqlimport when PHP runs in the PhpRuntime object (issue #551).
// index.js cannot be imported here (cloudflare:workers, the wasm build), so the
// route is checked as shipped source, the same way oc-isolated-test.mjs checks
// index.js. sql-import.js is ESM that this package marks commonjs, so the
// import runs from a .mjs copy, against a fake MySQL client: no Cloudflare
// account and no live site.
//   node --test spikes/b2-wordpress/tests/sqlimport-do.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

function between(startMark, endMark) {
	const s = src.indexOf(startMark);
	const e = src.indexOf(endMark, s + startMark.length);
	assert.ok(s >= 0 && e > s, `missing ${startMark} .. ${endMark}`);
	return src.slice(s, e);
}

// The worker's /_sqlimport branch only, up to the next route. The later
// PHP_IN_DO forward (ordinary PHP) must not count as this route.
function workerSqlImportBranch() {
	const serve = between('async serve(req, env, ctx)', 'export class Pages');
	const at = serve.indexOf("url.pathname === '/_sqlimport'");
	const end = serve.indexOf("url.pathname === '/_ocversions'");
	assert.ok(at >= 0 && end > at, 'the worker has no /_sqlimport branch before /_ocversions');
	return serve.slice(at, end);
}

function objectFetch() {
	return between('async fetch(raw) {', '\n}\n\n// Which object serves');
}

// A stand-in for the object's MySQL client (index-a-lean.js dbHandler).
function fakeDb() {
	const tables = new Map([
		['wp_options', 3],
		['wp_posts', 5],
		['wp_ggc_options', 7],
		['wp_ggc_posts', 11],
	]);
	const ran = [];
	return {
		ran,
		tables,
		async query(_env, m) {
			const sql = m.mysql;
			ran.push(sql);
			if (sql === 'BEGIN' || sql === 'COMMIT' || sql.startsWith('SET SESSION')) return { ok: true };
			if (sql === 'SELECT VERSION()') return { ok: true, rows: [['10.11.6-MariaDB-0+deb12u1']] };
			if (sql === 'SELECT @@max_allowed_packet') return { ok: true, rows: [['16777216']] };
			if (sql === 'SELECT @@SESSION.sql_mode') return { ok: true, rows: [['NO_AUTO_VALUE_ON_ZERO']] };
			if (sql === 'SHOW TABLES') return { ok: true, rows: [...tables.keys()].map((t) => [t]) };
			const count = sql.match(/^SELECT COUNT\(\*\) FROM `([^`]+)`$/);
			if (count) return { ok: true, rows: [[String(tables.get(count[1]))]] };
			if (sql.startsWith('SHOW COLUMNS')) return { ok: true, rows: [] };
			const drop = sql.match(/^DROP TABLE IF EXISTS `([^`]+)`$/);
			if (drop) return tables.delete(drop[1]), { ok: true };
			const create = sql.match(/^CREATE TABLE `([^`]+)`/);
			if (create) return tables.set(create[1], 0), { ok: true };
			const ins = sql.match(/INTO `([^`]+)` VALUES (.*)$/);
			if (ins) return tables.set(ins[1], (tables.get(ins[1]) || 0) + ins[2].split('),(').length), { ok: true };
			return { ok: true };
		},
	};
}

const env = { PHP_IN_DO: 'on', SPIKE_TOKEN: 'tok', PHP_ENV: '{"WP_TABLE_PREFIX":"wp_"}' };
const ggcEnv = { ...env, PHP_ENV: '{"WP_TABLE_PREFIX":"wp_ggc_"}' };

async function loadSqlImport() {
	const dir = mkdtempSync(join(tmpdir(), 'sqlimport-do-'));
	const dest = join(dir, 'sql-import.mjs');
	copyFileSync(new URL('../sql-import.js', import.meta.url), dest);
	copyFileSync(new URL('../token-equal.mjs', import.meta.url), join(dir, 'token-equal.mjs'));
	const mod = await import(pathToFileURL(dest).href);
	rmSync(dir, { recursive: true, force: true });
	return mod.sqlImport;
}

test('with PHP_IN_DO=on, /_sqlimport reaches the PhpRuntime object and not the 404 (#551)', async () => {
	const sqlImport = await loadSqlImport();
	const req = (method, path, body, token = 'tok') => new Request('https://site.example' + path, {
		method,
		body,
		headers: token === null ? {} : { 'x-spike-token': token },
	});
	const call = async (db, method, path, body, e = env, token = 'tok') => {
		const r = await sqlImport(req(method, path, body, token), e, new URL('https://site.example' + path), db);
		const text = await r.text();
		let o = null;
		try { o = JSON.parse(text); } catch { /* not JSON */ }
		return { status: r.status, text, o };
	};
	const line = (sql) => JSON.stringify({ sql }) + '\n';

	// What the worker does today: hand sqlImport no client. That is the 404.
	const blocked = await call(null, 'GET', '/_sqlimport?counts=1');
	assert.equal(blocked.status, 404);
	assert.match(blocked.text, /\/_sqlimport is for variant a only/);

	const worker = workerSqlImportBranch();
	assert.equal(
		/PHP_IN_DO === 'on' \? null/.test(worker),
		false,
		`the worker still passes null, so /_sqlimport answers ${blocked.status} when PHP_IN_DO=on`,
	);
	const onAt = worker.indexOf("env.PHP_IN_DO === 'on'");
	const fwdAt = worker.indexOf('toPhpObject(');
	const importAt = worker.indexOf('sqlImport(');
	assert.ok(onAt >= 0 && fwdAt > onAt, 'PHP_IN_DO=on forwards into the object');
	assert.ok(importAt > fwdAt, 'sqlImport runs in the worker only when PHP stays there');
	assert.match(worker, /PHP_IN_DO=on needs the PHP_RUNTIME Durable Object binding/, 'a missing object binding is the usual 500, not the 404');
	assert.doesNotMatch(worker, /\? null/);

	const fetch = objectFetch();
	const gate = fetch.indexOf("pathname.startsWith('/_') && !spikeOk");
	const refusedAt = fetch.indexOf("url.pathname === '/_sqlimport' && env.PHP_IN_DO === 'on' && env.DB_IN_DO !== 'on'");
	const at = fetch.indexOf("if (url.pathname === '/_sqlimport') return sqlImport");
	assert.ok(gate >= 0 && at > gate, 'the PhpRuntime object does not handle /_sqlimport after its own spike-token check');
	assert.ok(refusedAt > gate && at > refusedAt, 'the external-MySQL Durable Object path must refuse /_sqlimport before calling sqlImport');
	assert.match(fetch.slice(refusedAt, at), /status: 409/);
	assert.match(fetch.slice(refusedAt, at), /MySQL client connected directly to the provider database/);
	assert.match(
		fetch.slice(at, fetch.indexOf('\n', at)),
		/return sqlImport\(req, env, url, dbHandler\);/,
		'the object runs the import with its own MySQL client',
	);

	// The object's client (a fake) answers the same API. Not the 404.
	const info = await call(fakeDb(), 'GET', '/_sqlimport?info=1');
	assert.equal(info.status, 200, info.text);
	assert.equal(info.o.flavour, 'mariadb');
	assert.equal(info.o.prefix, 'wp_');
	const counts = await call(fakeDb(), 'GET', '/_sqlimport?counts=1');
	assert.equal(counts.status, 200, counts.text);
	assert.deepEqual(Object.keys(counts.o.tables), ['wp_options', 'wp_posts']);
	const pre = await call(fakeDb(), 'POST', '/_sqlimport?preflight=1', line('CREATE TABLE `wp_options` (`a` int)'));
	assert.equal(pre.status, 200, pre.text);
	assert.equal(pre.o.preflight, 1);
	const load = await call(fakeDb(), 'POST', '/_sqlimport?replace=1', line('INSERT INTO `wp_options` VALUES (1)'));
	assert.equal(load.status, 200, load.text);
	assert.equal(load.o.ok, true);
	assert.equal(load.o.dropped, 2);
	assert.equal(load.o.statements, 1);

	// Sample-store admin password replace (#1470): one narrow UPDATE on the site users table.
	const pw = await call(
		fakeDb(),
		'POST',
		'/_sqlimport',
		line("UPDATE `wp_users` SET `user_pass` = '$wp$2y$10$abcdefghijklmnopqrstuv', `user_activation_key` = '' WHERE `ID` = 1"),
	);
	assert.equal(pw.status, 200, pw.text);
	assert.equal(pw.o.ok, true);
	assert.equal(pw.o.statements, 1);
	const badPw = await call(
		fakeDb(),
		'POST',
		'/_sqlimport',
		line("UPDATE `wp_options` SET `option_value` = 'x' WHERE `option_name` = 'siteurl'"),
	);
	assert.equal(badPw.status, 400, badPw.text);
	assert.match(badPw.o.error || '', /refused/);

	// The spike token and the prefix rule stay in sqlImport, on this path too.
	const denied = await call(fakeDb(), 'GET', '/_sqlimport?info=1', undefined, env, 'nope');
	assert.equal(denied.status, 403);
	const foreign = await call(fakeDb(), 'POST', '/_sqlimport?replace=1', line('INSERT INTO `wp_posts` VALUES (1)'), ggcEnv);
	assert.equal(foreign.status, 400, foreign.text);
	assert.equal(foreign.o.ran, 0);
	const own = await call(fakeDb(), 'GET', '/_sqlimport?counts=1', undefined, ggcEnv);
	assert.equal(own.status, 200, own.text);
	assert.deepEqual(Object.keys(own.o.tables), ['wp_ggc_options', 'wp_ggc_posts']);
});
