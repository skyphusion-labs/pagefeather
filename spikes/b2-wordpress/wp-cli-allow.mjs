// Which WP-CLI commands may run while the site code is locked (issue #1258).
//
// WP-CLI 2.12.0 does not read DISALLOW_FILE_MODS. The step 1 probe installed a plugin
// once the SAPI check was skipped. This list is the lock.
//
// Pass an argv array of strings, one element per argument. This module does not split
// a shell string. A refusal repeats the command name only.
//
// user list and user get never print user_pass or user_activation_key. Those names
// are refused in --field, in --fields, and in a --format template.

const ISSUE = 'See issue #1258.';
const INVALID = 'Refused: the command is not a list of arguments. This site\'s code is locked. ' + ISSUE;
const EMPTY = 'Refused an empty command: this site\'s code is locked. ' + ISSUE;

const DANGEROUS = new Set(['exec', 'require', 'path', 'ssh', 'http']);

// flagNames null: any flag except a dangerous one or a short option.
// flagNames set: only those bare flags, and every name in `need` must be present.
const RULES = [
	{ words: ['option', 'get'], minPos: 0, maxPos: 1, flagNames: null, need: [] },
	{ words: ['user', 'list'], minPos: 0, maxPos: 0, flagNames: null, need: [] },
	{ words: ['cache', 'flush'], minPos: 0, maxPos: 0, flagNames: null, need: [] },
	{ words: ['cron', 'event', 'list'], minPos: 0, maxPos: 0, flagNames: null, need: [] },
	{ words: ['cron', 'event', 'run'], minPos: 0, maxPos: 0, flagNames: ['due-now'], need: ['due-now'] },
	{ words: ['transient', 'delete'], minPos: 0, maxPos: 0, flagNames: ['expired'], need: ['expired'] },
	{ words: ['post', 'list'], minPos: 0, maxPos: 0, flagNames: null, need: [] },
	{ words: ['core', 'version'], minPos: 0, maxPos: 0, flagNames: null, need: [] },
];

export const WP_CLI_ALLOW = Object.freeze(RULES.map((row) => {
	const item = { command: row.words.join(' ') };
	if (row.need.length) item.flags = Object.freeze(row.need.slice());
	return Object.freeze(item);
}));

export const WP_CLI_REFUSED_FLAGS = Object.freeze(['exec', 'require', 'path', 'ssh', 'http']);

// Known command words, so a refusal can name `config set` and not the value after it.
// A word that is not in this tree is an argument, not part of the command name.
function tree(spec) {
	const node = Object.create(null);
	for (const key of Object.keys(spec)) {
		const child = spec[key];
		node[key] = child && typeof child === 'object' ? tree(child) : Object.create(null);
	}
	return node;
}

const NAMES = tree({
	option: { get: 1, update: 1, delete: 1, patch: 1, list: 1, add: 1, pluck: 1 },
	user: { list: 1, get: 1, create: 1, delete: 1, update: 1, meta: { list: 1, get: 1, add: 1, update: 1, delete: 1 } },
	cache: { flush: 1, add: 1, get: 1, delete: 1, set: 1, type: 1, replace: 1 },
	cron: { event: { list: 1, run: 1, delete: 1, schedule: 1 }, schedule: { list: 1 }, test: 1 },
	transient: { get: 1, set: 1, delete: 1, list: 1, type: 1 },
	post: { list: 1, get: 1, create: 1, update: 1, delete: 1 },
	core: { version: 1, update: 1, download: 1, install: 1, 'check-update': 1, 'verify-checksums': 1, 'is-installed': 1, 'update-db': 1 },
	plugin: { install: 1, update: 1, delete: 1, uninstall: 1, list: 1, get: 1, status: 1, activate: 1, deactivate: 1, search: 1, path: 1 },
	theme: { install: 1, update: 1, delete: 1, uninstall: 1, list: 1, get: 1, status: 1, activate: 1, search: 1, path: 1 },
	db: { import: 1, query: 1, reset: 1, export: 1, check: 1, create: 1, drop: 1, cli: 1, tables: 1, columns: 1, clean: 1, optimize: 1, repair: 1 },
	package: { install: 1, update: 1, list: 1, path: 1, uninstall: 1 },
	config: { get: 1, set: 1, create: 1, delete: 1, list: 1, path: 1, edit: 1, has: 1, 'shuffle-salts': 1 },
	eval: 1,
	'eval-file': 1,
	shell: 1,
	'search-replace': 1,
});

function asciiLower(s) {
	let out = '';
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		out += c >= 65 && c <= 90 ? String.fromCharCode(c + 32) : s[i];
	}
	return out;
}

function locked(command) {
	if (!command) return 'Refused: this site\'s code is locked. ' + ISSUE;
	return 'Refused `' + command + '`: this site\'s code is locked. ' + ISSUE;
}

function later(command) {
	return 'Refused `' + command + '`: this command needs a later step. ' + ISSUE;
}

function plainStringArray(value) {
	if (!Array.isArray(value)) return false;
	if (Object.getPrototypeOf(value) !== Array.prototype) return false;
	if (Object.keys(value).length !== value.length) return false;
	for (let i = 0; i < value.length; i++) {
		if (typeof value[i] !== 'string') return false;
	}
	return true;
}

// WP-CLI 2.12.0 Configurator::extract_assoc reads every `--key` in the list.
// A `--` does not end that scan. `--exec` after `--` is still the exec flag.
// The `--` token itself is not a command word.
// A dangerous bare flag may be followed by its value (`--exec phpinfo()`).
// That value is not a command word and is not kept.
function parseArgv(argv) {
	const positionals = [];
	const flags = [];
	for (let i = 0; i < argv.length; i++) {
		const token = argv[i];
		if (token === '--') continue;
		if (token.startsWith('--')) {
			const body = token.slice(2);
			const eq = body.indexOf('=');
			const raw = eq === -1 ? body : body.slice(0, eq);
			const lower = asciiLower(raw);
			// `--no-exec` is the exec flag set false. It is still that flag.
			const negated = eq === -1 && lower.startsWith('no-') && lower.length > 3;
			const name = negated ? raw.slice(3) : raw;
			const hasValue = eq !== -1 || negated;
			const value = eq === -1 ? '' : body.slice(eq + 1);
			if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) return { error: true };
			flags.push({ name, hasValue, short: false, value });
			if (!hasValue && DANGEROUS.has(asciiLower(name)) && i + 1 < argv.length && argv[i + 1] !== '--' && !argv[i + 1].startsWith('-')) {
				i += 1;
			}
			continue;
		}
		if (token.startsWith('-') && token !== '-') {
			flags.push({ name: token, hasValue: false, short: true, value: '' });
			continue;
		}
		positionals.push(token);
	}
	return { positionals, flags };
}

function commandName(positionals) {
	let node = NAMES;
	const words = [];
	for (const word of positionals) {
		if (node === null || typeof node !== 'object' || !Object.hasOwn(node, word)) break;
		words.push(word);
		node = node[word];
	}
	if (words.length > 0) return words.join(' ');
	const first = positionals[0];
	if (typeof first === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(first)) return first;
	return '';
}

function blocks(flag) {
	if (flag.short) return true;
	return DANGEROUS.has(asciiLower(flag.name));
}

const SECRET_FIELD = new Set(['user_pass', 'user_activation_key']);

// user list and user get can print password hashes. Refuse those names in
// --field, in a --fields list, and inside a --format template.
function secretField(command, flags) {
	if (command !== 'user list' && command !== 'user get') return false;
	for (const flag of flags) {
		if (flag.short || !flag.hasValue) continue;
		const name = asciiLower(flag.name);
		const value = asciiLower(flag.value || '');
		if (name === 'field') {
			if (SECRET_FIELD.has(value)) return true;
		} else if (name === 'fields') {
			for (const part of value.split(',')) {
				if (SECRET_FIELD.has(part.trim())) return true;
			}
		} else if (name === 'format') {
			if (value.includes('user_pass') || value.includes('user_activation_key')) return true;
		}
	}
	return false;
}

function secretFields(command) {
	return 'Refused `' + command + '`: the fields user_pass and user_activation_key are never printed. See issue #1258.';
}

function matchAllow(positionals, flags) {
	let best = null;
	for (const row of RULES) {
		if (positionals.length < row.words.length) continue;
		let same = true;
		for (let i = 0; i < row.words.length; i++) {
			if (positionals[i] !== row.words[i]) {
				same = false;
				break;
			}
		}
		if (!same) continue;
		if (!best || row.words.length > best.words.length) best = row;
	}
	if (!best) return null;
	const extra = positionals.length - best.words.length;
	if (extra < best.minPos || extra > best.maxPos) return null;
	if (best.flagNames) {
		for (const flag of flags) {
			if (flag.hasValue || !best.flagNames.includes(flag.name)) return null;
		}
		for (const name of best.need) {
			if (!flags.some((flag) => flag.name === name && !flag.hasValue)) return null;
		}
	}
	return best;
}

// { allowed: true, command } or { allowed: false, command, message }.
// `command` is the command name only. It is empty when there is nothing safe to name.
export function decideWpCli(argv) {
	if (!plainStringArray(argv)) return { allowed: false, command: '', message: INVALID };
	if (argv.length === 0) return { allowed: false, command: '', message: EMPTY };
	const parsed = parseArgv(argv);
	if (parsed.error) return { allowed: false, command: '', message: INVALID };
	if (parsed.positionals.length === 0 && parsed.flags.length === 0) {
		return { allowed: false, command: '', message: EMPTY };
	}
	const command = commandName(parsed.positionals);
	if (parsed.flags.some(blocks)) return { allowed: false, command, message: locked(command) };
	if (parsed.positionals[0] === 'search-replace') {
		return { allowed: false, command: 'search-replace', message: later('search-replace') };
	}
	if (secretField(command, parsed.flags)) {
		return { allowed: false, command, message: secretFields(command) };
	}
	const match = matchAllow(parsed.positionals, parsed.flags);
	if (match) return { allowed: true, command: match.words.join(' ') };
	return { allowed: false, command, message: locked(command) };
}
