// /_activate (#289): the REAL activation script from index.js, run by the php CLI against small
// WordPress stubs, so its report is checked without a site.
// - A plugin that ends the request itself after the activation is saved (Slim SEO's
//   activated_plugin hook: wp_safe_redirect, then die) still gets a report: active true,
//   exited true. Before the fix /_activate answered an empty out (sample store, 2026-11-12).
// - A normal activation reports exited false; a WP_Error reports its message.
// - Action Scheduler's async queue runner is turned off BEFORE wp-load runs (a pre-seeded
//   $wp_filter entry), and the queue action is removed after it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const h = src.indexOf("if (url.pathname === '/_activate') {");
assert.ok(h >= 0, 'the /_activate handler is in index.js');
const open = src.indexOf('php.run({ code: `', h) + 'php.run({ code: `'.length;
const close = src.indexOf('` });', open);
const tpl = src.slice(open, close);
// Evaluate the JS template literal as index.js does (its escapes and ${plugin}).
const render = (plugin) => new Function('plugin', 'return `' + tpl + '`;')(plugin);

const STUBS = `<?php
define( 'ABSPATH', '/wordpress/' );
class WP_Error { public $m; function __construct( $c = '', $m = '' ) { $this->m = $m; } function get_error_message() { return $this->m; } }
function is_wp_error( $x ) { return $x instanceof WP_Error; }
$GLOBALS['stub_active'] = array(); $GLOBALS['stub_actions'] = array(); $GLOBALS['stub_removed'] = array();
function is_plugin_active( $p ) { return in_array( $p, $GLOBALS['stub_active'], true ); }
function wp_set_current_user( $u ) {}
function set_transient( $k, $v ) {}
function delete_transient( $k ) {}
function did_action( $a ) { return isset( $GLOBALS['stub_actions'][ $a ] ) ? $GLOBALS['stub_actions'][ $a ] : 0; }
function remove_all_actions( $a ) { $GLOBALS['stub_removed'][] = $a; }
class Stub_DB { public $last_error = ''; }
$GLOBALS['wpdb'] = new Stub_DB();
function activate_plugin( $p ) {
	$mode = getenv( 'STUB_MODE' );
	if ( 'error' === $mode ) { return new WP_Error( 'x', 'Plugin file does not exist.' ); }
	$GLOBALS['stub_active'][] = $p; // the activation is saved
	if ( 'die' === $mode ) { die; } // a plugin's activated_plugin hook ends the request
	return null;
}
`;

function run(mode, plugin = 'slim-seo/slim-seo.php') {
	const d = mkdtempSync(join(tmpdir(), 'activate-report-'));
	try {
		let code = render(plugin);
		// The wp-load and plugin.php requires become the stubs; everything else is the real script.
		code = code.replace("require '/wordpress/wp-load.php';", "require '" + join(d, 'stubs.php') + "';");
		code = code.replace("require_once ABSPATH . 'wp-admin/includes/plugin.php';", '');
		writeFileSync(join(d, 'stubs.php'), STUBS);
		writeFileSync(join(d, 'act.php'), code);
		const out = execFileSync('php', ['-n', join(d, 'act.php')], { env: { ...process.env, STUB_MODE: mode }, encoding: 'utf8' });
		return { out };
	} finally {
		rmSync(d, { recursive: true, force: true });
	}
}
const last = (out) => JSON.parse(out.slice(out.lastIndexOf('{')));

test('THE SLIM SEO CASE: a plugin that dies after the activation is saved still gets a report', () => {
	const { out } = run('die');
	assert.notEqual(out.trim(), '', 'the out is not empty');
	const r = last(out);
	assert.equal(r.active, true);
	assert.equal(r.exited, true);
	assert.equal(r.error, null);
});
test('a normal activation reports active, exited false, and no queue run', () => {
	const r = last(run('ok').out);
	assert.equal(r.active, true);
	assert.equal(r.exited, false);
	assert.equal(r.queue_runs, 0);
	assert.equal(r.db_error, null);
});
test('a WP_Error is reported with its message', () => {
	const r = last(run('error').out);
	assert.equal(r.active, false);
	assert.equal(r.error, 'Plugin file does not exist.');
	assert.equal(r.exited, false);
});
test('the report is printed once', () => {
	assert.equal((run('ok').out.match(/"active"/g) || []).length, 1);
	assert.equal((run('die').out.match(/"active"/g) || []).length, 1);
});
test('the Action Scheduler async runner is turned off BEFORE wp-load, and the queue action removed after', () => {
	const code = render('slim-seo/slim-seo.php');
	const pre = code.indexOf("$GLOBALS['wp_filter']['action_scheduler_allow_async_request_runner']");
	const load = code.indexOf("require '/wordpress/wp-load.php';");
	const rm = code.indexOf("remove_all_actions( 'action_scheduler_run_queue' );");
	assert.ok(pre >= 0 && load > pre, 'the filter is pre-seeded before wp-load');
	assert.ok(rm > load, 'the queue action is removed after wp-load');
	assert.match(code, /'function' => '__return_false', 'accepted_args' => 1/);
});
