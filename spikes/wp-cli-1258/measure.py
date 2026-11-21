#!/usr/bin/env python3
"""Local spike for issue 1258. Run wp-cli.phar in the local pagefeather PHP runtime.

No deploy. No Cloudflare account. Product code is not edited.
The harness injects runner.php and the phar into the local site zip, measures,
then restores the zip.
"""

import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
B2 = os.path.join(ROOT, 'spikes', 'b2-wordpress')
CACHE = os.path.join(HERE, 'cache')
OUT = os.path.join(HERE, 'out')
STATE = os.path.join(HERE, 'state')
PHAR_URL = 'https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar'
SHA_URL = 'https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar.sha512'
TOKEN = 'local-spike-token'
PASSWORD = 'local-spike-password'
SHAPES = ('dosql-local', 'a-shape-local')
CMDS = ('option-get', 'user-list', 'cache-flush', 'cron-list', 'plugin-install')
ZIP_NAMES = ('wordpress/pf-wpcli-1258.php', 'wordpress/wp-cli.phar')


def run(cmd, cwd, env=None, timeout=600, check=True):
	print('+ ' + ' '.join(cmd), flush=True)
	return subprocess.run(cmd, cwd=cwd, env=env, timeout=timeout, check=check)


def download(url, dest):
	print('get ' + url, flush=True)
	req = urllib.request.Request(url, headers={'User-Agent': 'pagefeather-wpcli-1258'})
	with urllib.request.urlopen(req, timeout=120) as resp:
		data = resp.read()
	os.makedirs(os.path.dirname(dest), exist_ok=True)
	with open(dest, 'wb') as fh:
		fh.write(data)
	return data


def sha512_file(path):
	h = hashlib.sha512()
	with open(path, 'rb') as fh:
		for chunk in iter(lambda: fh.read(1024 * 1024), b''):
			h.update(chunk)
	return h.hexdigest()


def fetch_phar():
	os.makedirs(CACHE, exist_ok=True)
	phar = os.path.join(CACHE, 'wp-cli.phar')
	sig = os.path.join(CACHE, 'wp-cli.phar.sha512')
	download(PHAR_URL, phar)
	download(SHA_URL, sig)
	text = open(sig, 'r', encoding='utf-8', errors='replace').read().strip()
	published = text.split()[0].lower()
	got = sha512_file(phar)
	if got != published:
		raise SystemExit('sha512 mismatch: got %s published %s' % (got, published))
	print('sha512 ok ' + got, flush=True)
	return phar, published, text


def ensure_tree():
	lock = os.path.join(B2, 'package-lock.json')
	modules = os.path.join(B2, 'node_modules', '@php-wasm', 'universal')
	if not os.path.isdir(modules):
		run(['npm', 'ci'], B2, timeout=900)
	wasm = os.path.join(B2, 'vendor', 'php_8_3.wasm')
	if not os.path.isfile(wasm):
		run(['./prepare.sh'], B2, timeout=900)
	site = os.path.join(B2, 'build', 'site.zip')
	if not os.path.isfile(site):
		run(['./build.sh'], B2, timeout=900)
	return site


def inject(site_zip, phar):
	bak = site_zip + '.pf1258.bak'
	if not os.path.isfile(bak):
		shutil.copy2(site_zip, bak)
	tmp = site_zip + '.pf1258.tmp'
	drop = set(ZIP_NAMES)
	with zipfile.ZipFile(site_zip, 'r') as zin, zipfile.ZipFile(tmp, 'w') as zout:
		for info in zin.infolist():
			name = info.filename.replace('\\', '/')
			if name in drop:
				continue
			zout.writestr(info, zin.read(info.filename))
		zout.write(os.path.join(HERE, 'runner.php'), ZIP_NAMES[0], compress_type=zipfile.ZIP_DEFLATED)
		zout.write(phar, ZIP_NAMES[1], compress_type=zipfile.ZIP_DEFLATED)
	os.replace(tmp, site_zip)


def restore(site_zip):
	bak = site_zip + '.pf1258.bak'
	if os.path.isfile(bak):
		os.replace(bak, site_zip)


def header_map(path):
	out = {}
	if not os.path.isfile(path):
		return out
	for line in open(path, 'r', encoding='utf-8', errors='replace'):
		if ':' not in line:
			continue
		name, value = line.split(':', 1)
		out[name.strip().lower()] = value.strip()
	return out


def parse_body(path):
	raw = open(path, 'rb').read() if os.path.isfile(path) else b''
	text = raw.decode('utf-8', 'replace')
	marker = text.rfind('PF1258_JSON\n')
	parsed = None
	if marker >= 0:
		blob = text[marker + len('PF1258_JSON\n'):].strip()
		try:
			parsed = json.loads(blob)
		except ValueError as exc:
			parsed = {'parse_error': str(exc), 'tail': blob[:1500]}
	return text, parsed


def curl(port, path, perf_id, timeout, dest_body, dest_hdr):
	url = 'http://127.0.0.1:%s%s' % (port, path)
	cmd = [
		'curl', '-sS', '-D', dest_hdr, '-o', dest_body, '-m', str(timeout),
		'-H', 'x-spike-token: ' + TOKEN,
		'-H', 'x-mem-ledger: 1',
		'-H', 'x-perf-id: ' + perf_id,
		'-w', '%{time_total}',
		url,
	]
	t0 = time.time()
	proc = subprocess.run(cmd, capture_output=True, timeout=timeout + 30)
	wall = time.time() - t0
	headers = header_map(dest_hdr)
	body, parsed = parse_body(dest_body)
	perf = None
	if 'x-perf' in headers:
		try:
			perf = json.loads(headers['x-perf'])
		except ValueError:
			perf = {'_raw_len': len(headers['x-perf'])}
	return {
		'url': url,
		'curl_exit': proc.returncode,
		'curl_time_s': proc.stdout.decode('utf-8', 'replace').strip(),
		'wall_s': round(wall, 3),
		'status': headers.get(':status') or headers.get('http/1.1', ''),
		'status_line': open(dest_hdr, 'r', encoding='utf-8', errors='replace').readline().strip() if os.path.isfile(dest_hdr) else '',
		'x_wasm_mib': headers.get('x-wasm-mib'),
		'x_php_ms': headers.get('x-php-ms'),
		'x_boot': headers.get('x-boot'),
		'x_runtime_recycled': headers.get('x-runtime-recycled'),
		'x_db': headers.get('x-db'),
		'x_object_deadline': headers.get('x-object-deadline'),
		'wasm0': perf.get('wasm0MiB') if isinstance(perf, dict) else None,
		'wasm1': perf.get('wasm1MiB') if isinstance(perf, dict) else None,
		'ledger_wasm': (perf.get('mem') or {}).get('wasmMiB') if isinstance(perf, dict) else None,
		'body_head': body[:1200],
		'json': parsed,
		'curl_err': proc.stderr.decode('utf-8', 'replace')[-500:],
	}


def port_of():
	path = os.path.join(B2, '.dev-port')
	return open(path, 'r', encoding='utf-8').read().strip()


def start_shape(shape):
	persist = os.path.join(STATE, shape)
	if os.path.isdir(persist):
		shutil.rmtree(persist)
	os.makedirs(persist, exist_ok=True)
	env = os.environ.copy()
	env['DEV_ENV'] = shape
	env['DEV_LOCAL'] = '1'
	env['DEV_LOG_LEVEL'] = 'warn'
	env['DEV_WAIT_S'] = '300'
	env['PERSIST_TO'] = persist
	env['SPIKE_TOKEN'] = TOKEN
	env['ADMIN_PASSWORD'] = PASSWORD
	log = os.path.join(OUT, shape + '-start.log')
	print('start ' + shape, flush=True)
	with open(log, 'w', encoding='utf-8') as fh:
		proc = subprocess.run(['./run.sh', '_ping'], cwd=B2, env=env, timeout=420, stdout=fh, stderr=subprocess.STDOUT)
	tail = open(log, 'r', encoding='utf-8', errors='replace').read()[-2000:]
	if proc.returncode != 0:
		return {'ok': False, 'exit': proc.returncode, 'log_tail': tail}
	return {'ok': True, 'port': port_of(), 'log_tail': tail[-400:]}


def snapshot_devlog(shape, tag):
	src = os.path.join(B2, 'dev.log')
	if os.path.isfile(src):
		shutil.copy2(src, os.path.join(OUT, '%s-%s.dev.log' % (shape, tag)))


def stop_shape():
	env = os.environ.copy()
	env['SPIKE_TOKEN'] = TOKEN
	subprocess.run(['./run.sh', '--stop'], cwd=B2, env=env, timeout=60)


def install(port, shape):
	body = os.path.join(OUT, shape + '-install.body')
	hdr = os.path.join(OUT, shape + '-install.hdr')
	cmd = [
		'curl', '-sS', '-D', hdr, '-o', body, '-m', '300',
		'-X', 'POST',
		'-H', 'x-spike-token: ' + TOKEN,
		'-H', 'x-admin-password: ' + PASSWORD,
		'-H', 'x-admin-email: wpcli-1258@example.com',
		'-w', '%{time_total}',
		'http://127.0.0.1:%s/_install' % port,
	]
	t0 = time.time()
	proc = subprocess.run(cmd, capture_output=True, timeout=360)
	text = open(body, 'r', encoding='utf-8', errors='replace').read() if os.path.isfile(body) else ''
	return {
		'curl_exit': proc.returncode,
		'curl_time_s': proc.stdout.decode('utf-8', 'replace').strip(),
		'wall_s': round(time.time() - t0, 3),
		'status_line': open(hdr, 'r', encoding='utf-8', errors='replace').readline().strip() if os.path.isfile(hdr) else '',
		'x_wasm_mib': header_map(hdr).get('x-wasm-mib'),
		'body_tail': text[-1500:],
		'curl_err': proc.stderr.decode('utf-8', 'replace')[-400:],
	}


def measure_shape(shape):
	started = start_shape(shape)
	if not started.get('ok'):
		return {'shape': shape, 'boot': started, 'rows': []}
	port = started['port']
	try:
		inst = install(port, shape)
		home = curl(port, '/?nocache=1', shape + '-home', 180, os.path.join(OUT, shape + '-home.body'), os.path.join(OUT, shape + '-home.hdr'))
		probe = curl(port, '/pf-wpcli-1258.php?mode=probe&nocache=1', shape + '-probe', 120, os.path.join(OUT, shape + '-probe.body'), os.path.join(OUT, shape + '-probe.hdr'))
		rows = []
		for cmd in CMDS:
			path = '/pf-wpcli-1258.php?mode=phar&cmd=%s&nocache=1' % cmd
			row = curl(port, path, shape + '-phar-' + cmd, 60, os.path.join(OUT, shape + '-phar-' + cmd + '.body'), os.path.join(OUT, shape + '-phar-' + cmd + '.hdr'))
			row['cmd'] = cmd
			row['entry'] = 'phar'
			rows.append(row)
		# Inner entry: load wp-cli.php after the SAPI check. option get is tried
		# with and without a STDOUT polyfill. user list is last: it calls
		# proc_open, the spawn handler throws, and the request can hang.
		inner_plan = [('option-get', '0')] + [(cmd, '1') for cmd in ('option-get', 'cache-flush', 'cron-list', 'plugin-install', 'user-list')]
		for cmd, poly in inner_plan:
			tag = 'inner-raw' if poly == '0' else 'inner-' + cmd
			path = '/pf-wpcli-1258.php?mode=inner&cmd=%s&polyfill=%s&nocache=1' % (cmd, poly)
			row = curl(port, path, shape + '-' + tag, 40, os.path.join(OUT, shape + '-' + tag + '.body'), os.path.join(OUT, shape + '-' + tag + '.hdr'))
			row['cmd'] = cmd
			row['entry'] = 'inner'
			row['polyfill'] = poly
			rows.append(row)
			snapshot_devlog(shape, tag)
			finished = row.get('json') is not None or 'PF1258_JSON' in (row.get('body_head') or '')
			if cmd != 'user-list' and not finished:
				# No PHP result: the request hung or the runtime was shed. Start clean.
				stop_shape()
				started = start_shape(shape)
				if not started.get('ok'):
					rows.append({'cmd': 'restart', 'boot': started})
					break
				port = started['port']
				install(port, shape)
		return {'shape': shape, 'boot': {'ok': True, 'port': port}, 'install': inst, 'home': home, 'probe': probe, 'rows': rows}
	finally:
		stop_shape()


def main():
	os.makedirs(OUT, exist_ok=True)
	phar, digest, sig_text = fetch_phar()
	site = ensure_tree()
	engine_out = os.path.join(OUT, 'engine.json')
	print('engine probe', flush=True)
	proc = subprocess.run(
		['node', os.path.join(HERE, 'probe-engine.mjs'), phar, engine_out],
		cwd=HERE, timeout=180,
	)
	if proc.returncode != 0:
		print('engine probe exit %s' % proc.returncode, flush=True)
	inject(site, phar)
	shapes = []
	try:
		for shape in SHAPES:
			print('measure ' + shape, flush=True)
			try:
				shapes.append(measure_shape(shape))
			except Exception as exc:
				shapes.append({'shape': shape, 'error': str(exc)})
				try:
					stop_shape()
				except Exception:
					pass
	finally:
		restore(site)
	summary = {
		'phar_url': PHAR_URL,
		'sha512_url': SHA_URL,
		'sha512': digest,
		'sha512_file': sig_text,
		'shapes': shapes,
		'engine_probe_exit': proc.returncode,
	}
	dest = os.path.join(OUT, 'results.json')
	with open(dest, 'w', encoding='utf-8') as fh:
		json.dump(summary, fh, indent=2)
		fh.write('\n')
	print('wrote ' + dest, flush=True)
	return 0


if __name__ == '__main__':
	sys.exit(main())
