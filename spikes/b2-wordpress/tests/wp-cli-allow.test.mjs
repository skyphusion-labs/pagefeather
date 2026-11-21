// node --test spikes/b2-wordpress/tests/wp-cli-allow.test.mjs (#1258 step 2)
// The allowlist is the code lock. WP-CLI does not read DISALLOW_FILE_MODS.
import assert from 'node:assert/strict';
import test from 'node:test';
import { decideWpCli, WP_CLI_ALLOW, WP_CLI_REFUSED_FLAGS } from '../wp-cli-allow.mjs';

const LOCKED = (command) => command
	? `Refused \`${command}\`: this site's code is locked. See issue #1258.`
	: 'Refused: this site\'s code is locked. See issue #1258.';
const LATER = (command) => `Refused \`${command}\`: this command needs a later step. See issue #1258.`;
const INVALID = 'Refused: the command is not a list of arguments. This site\'s code is locked. See issue #1258.';
const EMPTY = 'Refused an empty command: this site\'s code is locked. See issue #1258.';

function refused(argv, command, message, absent) {
	const got = decideWpCli(argv);
	assert.deepEqual(got, { allowed: false, command, message });
	for (const secret of absent) {
		assert.equal(got.message.includes(secret), false, got.message);
	}
	return got;
}

test('the allowlist is these commands and no others', () => {
	assert.deepEqual(
		WP_CLI_ALLOW.map((row) => (row.flags ? `${row.command} --${row.flags.join(' --')}` : row.command)),
		[
			'option get',
			'user list',
			'cache flush',
			'cron event list',
			'cron event run --due-now',
			'transient delete --expired',
			'post list',
			'core version',
		]
	);
	assert.deepEqual(WP_CLI_REFUSED_FLAGS, ['exec', 'require', 'path', 'ssh', 'http']);
});

test('every allowed command passes', () => {
	const cases = [
		[['option', 'get'], 'option get'],
		[['option', 'get', 'siteurl'], 'option get'],
		[['option', 'get', 'siteurl', '--format=json'], 'option get'],
		[['user', 'list'], 'user list'],
		[['user', 'list', '--role=editor', '--fields=ID,user_login'], 'user list'],
		[['cache', 'flush'], 'cache flush'],
		[['cron', 'event', 'list'], 'cron event list'],
		[['cron', 'event', 'list', '--format=table'], 'cron event list'],
		[['cron', 'event', 'run', '--due-now'], 'cron event run'],
		[['transient', 'delete', '--expired'], 'transient delete'],
		[['post', 'list'], 'post list'],
		[['post', 'list', '--post_type=page'], 'post list'],
		[['core', 'version'], 'core version'],
		[['core', 'version', '--extra'], 'core version'],
		[['--debug', 'option', 'get', 'siteurl'], 'option get'],
		[['option', 'get', '--', 'siteurl'], 'option get'],
		[['--', 'cache', 'flush'], 'cache flush'],
	];
	for (const [argv, command] of cases) {
		assert.deepEqual(decideWpCli(argv), { allowed: true, command }, JSON.stringify(argv));
	}
});

test('plugin and theme install, update and delete are refused', () => {
	for (const kind of ['plugin', 'theme']) {
		for (const sub of ['install', 'update', 'delete']) {
			const slug = `${kind}-${sub}-slug`;
			refused([kind, sub, slug], `${kind} ${sub}`, LOCKED(`${kind} ${sub}`), [slug]);
		}
	}
});

test('core update, eval, eval-file, shell, package and config are refused', () => {
	refused(['core', 'update'], 'core update', LOCKED('core update'), []);
	refused(['core', 'update', '--version=9.9.9'], 'core update', LOCKED('core update'), ['9.9.9']);
	refused(['eval', 'echo SECRET_EVAL;'], 'eval', LOCKED('eval'), ['SECRET_EVAL']);
	refused(['eval-file', '/tmp/secret-eval.php'], 'eval-file', LOCKED('eval-file'), ['secret-eval.php']);
	refused(['shell', 'rm -rf /'], 'shell', LOCKED('shell'), ['rm -rf']);
	refused(['package'], 'package', LOCKED('package'), []);
	refused(['package', 'install', 'wp-cli/secret-package'], 'package install', LOCKED('package install'), ['secret-package']);
	refused(['config'], 'config', LOCKED('config'), []);
	refused(['config', 'create', '--dbname=secret-db'], 'config create', LOCKED('config create'), ['secret-db']);
	refused(['config', 'set', 'DB_PASSWORD', 'secret-pass'], 'config set', LOCKED('config set'), ['DB_PASSWORD', 'secret-pass']);
	refused(['config', 'get', 'DB_PASSWORD'], 'config get', LOCKED('config get'), ['DB_PASSWORD']);
});

test('db import, db query and db reset are refused', () => {
	refused(['db', 'import', 'secret-dump.sql'], 'db import', LOCKED('db import'), ['secret-dump.sql']);
	refused(['db', 'query', 'SELECT user_pass FROM wp_users'], 'db query', LOCKED('db query'), ['user_pass']);
	refused(['db', 'reset', '--yes'], 'db reset', LOCKED('db reset'), ['--yes']);
});

test('search-replace needs a later step and the arguments are not repeated', () => {
	refused(
		['search-replace', 'http://old.example', 'http://new.example'],
		'search-replace',
		LATER('search-replace'),
		['old.example', 'new.example']
	);
});

test('a search-replace that also carries --exec is the code lock, and the payload is not repeated', () => {
	refused(
		['search-replace', 'from-host', 'to-host', '--exec', 'SECRET_EXEC_PAYLOAD'],
		'search-replace',
		LOCKED('search-replace'),
		['from-host', 'to-host', 'SECRET_EXEC_PAYLOAD', '--exec']
	);
});

test('an unknown command is refused', () => {
	refused(['made-up', 'secret-arg'], 'made-up', LOCKED('made-up'), ['secret-arg']);
	refused(['option', 'update', 'blogname', 'secret-value'], 'option update', LOCKED('option update'), ['blogname', 'secret-value']);
	refused(['plugin', 'list'], 'plugin list', LOCKED('plugin list'), []);
	refused(['db', 'export', 'secret-out.sql'], 'db export', LOCKED('db export'), ['secret-out.sql']);
	refused(['wp', 'option', 'get', 'siteurl'], 'wp', LOCKED('wp'), ['siteurl']);
});

test('a flag-smuggled --exec after an allowed command is refused', () => {
	refused(
		['option', 'get', 'siteurl', '--exec', 'SECRET_EXEC_PAYLOAD'],
		'option get',
		LOCKED('option get'),
		['siteurl', 'SECRET_EXEC_PAYLOAD', '--exec']
	);
	refused(
		['cache', 'flush', '--exec=SECRET_EXEC_EQ'],
		'cache flush',
		LOCKED('cache flush'),
		['SECRET_EXEC_EQ', '--exec']
	);
});

test('flags that change what runs are refused anywhere in the argument list', () => {
	for (const flag of ['exec', 'require', 'path', 'ssh', 'http']) {
		const secret = `secret-${flag}-value`;
		const cases = [
			['option', 'get', 'siteurl', `--${flag}`, secret],
			['option', 'get', 'siteurl', `--${flag}=${secret}`],
			[`--${flag}`, secret, 'user', 'list'],
			['post', 'list', `--${flag.toUpperCase()}=${secret}`],
			['core', 'version', `--${flag}`, secret],
		];
		for (const argv of cases) {
			const got = decideWpCli(argv);
			assert.equal(got.allowed, false, JSON.stringify(argv));
			assert.match(got.message, /this site's code is locked/);
			assert.match(got.message, /#1258/);
			assert.equal(got.message.includes(secret), false, got.message);
		}
	}
});

test('-- does not hide a flag, because WP-CLI keeps reading flags after it', () => {
	assert.deepEqual(decideWpCli(['option', 'get', '--', 'siteurl']), { allowed: true, command: 'option get' });
	assert.deepEqual(decideWpCli(['option', '--', 'get', 'siteurl']), { allowed: true, command: 'option get' });
	assert.deepEqual(decideWpCli(['cache', 'flush', '--']), { allowed: true, command: 'cache flush' });
	assert.deepEqual(decideWpCli(['--', 'user', 'list']), { allowed: true, command: 'user list' });
	refused(
		['option', 'get', '--', '--exec', 'SECRET_AFTER_DASH'],
		'option get',
		LOCKED('option get'),
		['SECRET_AFTER_DASH', '--exec']
	);
	refused(
		['option', 'get', '--', '--path=/etc/passwd'],
		'option get',
		LOCKED('option get'),
		['/etc/passwd']
	);
	refused(
		['--exec', 'SECRET_BEFORE_DASH', '--', 'option', 'get', 'siteurl'],
		'option get',
		LOCKED('option get'),
		['SECRET_BEFORE_DASH', 'siteurl', '--exec']
	);
	refused(
		['option', 'get', 'siteurl', '--path=/etc/passwd'],
		'option get',
		LOCKED('option get'),
		['/etc/passwd', 'siteurl']
	);
	refused(['cache', 'flush', '--no-exec'], 'cache flush', LOCKED('cache flush'), ['no-exec']);
});

test('command words are case-sensitive', () => {
	refused(['Option', 'get', 'siteurl'], 'Option', LOCKED('Option'), ['siteurl', 'get']);
	refused(['option', 'Get', 'siteurl'], 'option', LOCKED('option'), ['siteurl', 'Get']);
	refused(['OPTION', 'GET'], 'OPTION', LOCKED('OPTION'), ['GET']);
	refused(['Cache', 'flush'], 'Cache', LOCKED('Cache'), ['flush']);
	refused(['cron', 'event', 'run', '--Due-Now'], 'cron event run', LOCKED('cron event run'), ['Due-Now']);
	assert.deepEqual(decideWpCli(['option', 'get', 'SiteURL']), { allowed: true, command: 'option get' });
});

test('cron event run and transient delete keep their required bare flag', () => {
	refused(['cron', 'event', 'run'], 'cron event run', LOCKED('cron event run'), []);
	refused(['cron', 'event', 'run', 'secret_hook', '--due-now'], 'cron event run', LOCKED('cron event run'), ['secret_hook']);
	refused(['cron', 'event', 'run', '--due-now', '--all'], 'cron event run', LOCKED('cron event run'), ['--all']);
	refused(['cron', 'event', 'run', '--due-now=1'], 'cron event run', LOCKED('cron event run'), []);
	refused(['transient', 'delete'], 'transient delete', LOCKED('transient delete'), []);
	refused(['transient', 'delete', 'secret-key', '--expired'], 'transient delete', LOCKED('transient delete'), ['secret-key']);
	refused(['transient', 'delete', '--expired', '--all'], 'transient delete', LOCKED('transient delete'), ['--all']);
	refused(['transient', 'delete', '--expired=1'], 'transient delete', LOCKED('transient delete'), []);
	assert.deepEqual(
		decideWpCli(['cron', 'event', 'run', '--due-now', '--due-now']),
		{ allowed: true, command: 'cron event run' }
	);
});

test('empty input and a value that is not a plain array of strings are refused', () => {
	refused([], '', EMPTY, []);
	refused(['--'], '', EMPTY, []);
	const bad = [
		null,
		undefined,
		'option get siteurl',
		'option\nget',
		42,
		{ 0: 'option', 1: 'get', length: 2 },
		['option', 'get', 1],
		['option', null],
		['option', 'get', undefined],
	];
	for (const argv of bad) {
		const got = decideWpCli(argv);
		assert.deepEqual(got, { allowed: false, command: '', message: INVALID });
		const text = typeof argv === 'string' ? argv : '';
		if (text) assert.equal(got.message.includes(text), false);
	}
	class Args extends Array {}
	const sub = new Args('option', 'get', 'siteurl');
	assert.deepEqual(decideWpCli(sub), { allowed: false, command: '', message: INVALID });
	const extra = ['option', 'get', 'siteurl'];
	extra.note = 'secret-note';
	assert.deepEqual(decideWpCli(extra), { allowed: false, command: '', message: INVALID });
	assert.equal(decideWpCli(extra).message.includes('secret-note'), false);
	assert.equal(decideWpCli(extra).message.includes('siteurl'), false);
});

test('a short option and a broken flag are refused without echoing the token', () => {
	refused(['option', 'get', 'siteurl', '-e'], 'option get', LOCKED('option get'), ['siteurl', '-e']);
	assert.deepEqual(decideWpCli(['---']), { allowed: false, command: '', message: INVALID });
	assert.deepEqual(decideWpCli(['option', 'get', '--=secret']), { allowed: false, command: '', message: INVALID });
	assert.equal(decideWpCli(['option', 'get', '--=secret']).message.includes('secret'), false);
});

test('an option get with two keys is refused', () => {
	refused(['option', 'get', 'siteurl', 'blogname'], 'option get', LOCKED('option get'), ['siteurl', 'blogname']);
});

const SECRET_FIELDS = (command) => 'Refused `' + command + '`: the fields user_pass and user_activation_key are never printed. See issue #1258.';

test('user list and user get refuse user_pass and user_activation_key', () => {
	const secret = 'user-secret-value';
	const cases = [
		['user', 'list', '--field=user_pass'],
		['user', 'list', '--field=user_activation_key'],
		['user', 'list', '--fields=user_pass'],
		['user', 'list', '--fields=ID,user_pass,user_login'],
		['user', 'list', '--fields=ID,user_activation_key'],
		['user', 'list', '--fields=USER_PASS'],
		['user', 'get', '1', '--field=user_pass'],
		['user', 'get', '--fields=user_activation_key', secret],
		['user', 'list', '--', '--field=user_pass'],
		['user', 'list', '--format={{user_pass}}'],
		['user', 'get', '--format=%user_activation_key%'],
	];
	for (const argv of cases) {
		const command = argv[0] === 'user' && argv[1] === 'get' ? 'user get' : 'user list';
		refused(argv, command, SECRET_FIELDS(command), argv.includes(secret) ? [secret] : []);
	}
});

test('user list without those fields stays allowed, and option get stays allowed', () => {
	assert.deepEqual(decideWpCli(['user', 'list', '--fields=ID,user_login']), { allowed: true, command: 'user list' });
	assert.deepEqual(decideWpCli(['user', 'list', '--field=user_login']), { allowed: true, command: 'user list' });
	assert.deepEqual(decideWpCli(['user', 'list', '--format=json']), { allowed: true, command: 'user list' });
	assert.deepEqual(decideWpCli(['user', 'list', '--format=table']), { allowed: true, command: 'user list' });
	assert.deepEqual(decideWpCli(['option', 'get', 'user_pass']), { allowed: true, command: 'option get' });
	assert.deepEqual(decideWpCli(['option', 'get', 'siteurl', '--format=json']), { allowed: true, command: 'option get' });
});

test('user get without those fields stays refused as not on the list', () => {
	refused(['user', 'get', 'user-id-99'], 'user get', LOCKED('user get'), ['user-id-99']);
});
