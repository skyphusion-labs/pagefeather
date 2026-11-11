// The zone cache rulesets (deploy/zone): the bypass rule must be LAST (Cache Rules are last-match-wins
// for set_cache_settings) and must keep every dynamic or per-user request out of the edge cache.
//
// Two layers. (1) Each required clause is present, in both files. (2) The bypass expression is PARSED
// clause by clause and evaluated against sample requests, so a clause that is present but wrong (a typo
// in a path, a wrong field) still fails. The parser refuses any clause shape it does not know: a new
// clause has to be taught here, never skipped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ZONE = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = ['cache-ruleset.json', 'cache-ruleset.multitenant.json'];
const load = (f) => JSON.parse(readFileSync(join(ZONE, f), 'utf8'));
const bypassOf = (f) => load(f).rules.at(-1);

const SHAPES = [
	[/^starts_with\(http\.request\.uri\.path, "([^"]+)"\)$/, (v) => (r) => r.path.startsWith(v)],
	[/^http\.cookie contains "([^"]+)"$/, (v) => (r) => (r.cookie || '').includes(v)],
	[/^http\.request\.uri\.query contains "([^"]+)"$/, (v) => (r) => (r.query || '').includes(v)],
	[/^http\.request\.method ne "([^"]+)"$/, (v) => (r) => (r.method || 'GET') !== v],
	[/^any\(http\.request\.headers\.names\[\*\] == "([^"]+)"\)$/, (v) => (r) => Object.keys(r.headers || {}).map((h) => h.toLowerCase()).includes(v)],
];

function compile(expression) {
	// Split on ` or ` at paren depth 0 (quoted strings skipped), then drop one balanced outer pair.
	const clauses = [];
	let depth = 0, quoted = false, start = 0;
	for (let i = 0; i < expression.length; i++) {
		const ch = expression[i];
		if (ch === '"' && expression[i - 1] !== '\\') quoted = !quoted;
		if (quoted) continue;
		if (ch === '(') depth++;
		else if (ch === ')') depth--;
		else if (depth === 0 && expression.startsWith(' or ', i)) { clauses.push(expression.slice(start, i)); start = i + 4; i += 3; }
	}
	clauses.push(expression.slice(start));
	for (let k = 0; k < clauses.length; k++) {
		const c = clauses[k].trim();
		clauses[k] = c.startsWith('(') && c.endsWith(')') ? c.slice(1, -1) : c;
	}
	const preds = clauses.map((c) => {
		for (const [rx, make] of SHAPES) {
			const m = c.match(rx);
			if (m) return make(m[1]);
		}
		throw new Error(`unknown clause shape, teach the test: ${c}`);
	});
	return { count: clauses.length, bypasses: (r) => preds.some((p) => p(r)) };
}

for (const f of FILES) {
	test(`${f}: the bypass rule is LAST and sets cache:false`, () => {
		const rules = load(f).rules;
		assert.equal(rules.length, 2);
		assert.equal(rules[0].action_parameters.cache, true);
		assert.deepEqual(bypassOf(f).action_parameters, { cache: false });
	});

	test(`${f}: the bypass expression names every required clause`, () => {
		const e = bypassOf(f).expression;
		for (const needle of ['"/_"', 'authorization', 'rest_route=', 'wc-ajax=', '/skyphusion-invoice', '/wp-comments-post',
			'/wp-admin', '/wp-login', '/wp-json', '/wp-cron', '/cart', '/checkout', '/my-account',
			'wordpress_logged_in', 'wp-postpass', 'wp-settings', 'comment_author', 'woocommerce_', 'http.request.method ne "GET"']) {
			assert.ok(e.includes(needle), `${f} bypass is missing ${needle}`);
		}
	});

	test(`${f}: evaluated against sample requests, per-user and operator requests bypass, anonymous pages do not`, () => {
		const { bypasses } = compile(bypassOf(f).expression);
		const must = [
			{ path: '/_dbexport' }, { path: '/_build' }, { path: '/_dbcounts' },
			{ path: '/', headers: { Authorization: 'Basic x' } },
			{ path: '/', query: 'rest_route=/wp/v2/users/me' },
			{ path: '/', query: 'wc-ajax=get_refreshed_fragments' },
			{ path: '/wp-comments-post.php' }, { path: '/skyphusion-invoice/42' },
			{ path: '/wp-admin/' }, { path: '/wp-json/wp/v2/posts' }, { path: '/cart/' },
			{ path: '/', cookie: 'wordpress_logged_in_abc=1' }, { path: '/', method: 'POST' },
		];
		for (const r of must) assert.ok(bypasses(r), `${f} would cache ${JSON.stringify(r)}`);
		const cacheable = [{ path: '/' }, { path: '/hello-world/' }, { path: '/', query: 'p=1' }, { path: '/shop/' }];
		for (const r of cacheable) assert.ok(!bypasses(r), `${f} would bypass the anonymous page ${JSON.stringify(r)}`);
	});
}

test('both rulesets bypass exactly the same requests (one expression, two files)', () => {
	assert.equal(bypassOf(FILES[0]).expression, bypassOf(FILES[1]).expression);
});
