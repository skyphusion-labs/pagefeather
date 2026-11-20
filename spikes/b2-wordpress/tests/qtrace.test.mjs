// qtrace.mjs (#296 step 3, measure first): where a request's queries go. The shape keeps NO literal (a value can be
// row data: an email, an order key), so a trace is safe to log; the aggregate names tables, callers and shapes only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sqlShape, sqlVerb, createTrace } from '../qtrace.mjs';

test('sqlShape drops every literal: strings (with escapes), numbers, hex, IN lists', () => {
	assert.equal(sqlShape("SELECT * FROM wp_postmeta WHERE post_id = 42 AND meta_key = '_price'"), 'SELECT * FROM wp_postmeta WHERE post_id = ? AND meta_key = ?');
	assert.equal(sqlShape("SELECT 1 FROM t WHERE a = 'it\\'s' AND b = 'x''y' AND c = \"q\""), 'SELECT ? FROM t WHERE a = ? AND b = ? AND c = ?');
	assert.equal(sqlShape('SELECT * FROM t WHERE id IN (1, 2, 3) AND k IN (\'a\',\'b\')'), 'SELECT * FROM t WHERE id IN (?+) AND k IN (?+)');
	assert.equal(sqlShape('UPDATE t SET v = 0x6869, w = -1.5e3 WHERE id = 7'), 'UPDATE t SET v = ?, w = ? WHERE id = ?');
	assert.equal(sqlShape('SELECT  a\n\tFROM   wp_options'), 'SELECT a FROM wp_options');
	// Identifiers with digits are not literals.
	assert.equal(sqlShape('SELECT * FROM wp_wc_order_stats t1 WHERE t1.x = 5'), 'SELECT * FROM wp_wc_order_stats t1 WHERE t1.x = ?');
	// A planted email in a value never survives.
	assert.ok(!sqlShape("INSERT INTO wp_wc_orders (billing_email) VALUES ('load@example.com')").includes('example'));
});

test('sqlVerb names the statement kind', () => {
	assert.equal(sqlVerb('  select 1'), 'SELECT');
	assert.equal(sqlVerb('START TRANSACTION'), 'START');
	assert.equal(sqlVerb('(SELECT 1) UNION (SELECT 2)'), 'SELECT');
});

test('createTrace aggregates by verb, table, area and caller, with ms, and finds runs and duplicates', () => {
	const t = createTrace();
	t.add("SELECT * FROM wp_postmeta WHERE post_id = 1", 3, 'plugin:woocommerce:class-wc-product-data-store-cpt.php::read_meta');
	t.add("SELECT * FROM wp_postmeta WHERE post_id = 2", 4, 'plugin:woocommerce:class-wc-product-data-store-cpt.php::read_meta');
	t.add("SELECT * FROM wp_postmeta WHERE post_id = 3", 5, 'plugin:woocommerce:class-wc-product-data-store-cpt.php::read_meta');
	t.add("SELECT option_value FROM wp_options WHERE option_name = 'a'", 2, 'core:option.php::get_option');
	t.add("SELECT option_value FROM wp_options WHERE option_name = 'a'", 2, 'core:option.php::get_option');
	t.add("UPDATE wp_options SET option_value = 'b' WHERE option_name = 'c'", 6, undefined);
	const s = t.summary();
	assert.equal(s.n, 6);
	assert.equal(s.ms, 22);
	assert.deepEqual(s.byVerb, { SELECT: { n: 5, ms: 16 }, UPDATE: { n: 1, ms: 6 } });
	assert.deepEqual(s.byTable.wp_postmeta, { n: 3, ms: 12 });
	assert.deepEqual(s.byTable.wp_options, { n: 3, ms: 10 });
	assert.deepEqual(s.byArea['plugin:woocommerce'], { n: 3, ms: 12 });
	assert.deepEqual(s.byArea['core'], { n: 2, ms: 4 });
	assert.deepEqual(s.byArea['?'], { n: 1, ms: 6 });
	assert.equal(s.topCallers[0].c, 'plugin:woocommerce:class-wc-product-data-store-cpt.php::read_meta');
	assert.equal(s.topCallers[0].n, 3);
	// Three back-to-back reads of one shape are one batchable run that would save 2 round trips; the two equal
	// option reads are a run of the same shape too (saved 1), and one exact duplicate.
	assert.deepEqual(s.runs, { count: 2, saved: 3, top: [{ shape: 'SELECT * FROM wp_postmeta WHERE post_id = ?', len: 3 }, { shape: 'SELECT option_value FROM wp_options WHERE option_name = ?', len: 2 }] });
	assert.deepEqual(s.dupes, { distinct: 5, extra: 1 });
	assert.equal(s.topShapes[0].shape, 'SELECT * FROM wp_postmeta WHERE post_id = ?');
	// Nothing in the summary carries a literal.
	assert.ok(!JSON.stringify(s).match(/'b'|'c'|'a'| = 1\b| = 2\b/));
});

test('createTrace caps what it keeps: top lists, and shapes cut at 200 characters', () => {
	const t = createTrace();
	for (let i = 0; i < 60; i++) t.add(`SELECT c${i} FROM t${i} WHERE x = 1`, 1, `core:f${i}.php::g`);
	t.add('SELECT ' + 'a, '.repeat(200) + 'b FROM wide', 1, 'core:w.php::g');
	const s = t.summary();
	assert.ok(s.topCallers.length <= 30 && s.topShapes.length <= 30);
	assert.ok(s.topShapes.every((x) => x.shape.length <= 200));
	assert.ok(Object.keys(s.byTable).length <= 61);
});

// #1090: back-to-back renders made the same 47 option reads, and the trace could not say whether they shared an isolate
// (no iso) or which code asked (the caller stopped at option.php; hyperdrive-qtrace.php now appends "<- the asker").
test('#1090 the qtrace line carries the isolate, and a caller with its asker (up to 240 chars) is kept whole', async () => {
	const { readFileSync } = await import('node:fs');
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	assert.match(src, /console\.log\(JSON\.stringify\(\{ m: 'qtrace', \.\.\.memIdOf\(req, env\), iso: ISOLATE_ID, method: req\.method/);
	const t = createTrace();
	const c = 'core:option.php::get_option <- plugin:woocommerce:Features.php::' + 'X'.repeat(150);
	t.add('SELECT 1', 1, c);
	assert.equal(t.summary().topCallers[0].c, c.slice(0, 240));
	assert.ok(t.summary().topCallers[0].c.length > 160, 'not cut at the old 160');
});
