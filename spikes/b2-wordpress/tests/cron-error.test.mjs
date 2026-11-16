// node --test spikes/b2-wordpress/tests/cron-error.test.mjs (#348)
// A cron tick that dies with PHP exit 255 logs the fatal message and file:line.
// index.js cannot be imported under node (it loads php-wasm). The decision is
// cron-error.mjs; the catch in index.js is read from the source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cronFailureLine } from '../cron-error.mjs';

const COOKIE = 'sekretcookievalue';
const TOKEN = 'tok_EXAMPLE_not_a_real_secret';
const EMAIL = 'buyer@shop.test';
const ORDER = 'wc_order_EXAMPLE';
const TAIL = 'tok_TAIL_not_logged';

const CRITICAL = '<!DOCTYPE html><html lang="en-US"><head><meta http-equiv="Content-Type" content="text/html; charset=UTF-8" /><title>WordPress &rsaquo; Error</title></head><body id="error-page"><div class="wp-die-message"><p>There has been a critical error on this website.</p><p>token=' + TOKEN + '</p></div></body></html>';

function phpRunError(stdout, stderr) {
	const message = 'PHP.run() failed with exit code 255. \n\n=== Stdout ===\n ' + stdout + '\n\n=== Stderr ===\n ' + stderr;
	const withResponse = new Error(message);
	withResponse.response = { exitCode: 255, text: stdout, errors: stderr };
	const messageOnly = new Error(message);
	return [withResponse, messageOnly];
}

function logged(detail) {
	return JSON.stringify({ m: 'cron', error: detail.error, errMsg: detail.errMsg, errFile: detail.errFile, errLine: detail.errLine, stderrHead: detail.stderrHead });
}

function assertNoSecrets(text) {
	assert.equal(text.includes(COOKIE), false, 'cookie logged');
	assert.equal(text.includes(TOKEN), false, 'token logged');
	assert.equal(text.includes(EMAIL), false, 'email logged');
	assert.equal(text.includes(ORDER), false, 'order key logged');
	assert.equal(text.includes(TAIL), false, 'stderr past 2 KiB logged');
	assert.equal(text.includes('<!DOCTYPE'), false, 'error page logged');
	assert.equal(text.includes('<head>'), false, 'error page head logged');
	assert.equal(/critical error/i.test(text), false, 'critical error page text logged');
}

test('a cron exit 255 with a PHP fatal on stderr logs the message and file:line, bounded, with no token or cookie', () => {
	const stderr = [
		'PHP Fatal error:  Uncaught Error: Call to undefined function skyphusion_cron_boom() in /wordpress/wp-content/plugins/demo/boom.php:17',
		'Stack trace:',
		'#0 {main}',
		'  thrown in /wordpress/wp-content/plugins/demo/boom.php on line 17',
		'Cookie: wordpress_logged_in_abc=' + COOKIE,
		'notice ' + EMAIL,
		'request /checkout?key=' + ORDER + '&email=' + EMAIL,
		'token=' + TOKEN,
		'Y'.repeat(8000),
		'token=' + TAIL,
	].join('\n');
	for (const err of phpRunError(CRITICAL, stderr)) {
		const detail = cronFailureLine(err);
		const line = logged(detail);
		assert.match(detail.error, /PHP\.run\(\) failed with exit code 255/);
		assert.equal(detail.errMsg, 'Uncaught Error: Call to undefined function skyphusion_cron_boom()');
		assert.equal(detail.errFile, 'wp-content/plugins/demo/boom.php');
		assert.equal(detail.errLine, 17);
		assert.ok(detail.stderrHead.length <= 2048, 'stderrHead ' + detail.stderrHead.length);
		assert.ok(detail.stderrHead.includes('skyphusion_cron_boom'), 'the fatal is inside the stderr head');
		assertNoSecrets(line);
		assertNoSecrets(JSON.stringify(detail));
	}
});

test('a long fatal message is bounded', () => {
	const stderr = 'PHP Fatal error:  Uncaught Error: ' + 'A'.repeat(2000) + ' in /wordpress/wp-content/plugins/demo/boom.php:17\n';
	const detail = cronFailureLine(phpRunError('', stderr)[0]);
	assert.ok(detail.errMsg.length <= 300, 'errMsg ' + detail.errMsg.length);
	assert.ok(detail.errMsg.startsWith('Uncaught Error: AAAA'));
	assert.equal(detail.errFile, 'wp-content/plugins/demo/boom.php');
	assert.equal(detail.errLine, 17);
});

test('an on-line fatal (memory exhausted) keeps the message and file:line', () => {
	const stderr = 'PHP Fatal error:  Allowed memory size of 134217728 bytes exhausted (tried to allocate 4096 bytes) in /wordpress/wp-includes/class-wpdb.php on line 2345\n';
	const detail = cronFailureLine(phpRunError('', stderr)[0]);
	assert.equal(detail.errMsg, 'Allowed memory size of 134217728 bytes exhausted (tried to allocate 4096 bytes)');
	assert.equal(detail.errFile, 'wp-includes/class-wpdb.php');
	assert.equal(detail.errLine, 2345);
});

test('a critical error page is not the message: an empty stderr leaves errMsg empty', () => {
	const detail = cronFailureLine(phpRunError(CRITICAL, '')[0]);
	assert.equal(detail.errMsg, '');
	assert.equal(detail.errFile, '');
	assert.equal(detail.errLine, 0);
	assert.equal(detail.stderrHead, '');
	assertNoSecrets(JSON.stringify(detail));
});

test('with no stderr, a fatal printed in the error page text is kept', () => {
	const html = '<b>Fatal error</b>:  Uncaught Error: boom_from_page in <b>/wordpress/wp-content/plugins/p/a.php</b> on line <b>9</b><br />';
	const detail = cronFailureLine(phpRunError(html, '')[0]);
	assert.equal(detail.errMsg, 'Uncaught Error: boom_from_page');
	assert.equal(detail.errFile, 'wp-content/plugins/p/a.php');
	assert.equal(detail.errLine, 9);
	assert.equal(detail.stderrHead, '');
});

test('a script block whose end tag has a space is stripped, so its text is never read as the fatal (CodeQL js/bad-tag-filter)', () => {
	const html = '<script>var x = "Fatal error: Uncaught Error: from_script in /wordpress/s.php on line 3";</script >' +
		'<b>Fatal error</b>:  Uncaught Error: boom_from_page in <b>/wordpress/wp-content/plugins/p/a.php</b> on line <b>9</b><br />';
	const detail = cronFailureLine(phpRunError(html, '')[0]);
	assert.equal(detail.errMsg, 'Uncaught Error: boom_from_page');
	assert.equal(detail.errLine, 9);
});

test('index.js: the cron catch logs errMsg, errFile, errLine and stderrHead from cronFailureLine', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	assert.match(src, /import \{ cronFailureLine \} from '\.\/cron-error\.mjs'/);
	const i = src.indexOf("console.log(JSON.stringify({ m: 'cron', error:");
	assert.ok(i >= 0, 'the cron error log line');
	const block = src.slice(Math.max(0, i - 250), i + 900);
	assert.match(block, /const detail = cronFailureLine\(e\)/);
	assert.match(block, /errMsg: detail\.errMsg/);
	assert.match(block, /errFile: detail\.errFile/);
	assert.match(block, /errLine: detail\.errLine/);
	assert.match(block, /stderrHead: detail\.stderrHead/);
	assert.match(block, /cst\.cron = \{ t: Date\.now\(\), error:/);
});
