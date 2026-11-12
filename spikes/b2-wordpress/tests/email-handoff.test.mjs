// A cron tick killed by an isolate reset must not lose an order email, or send one twice (#362).
//
// The tick here is a model of the real one, step for step: runCron's stale-claim release and claim,
// then Action Scheduler's process_action as WooCommerce 11.2.1 ships it (get_status, begin_execute,
// log_execution, which THROWS when its UPDATE fails, execute, after_execute, mark_complete, and
// mark_failure on any throw), then the WP-Cron leg (reschedule, unschedule, run). Every statement
// goes through one counter, and the isolate memory reset is injected at EVERY statement position:
//   soft  the reset fails that statement and every later one, and PHP keeps running (path B);
//   hard  the reset kills the whole alarm invocation at that statement (path A).
// The mail goes through the REAL createTickMail and tickEmailDecision (email-handoff.mjs). Later
// ticks run with no reset until nothing is left to do, and the cleaner marks an orphaned
// in-progress action failed, as ActionScheduler_QueueCleaner::mark_failures does.
//
// - The reproduction (the pre-#362 drain: the op only collects, the alarm sends after runCron): a
//   hard reset after an email action completed leaves it complete with its mail never sent.
// - The fix: the op hands the mail off before PHP goes on, and holds only a mail whose work will
//   run again. At every reset position, in both modes: no mail is sent twice, and no action ends
//   complete without its mail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTickMail, tickEmailDecision, emailActionId, HANDOFF, HOLD } from '../email-handoff.mjs';

const RESET = "Durable Object's isolate exceeded its memory limit and was reset.";
class Killed extends Error {}

// The durable state that survives a reset: actions, the WP-Cron schedule, and what was delivered.
function newSite({ emails = 2, wpCronMail = true } = {}) {
	const actions = new Map();
	for (let i = 1; i <= emails; i++) actions.set(100 + i, { status: 'pending', claim: 0 });
	return { actions, cron: wpCronMail ? ['wc_admin_digest'] : [], delivered: [] };
}

// One tick. resetAt: the statement number (1-based) where the reset hits, or Infinity. legacy: the
// pre-#362 mail path (collect, then drain after runCron).
async function runTick(site, { resetAt = Infinity, mode = 'soft', legacy = false } = {}) {
	let n = 0;
	let lost = 0;
	let dead = false;
	const stmt = (apply) => {
		n++;
		if (n >= resetAt) {
			if (mode === 'hard') throw new Killed('reset at ' + n);
			dead = true;
		}
		if (dead) {
			lost++;
			return false;
		}
		const r = apply();
		return r === undefined ? true : r;
	};
	// The durable queue: a send that returned is delivered whatever happens to the tick after it.
	const handoff = async (email) => {
		site.delivered.push(email);
		return 1;
	};
	const pending = [];
	const mail = createTickMail({ handoff, lostWrites: () => lost });
	const ctx = { as_action: 0, wp_cron: 0 };
	const wpMail = async (subject) => {
		const email = { to: ['a@example.com'], subject, as_action: ctx.as_action, wp_cron: ctx.wp_cron };
		if (legacy) pending.push(email);
		else await mail.op(email);
	};
	const fail = (id) => stmt(() => { site.actions.get(id).status = 'failed'; });

	// runCron: release stale claims on PENDING actions only, then claim the pending ones.
	stmt(() => { for (const a of site.actions.values()) if (a.status === 'pending') a.claim = 0; });
	const claimed = [];
	stmt(() => { for (const [id, a] of site.actions) if (a.status === 'pending' && !a.claim) { a.claim = 1; claimed.push(id); } });
	for (const id of claimed) {
		// ActionScheduler_Abstract_QueueRunner::process_action, WooCommerce 11.2.1.
		try {
			let status = null;
			stmt(() => { status = site.actions.get(id).status; });
			if (status === null) throw new Error('Invalid action ID. No status found.');
			if (status !== 'pending') continue;
			ctx.as_action = id; // action_scheduler_begin_execute (wp-mail-queue.php)
			if (!stmt(() => { const a = site.actions.get(id); a.status = 'in-progress'; })) throw new Error('Unable to update the status of action ' + id);
			stmt(() => {}); // the email action loads the order
			await wpMail('Order ' + id);
			ctx.as_action = 0; // action_scheduler_after_execute
			if (!stmt(() => { site.actions.get(id).status = 'complete'; })) throw new Error('unable to mark complete');
		} catch (e) {
			if (e instanceof Killed) throw e;
			fail(id);
			ctx.as_action = 0; // action_scheduler_failed_execution
		}
	}
	stmt(() => { for (const a of site.actions.values()) a.claim = 0; }); // release_claim
	// The WP-Cron leg: unschedule first, then run. The tag says whether the unschedule was saved.
	for (const hook of [...site.cron]) {
		const ok = stmt(() => { site.cron = site.cron.filter((h) => h !== hook); });
		ctx.wp_cron = ok ? 1 : -1;
		await wpMail('Digest ' + hook);
		ctx.wp_cron = 0;
	}
	stmt(() => {}); // the backlog count
	// The alarm after runCron returned. The legacy drain sent everything it collected.
	if (legacy) for (const e of pending) site.delivered.push(e);
	return { lost, counts: mail.counts };
}

// Ticks until nothing is left. The first may reset; a hard reset kills that tick. Between ticks the
// cleaner marks an orphaned in-progress action failed (it is never retried).
async function runSite(site, first) {
	try {
		await runTick(site, first);
	} catch (e) {
		if (!(e instanceof Killed)) throw e;
	}
	for (const a of site.actions.values()) if (a.status === 'in-progress') a.status = 'failed';
	for (let i = 0; i < 5; i++) await runTick(site, { legacy: first.legacy });
	return site;
}

const sends = (site, subject) => site.delivered.filter((e) => e.subject === subject).length;

// The statements of one tick with no reset: the positions to inject a reset at.
async function statementCount() {
	let max = 0;
	for (let r = 1; r < 100; r++) {
		const site = newSite();
		try {
			await runTick(site, { resetAt: r, mode: 'hard' });
			max = r - 1;
			break;
		} catch (e) {
			if (!(e instanceof Killed)) throw e;
		}
	}
	return max;
}

test('the model tick has the statements the reset is injected at', async () => {
	// 2 claim statements, 4 per email action (2), release_claim, the unschedule, the backlog count.
	assert.equal(await statementCount(), 13);
});

test('THE REPRODUCTION (path A): with the pre-#362 drain, a hard reset after the action completed loses its mail', async () => {
	// Statements: 1 release, 2 claim, 3 status 101, 4 in-progress 101, 5 load, 6 complete 101, 7 status 102 ...
	const site = await runSite(newSite(), { resetAt: 7, mode: 'hard', legacy: true });
	assert.equal(site.actions.get(101).status, 'complete');
	assert.equal(sends(site, 'Order 101'), 0, 'complete, never sent: the #362 loss');
});

test('THE REPRODUCTION (path B): with the pre-#362 drain, a soft reset before the WP-Cron unschedule sends its mail twice', async () => {
	const site = newSite({ emails: 0 });
	// 1 release, 2 claim, 3 release_claim, 4 unschedule.
	await runSite(site, { resetAt: 4, mode: 'soft', legacy: true });
	assert.equal(sends(site, 'Digest wc_admin_digest'), 2);
});

test('FIXED (path A): a mail handed off before a hard reset is delivered, once', async () => {
	const site = await runSite(newSite(), { resetAt: 7, mode: 'hard' });
	assert.equal(site.actions.get(101).status, 'complete');
	assert.equal(sends(site, 'Order 101'), 1);
	assert.equal(sends(site, 'Order 102'), 1, 'the next tick runs the other action');
});

test('FIXED (path B): no send from a tick whose writes were lost when the work runs again', async () => {
	const site = newSite({ emails: 0 });
	await runSite(site, { resetAt: 4, mode: 'soft' });
	assert.equal(sends(site, 'Digest wc_admin_digest'), 1, 'held in the reset tick, sent by the rerun');
});

test('FIXED (A does not open B): an order email whose in-progress write landed is handed off after a soft reset', async () => {
	// Reset at 5 (the order load): the in-progress write (4) landed, PHP goes on, mark_complete fails.
	const site = await runSite(newSite(), { resetAt: 5, mode: 'soft' });
	assert.equal(site.actions.get(101).status, 'failed', 'never retried: the cleaner fails it');
	assert.equal(sends(site, 'Order 101'), 1, 'its one send; holding it would lose it');
});

test('FIXED: at every reset position, soft and hard, no mail is sent twice and no action is complete without its mail', async () => {
	const max = await statementCount();
	let cases = 0;
	for (const mode of ['soft', 'hard'])
		for (let r = 1; r <= max + 1; r++) {
			const site = await runSite(newSite(), { resetAt: r, mode });
			for (const [id, a] of site.actions) {
				const s = sends(site, 'Order ' + id);
				assert.ok(s <= 1, `${mode} reset at ${r}: action ${id} sent ${s} times`);
				if (a.status === 'complete') assert.equal(s, 1, `${mode} reset at ${r}: action ${id} complete, sent ${s}`);
			}
			assert.ok(sends(site, 'Digest wc_admin_digest') <= 1, `${mode} reset at ${r}: digest sent twice`);
			if (mode === 'soft') assert.equal(sends(site, 'Digest wc_admin_digest'), 1, `soft reset at ${r}: digest lost`);
			cases++;
		}
	assert.equal(cases, 28, 'ran ' + cases + ' cases: 14 positions (13 statements and none), 2 modes');
});

test('the one loss left (parked): a hard reset inside an action before its mail fails the action, visibly', async () => {
	// Reset at 5: in-progress landed, the isolate dies before the mail. The cleaner fails the action.
	const site = await runSite(newSite(), { resetAt: 5, mode: 'hard' });
	assert.equal(site.actions.get(101).status, 'failed');
	assert.equal(sends(site, 'Order 101'), 0);
});

test('tickEmailDecision: an action mail is always handed off; a WP-Cron mail by its tag; other mail held after a reset', () => {
	assert.equal(tickEmailDecision({ as_action: 7 }, 0), HANDOFF);
	assert.equal(tickEmailDecision({ as_action: 7 }, 3), HANDOFF);
	assert.equal(tickEmailDecision({ wp_cron: 1 }, 3), HANDOFF);
	assert.equal(tickEmailDecision({ wp_cron: -1 }, 0), HOLD);
	assert.equal(tickEmailDecision({}, 0), HANDOFF);
	assert.equal(tickEmailDecision({}, 1), HOLD);
	assert.equal(tickEmailDecision(null, 0), HANDOFF);
	assert.equal(emailActionId({ as_action: '12' }), 12);
	assert.equal(emailActionId({ as_action: -1 }), 0);
	assert.equal(emailActionId(undefined), 0);
});

test('createTickMail counts and logs each decision; a handoff that throws is reported, not swallowed', async () => {
	const lines = [];
	let lost = 0;
	const sent = [];
	const m = createTickMail({ handoff: async (e) => { if (e.subject === 'boom') throw new Error('queue down'); sent.push(e); return e.subject === 'slow' ? 'bounded' : 1; }, lostWrites: () => lost, log: (o) => lines.push(o) });
	assert.deepEqual(await m.op({ subject: 'a', as_action: 5 }), { ok: true, queued: true });
	assert.deepEqual(await m.op({ subject: 'slow' }), { ok: true, queued: true });
	lost = 2;
	assert.deepEqual(await m.op({ subject: 'b' }), { ok: true, queued: false, held: true });
	const f = await m.op({ subject: 'boom', as_action: 6 });
	assert.equal(f.ok, false);
	assert.deepEqual(m.counts, { handedOff: 2, held: 1, failed: 1, bounded: 1 });
	assert.equal(m.lostWritesSeen(), 2);
	assert.deepEqual(sent.map((e) => e.subject), ['a', 'slow']);
	assert.deepEqual(lines.map((l) => l['@event']), ['email-handoff', 'email-handoff', 'email-held', 'email-handoff']);
	assert.equal(lines[0].as_action, 5, 'the dedupe key is logged');
});

// The glue in index.js: the op goes to the tick's handoff, and only for runCron's own PHP run.
const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const fnBody = (name) => {
	const a = src.indexOf('function ' + name + '(');
	assert.ok(a >= 0, name + ' is in index.js');
	return src.slice(a, src.indexOf('\n}\n', a));
};
test('index.js: in a tick the email op hands off before it would collect; a request still collects', () => {
	const op = fnBody('emailOp');
	assert.ok(op.indexOf('if (tickMail) return tickMail.op(email);') >= 0);
	assert.ok(op.indexOf('if (tickMail)') < op.indexOf('pendingEmails.push(email)'));
	assert.ok(src.includes('if (m.email) return JSON.stringify(await emailOp(m.email));'), 'PHP waits for the handoff');
});
test('index.js: runCron sets the tick mail inside its withPhp turn and always clears it; the alarm and /_runcron pass one', () => {
	const rc = src.slice(src.indexOf('async function runCron('), src.indexOf('async function toPhpObject('));
	const w = rc.indexOf('return withPhp(async () => {');
	assert.ok(w >= 0);
	assert.ok(rc.indexOf('tickMail = mail;') > w);
	assert.ok(/\} finally \{\s*tickMail = null;/.test(rc));
	assert.ok(src.includes('cr = await runCron(await (bootPromise ??= boot(cronOrigin)), cleanDue, mail);'), 'the alarm');
	assert.ok(src.includes('const r = await runCron(await bootPromise, false, mail);'), '/_runcron');
	assert.ok(src.includes('resetFailTotal += resetFailures([f]);'));
	assert.equal((src.match(/stats\.failures\.push\(/g) || []).length, 1, 'every failure is counted through noteFailure');
});

// wp-mail-queue.php: the real mu-plugin, run by the php CLI with a stub hook API, tags each message.
test('wp-mail-queue.php tags a mail with the running action, and with the WP-Cron saved flag', (t) => {
	if (spawnSync('php', ['-v']).status !== 0) return t.skip('php CLI not found');
	const dir = mkdtempSync(join(tmpdir(), 'mailq-'));
	try {
		const plugin = new URL('../php/wp-mail-queue.php', import.meta.url).pathname;
		const php = `<?php
			$hooks = array(); $sent = array();
			function add_action( $h, $f, $p = 10, $n = 1 ) { global $hooks; $hooks[ $h ][] = $f; }
			function do_action( $h, ...$a ) { global $hooks; foreach ( isset( $hooks[ $h ] ) ? $hooks[ $h ] : array() as $f ) { $f( ...$a ); } }
			function wp_json_encode( $v ) { return json_encode( $v ); }
			function post_message_to_js( $m ) { global $sent; $sent[] = json_decode( $m, true )['email']; return '{}'; }
			define( 'SKYPHUSION_ASYNC_EMAIL', true );
			require ${JSON.stringify(plugin)};
			wp_mail( 'a@example.com', 'outside', 'x' );
			do_action( 'action_scheduler_begin_execute', 55, 'ctx' );
			wp_mail( 'a@example.com', 'inside', 'x' );
			do_action( 'action_scheduler_after_execute', 55, null, 'ctx' );
			wp_mail( 'a@example.com', 'after', 'x' );
			do_action( 'action_scheduler_begin_execute', 56, 'ctx' );
			do_action( 'action_scheduler_failed_execution', 56, null, 'ctx' );
			wp_mail( 'a@example.com', 'afterfail', 'x' );
			$GLOBALS['skyphusion_mail_wp_cron'] = -1; wp_mail( 'a@example.com', 'cron', 'x' ); $GLOBALS['skyphusion_mail_wp_cron'] = 0;
			echo json_encode( $sent );`;
		const f = join(dir, 't.php');
		writeFileSync(f, php);
		const r = spawnSync('php', [f], { encoding: 'utf8' });
		assert.equal(r.status, 0, r.stderr + r.stdout);
		const got = JSON.parse(r.stdout).map((e) => [e.subject, e.as_action, e.wp_cron]);
		assert.deepEqual(got, [['outside', 0, 0], ['inside', 55, 0], ['after', 0, 0], ['afterfail', 0, 0], ['cron', 0, -1]]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// runCron's WP-Cron leg: the REAL rendered script, run by the php CLI against stubs (as
// cron-run-queue.test.mjs does). The event sees the saved flag its mail will carry.
const rcAt = src.indexOf('async function runCron(');
const tplOpen = src.indexOf('php.run({ code: `', rcAt) + 'php.run({ code: `'.length;
const tpl = src.slice(tplOpen, src.indexOf('` });', tplOpen));
const renderCron = () => new Function('actions', 'wpEvents', 'cleanDue', 'return `' + tpl + '`;')(1, 1, false);
const CRON_STUBS = `<?php
$GLOBALS['seen'] = array(); $GLOBALS['mailq_hooks'] = array();
function add_action( $h, $f ) { $GLOBALS['mailq_hooks'][ $h ][] = $f; }
function remove_all_actions( $h ) { unset( $GLOBALS['mailq_hooks'][ $h ] ); }
function add_filter( $h, $f ) {}
function remove_filter( $h, $f ) {}
function do_action_ref_array( $h, $args ) { foreach ( isset( $GLOBALS['mailq_hooks'][ $h ] ) ? $GLOBALS['mailq_hooks'][ $h ] : array() as $f ) { call_user_func_array( $f, $args ); } }
function wp_cache_flush_runtime() {}
function wp_unschedule_event( $ts, $h, $a ) { return '1' === getenv( 'STUB_UNSCHED_OK' ); }
function wp_reschedule_event( $ts, $s, $h, $a, $i = 0 ) { return '1' === getenv( 'STUB_RESCHED_OK' ); }
function _get_cron_array() { return array( time() - 60 => array( 'wc_admin_digest' => array( 'k' => array( 'schedule' => getenv( 'STUB_SCHEDULE' ) ?: false, 'args' => array() ) ) ) ); }
add_action( 'wc_admin_digest', function () { $GLOBALS['seen'][] = $GLOBALS['skyphusion_mail_wp_cron']; } );
register_shutdown_function( function () { $GLOBALS['seen'][] = $GLOBALS['skyphusion_mail_wp_cron']; fwrite( STDERR, json_encode( $GLOBALS['seen'] ) ); } );
`;
function runCronLeg(envs) {
	const d = mkdtempSync(join(tmpdir(), 'mail-cron-'));
	try {
		writeFileSync(join(d, 'stubs.php'), CRON_STUBS);
		writeFileSync(join(d, 'cron.php'), renderCron().replace("require '/wordpress/wp-load.php';", "require '" + join(d, 'stubs.php') + "';"));
		const r = spawnSync('php', ['-n', join(d, 'cron.php')], { env: { ...process.env, ...envs }, encoding: 'utf8' });
		assert.equal(r.status, 0, r.stderr + r.stdout);
		return JSON.parse(r.stderr);
	} finally {
		rmSync(d, { recursive: true, force: true });
	}
}
test('runCron: an event whose unschedule was saved runs with wp_cron 1, and the flag is cleared after it', (t) => {
	if (spawnSync('php', ['-v']).status !== 0) return t.skip('php CLI not found');
	assert.deepEqual(runCronLeg({ STUB_UNSCHED_OK: '1' }), [1, 0]);
});
test('runCron: an event whose unschedule failed (a reset) runs with wp_cron -1, so its mail is held', (t) => {
	if (spawnSync('php', ['-v']).status !== 0) return t.skip('php CLI not found');
	assert.deepEqual(runCronLeg({ STUB_UNSCHED_OK: '0' }), [-1, 0]);
});
test('runCron: a recurring event whose reschedule failed runs with wp_cron -1', (t) => {
	if (spawnSync('php', ['-v']).status !== 0) return t.skip('php CLI not found');
	assert.deepEqual(runCronLeg({ STUB_UNSCHED_OK: '1', STUB_RESCHED_OK: '0', STUB_SCHEDULE: 'hourly' }), [-1, 0]);
	assert.deepEqual(runCronLeg({ STUB_UNSCHED_OK: '1', STUB_RESCHED_OK: '1', STUB_SCHEDULE: 'hourly' }), [1, 0]);
});
