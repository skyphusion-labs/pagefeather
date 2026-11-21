// Run one allowed WP-CLI argv through php.cli (issue #1258).
//
// Config files are not loaded. WP_CLI_CONFIG_PATH is an empty file this runner
// writes. The working directory has no wp-cli.yml. WP-CLI 2.12 walks up from
// the working directory for wp-cli.yml and wp-cli.local.yml, and reads the
// global file from WP_CLI_CONFIG_PATH. A yml under /wordpress is not on that walk.
// STDIN is not passed. php.cli leaves it empty.
//
// php.cli exits the runtime. The caller discards that runtime after the call.

export const WP_CLI_PHAR = '/wordpress/wp-cli.phar';
export const WP_CLI_CWD = '/internal/wp-cli-run';
export const WP_CLI_CONFIG = '/internal/wp-cli-empty.yml';
export const WP_CLI_PACKAGES = '/internal/wp-cli-packages';
export const WP_CLI_WALL_MS = 25000;
export const WP_CLI_STDOUT_CAP = 1024 * 1024;
export const WP_CLI_STDERR_CAP = 64 * 1024;

export function projectConfigPaths(cwd) {
	const paths = [];
	let dir = cwd || '/';
	const seen = new Set();
	while (!seen.has(dir)) {
		seen.add(dir);
		paths.push(dir + '/wp-cli.yml', dir + '/wp-cli.local.yml');
		if (dir === '/') break;
		const slash = dir.lastIndexOf('/');
		dir = slash <= 0 ? '/' : dir.slice(0, slash);
	}
	return paths;
}

export function wpCliEnv() {
	return {
		HOME: WP_CLI_CWD,
		WP_CLI_CONFIG_PATH: WP_CLI_CONFIG,
		WP_CLI_PACKAGES_DIR: WP_CLI_PACKAGES,
		WP_CLI_DISABLE_AUTO_CHECK_UPDATE: '1',
	};
}

function mkdirp(php, path) {
	const parts = String(path).split('/').filter(Boolean);
	let cur = '';
	for (const part of parts) {
		cur += '/' + part;
		try { php.mkdir(cur); } catch { /* the directory is already there */ }
	}
}

function prepare(php) {
	mkdirp(php, WP_CLI_CWD);
	mkdirp(php, WP_CLI_PACKAGES);
	php.writeFile(WP_CLI_CONFIG, '');
}

// A local engine check asks an allowed command to take longer than a short
// wall. The file is written into this runtime only. It is not in site.zip.
// The next boot does not have it unless the check asks again.
function writeSlowHook(php, slowMs) {
	const ms = Math.floor(Number(slowMs));
	if (!Number.isFinite(ms) || ms <= 0) return;
	mkdirp(php, '/wordpress/wp-content/mu-plugins');
	php.writeFile(
		'/wordpress/wp-content/mu-plugins/wp-cli-slow-test.php',
		'<?php\nif (defined(\'WP_CLI\') && WP_CLI) { usleep(' + String(ms * 1000) + '); }\n',
	);
}

function readCapped(stream, cap, wallMs) {
	return new Promise((resolve) => {
		let text = '';
		let settled = false;
		let reader = null;
		const finish = (out) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			// A wall timeout must drop the reader. Otherwise the wasm keeps
			// writing into a stream nobody reads.
			if (out.timedOut && reader) {
				try { reader.cancel(); } catch { /* already closed */ }
			}
			resolve(out);
		};
		const timer = setTimeout(() => finish({ text, truncated: true, timedOut: true }), wallMs);
		(async () => {
			try {
				if (!stream || typeof stream.getReader !== 'function') {
					finish({ text: '', truncated: false, timedOut: false });
					return;
				}
				reader = stream.getReader();
				const dec = new TextDecoder();
				let n = 0;
				let truncated = false;
				while (n < cap) {
					const step = await reader.read();
					if (step.done) break;
					const chunk = step.value;
					const room = cap - n;
					if (chunk.byteLength > room) {
						text += dec.decode(chunk.subarray(0, room), { stream: false });
						truncated = true;
						try { await reader.cancel(); } catch { /* the stream already ended */ }
						finish({ text, truncated, timedOut: false });
						return;
					}
					text += dec.decode(chunk, { stream: true });
					n += chunk.byteLength;
				}
				text += dec.decode();
				if (!truncated && n >= cap) {
					const extra = await reader.read();
					if (!extra.done && extra.value && extra.value.byteLength > 0) truncated = true;
					try { await reader.cancel(); } catch { /* already closed */ }
				}
				finish({ text, truncated, timedOut: false });
			} catch {
				finish({ text, truncated: false, timedOut: false });
			}
		})();
	});
}

function exitBy(exitCode, wallMs) {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (out) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(out);
		};
		const timer = setTimeout(() => finish({ code: 124, timedOut: true }), wallMs);
		Promise.resolve(exitCode).then(
			(code) => finish({ code: Number(code), timedOut: false }),
			() => finish({ code: 1, timedOut: false }),
		);
	});
}

// { exit, stdout, stderr, truncated, ms }. A wall timeout is exit 124.
export async function runWpCli(php, argv, ctl = {}) {
	const wall = Number.isFinite(ctl.wallMs) ? ctl.wallMs : WP_CLI_WALL_MS;
	const stdoutCap = Number.isFinite(ctl.stdoutCap) ? ctl.stdoutCap : WP_CLI_STDOUT_CAP;
	const stderrCap = Number.isFinite(ctl.stderrCap) ? ctl.stderrCap : WP_CLI_STDERR_CAP;
	const now = typeof ctl.now === 'function' ? ctl.now : Date.now;
	const started = now();
	prepare(php);
	writeSlowHook(php, ctl.slowMs);
	if (typeof php.setSpawnHandler === 'function') {
		php.setSpawnHandler(() => ({ exitCode: 127, stdout: '', stderr: 'spawn refused' }));
	}
	let streamed;
	try {
		streamed = await php.cli(['php', WP_CLI_PHAR, ...argv], { cwd: WP_CLI_CWD, env: wpCliEnv() });
	} catch (e) {
		return {
			exit: 1,
			stdout: '',
			stderr: String((e && e.message) || 'wp-cli failed').slice(0, 500),
			truncated: false,
			ms: Math.max(0, now() - started),
		};
	}
	const [out, err, exit] = await Promise.all([
		readCapped(streamed.stdout, stdoutCap, wall),
		readCapped(streamed.stderr, stderrCap, wall),
		exitBy(streamed.exitCode, wall),
	]);
	const timedOut = out.timedOut || err.timedOut || exit.timedOut;
	// dropRuntime queues php.exit until this run's lock ends. Call it here too,
	// so a command that is still inside php.cli is stopped when the wall hits.
	// A second exit from the retirer is ignored.
	if (timedOut && typeof php.exit === 'function') {
		try { php.exit(124); } catch { /* the runtime is finished either way */ }
	}
	return {
		exit: timedOut ? 124 : exit.code,
		stdout: out.text,
		stderr: err.text,
		truncated: Boolean(timedOut || out.truncated || err.truncated),
		ms: Math.max(0, now() - started),
	};
}
