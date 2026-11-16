// What a cron catch logs when PHP.run() throws (#348).
//
// php-wasm's Error message is "PHP.run() failed with exit code N", then
// === Stdout === (WordPress's HTML error page) and === Stderr === (the fatal).
// The first 200 characters stop inside <head>, so the fatal was not readable.
// The line carries the fatal message and file:line from stderr (or, when stderr
// has none, from the error page's text). A WordPress "critical error" page has
// no fatal in the HTML; that text is not the message. stderrHead is the first
// 2 KiB of stderr. Cookies, tokens, emails, order keys and query strings are
// removed. Nothing here reads a request or a database.

export const STDERR_HEAD_MAX = 2048;
export const ERR_MSG_MAX = 300;
const STACK_MAX = 1200;
const SCAN_MAX = 8192;

const FATAL_RE = /(?:PHP\s+)?(?:Fatal error|Parse error)\s*:\s*([\s\S]+?)\s+in\s+(\S+?)(?::(\d+)|\s+on line\s+(\d+))/i;

/** Drop cookies, tokens, emails, order keys and query strings. Bounded by the caller. */
export function redactCronText(s) {
	let t = String(s ?? '');
	t = t.replace(/\b(?:Set-Cookie|Cookie)\b\s*:\s*[^\r\n]{0,800}/gi, '[cookie]');
	t = t.replace(/\bwordpress(?:_sec|_logged_in)_[A-Za-z0-9]+=\S+/g, '[cookie]');
	t = t.replace(/\?[^\s"'<>]*/g, '');
	t = t.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]');
	t = t.replace(/\bBearer\s+\S+/gi, '[token]');
	t = t.replace(/\b(?:token|secret|password|passwd|nonce|api[_-]?key|authorization)\b\s*[=:]\s*\S+/gi, '[token]');
	t = t.replace(/\bwc_order_[A-Za-z0-9]+\b/g, '[order]');
	t = t.replace(/\b(?:billing|shipping)_[a-z0-9_]+\s*[=:]\s*\S+/gi, '[order]');
	t = t.replace(/[\x00-\x1f\x7f]/g, ' ');
	return t;
}

function stderrText(err) {
	const r = err && err.response;
	if (r && typeof r.errors === 'string') return r.errors;
	if (r && typeof r.stderr === 'string') return r.stderr;
	if (err && typeof err.stderr === 'string') return err.stderr;
	const msg = String((err && err.message) || '');
	const j = msg.indexOf('=== Stderr ===');
	if (j < 0) return '';
	return msg.slice(j + '=== Stderr ==='.length).replace(/^\n ?/, '');
}

function stdoutText(err) {
	const r = err && err.response;
	if (r && typeof r.text === 'string') return r.text;
	if (err && typeof err.stdout === 'string') return err.stdout;
	const msg = String((err && err.message) || '');
	const a = msg.indexOf('=== Stdout ===');
	if (a < 0) return '';
	const b = msg.indexOf('=== Stderr ===', a + 1);
	return msg.slice(a + '=== Stdout ==='.length, b >= 0 ? b : undefined).replace(/^\n ?/, '');
}

function fatalLine(text) {
	for (const part of String(text || '').split(/\r?\n/)) {
		if (/(?:Fatal error|Parse error)\s*:/i.test(part)) return part;
	}
	return '';
}

function cleanFile(file) {
	let f = String(file || '').split('?')[0].replace(/^\/wordpress\//, '');
	f = f.replace(/[\x00-\x1f\x7f]/g, '');
	f = f.replace(/[^A-Za-z0-9_./:-]/g, '');
	return f.slice(0, 160);
}

function parseFatal(text) {
	const line = fatalLine(String(text || '').slice(0, SCAN_MAX));
	if (!line) return null;
	const m = FATAL_RE.exec(line);
	if (!m) return null;
	const n = Number(m[3] || m[4] || 0);
	return {
		msg: m[1].replace(/\s+/g, ' ').trim(),
		file: m[2],
		line: Number.isSafeInteger(n) && n > 0 ? n : 0,
	};
}

function fatalOf(text) {
	const parsed = parseFatal(text);
	if (!parsed) return { msg: '', file: '', line: 0 };
	return {
		msg: redactCronText(parsed.msg).slice(0, ERR_MSG_MAX),
		file: cleanFile(parsed.file),
		line: parsed.line,
	};
}

// PHP's html_errors and wp_die wrap the fatal in tags. The generic critical
// error page does not contain it; callers skip that page.
function htmlToText(html) {
	return String(html || '')
		.replace(/<script\b[^>]*>[\s\S]*?<\/script\b[^>]*>/gi, ' ')
		.replace(/<style\b[^>]*>[\s\S]*?<\/style\b[^>]*>/gi, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/gi, ' ')
		.replace(/&#0*39;|&apos;/gi, "'")
		.replace(/&quot;/gi, '"')
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/&amp;/gi, '&')
		.replace(/&[a-z]+;/gi, ' ');
}

function shortError(err) {
	let msg = String((err && err.message) || err || '');
	msg = msg.split(/\r?\n/)[0];
	msg = msg.split('=== Stdout ===')[0];
	msg = msg.split('=== Stderr ===')[0];
	msg = msg.split(' and the following output')[0];
	const html = msg.search(/<!DOCTYPE|<html/i);
	if (html >= 0) msg = msg.slice(0, html);
	msg = msg.trim();
	if (!msg) msg = 'cron failed';
	return redactCronText(msg).slice(0, 200);
}

function stackOf(err) {
	let s = String((err && err.stack) || '').slice(0, 65536);
	const dump = s.search(/=== Stdout ===|=== Stderr ===|<!DOCTYPE|<html/i);
	if (dump >= 0) {
		const at = s.search(/\n\s+at\s/);
		const frames = at > dump ? s.slice(at) : '';
		s = s.slice(0, dump).trimEnd() + frames;
	}
	return redactCronText(s).slice(0, STACK_MAX);
}

/**
 * Fields for the {"m":"cron",...} failure line and the cron record.
 * error is the short exit line, never the HTML page.
 */
export function cronFailureLine(err) {
	const stderr = stderrText(err);
	const stdout = stdoutText(err);
	let fatal = fatalOf(stderr);
	if (!fatal.msg) {
		const page = htmlToText(String(stdout).slice(0, SCAN_MAX));
		// The critical error page is WordPress's generic screen. The fatal is on
		// stderr or in the error log, not in that HTML.
		if (!/critical error on this website/i.test(page)) fatal = fatalOf(page);
	}
	const head = String(stderr || '').slice(0, STDERR_HEAD_MAX + 256);
	return {
		error: shortError(err),
		errMsg: fatal.msg,
		errFile: fatal.file,
		errLine: fatal.line,
		stderrHead: redactCronText(head).slice(0, STDERR_HEAD_MAX),
		stack: stackOf(err),
	};
}
