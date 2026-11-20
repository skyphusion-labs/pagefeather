// node --test spikes/b2-wordpress/tests/email-send-timing.test.mjs (#1135)
// The lead's condition for a synchronous request-path send: measure the send time live first (a send inside wp_mail is
// held PHP lock on approach A; stop if the p95 is above about 1 s). Every env.EMAIL.send is timed: email-sent carries
// ms, and a refused send's email-send-failed line carries it too (sendTimed attaches it to the rejection).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

test('#1135 each send is timed: email-sent carries ms', () => {
	assert.match(src, /function sendTimed\(p\) \{/);
	assert.match(src, /console\.log\(JSON\.stringify\(\{ m: 'email-sent', n: stats\.emailSent, ms: Date\.now\(\) - t0 \}\)\)/);
	assert.match(src, /return deliverable\.map\(\(to\) => Object\.assign\(sendTimed\(/, 'every recipient send goes through it');
});
test('#1135 a refused send is timed too: the rejection carries pfSendMs, and email-send-failed logs it', () => {
	assert.match(src, /if \(e && typeof e === 'object'\) e\.pfSendMs = Date\.now\(\) - t0;/);
	assert.match(src, /failures\.push\(\{ email: items\[i\]\.e, to: items\[i\]\.p\.to, error: String\(\(x\.reason && x\.reason\.message\) \|\| x\.reason\), ms: x\.reason && Number\.isFinite\(x\.reason\.pfSendMs\) \? x\.reason\.pfSendMs : null \}\);/);
	assert.match(src, /m: 'email-send-failed', reason: scrub\(f\.error\), domain: domainOfAddress\(f\.to\), ms: f\.ms, retry: 'queued'/);
});
