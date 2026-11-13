// Which bundle files a request reads (#394, design docs/design-394-bundle-out-of-memory.md, step M0).
//
// The site bundle (site.zip, opcache.zip) is held in module memory for the life of the isolate.
// To fetch only what a request needs, the build must know which files each kind of request reads.
// This module is the instrument: the route class of a request (known from its method and URL
// before PHP runs), and a bounded recorder of the files read in each request. It changes no
// behavior. index.js records into it only when FILE_TRACE=on.

/**
 * The route class of a request, from the method and the URL only (PHP has not run yet).
 * Classes: admin:<script>, ajax:<action>, rest:<namespace>, login, cron, front.
 * "front" is every page that enters through index.php: home, shop, product, cart and checkout
 * cannot be told apart before WordPress resolves the query.
 */
export function routeClass(method, pathname, search) {
	const p = String(pathname || '/');
	const q = new URLSearchParams(String(search || ''));
	if (p === '/wp-admin/admin-ajax.php') return 'ajax:' + (safe(q.get('action') || '') || '(none)');
	const admin = /^\/wp-admin\/(?:([A-Za-z0-9_-]+)\.php)?$/.exec(p.endsWith('/wp-admin') ? p + '/' : p);
	if (admin) return 'admin:' + (admin[1] || 'index');
	if (p.startsWith('/wp-admin/')) return 'admin:other';
	if (p === '/wp-login.php') return 'login';
	if (p === '/wp-cron.php') return 'cron';
	let rest = null;
	if (q.has('rest_route')) rest = q.get('rest_route');
	else if (p.startsWith('/wp-json/')) rest = p.slice('/wp-json'.length);
	else if (p === '/wp-json') rest = '/';
	if (rest !== null) {
		const ns = String(rest).split('/').filter(Boolean).slice(0, 2).join('/');
		return 'rest:' + (safe(ns) || '(index)');
	}
	return 'front';
}

// A class name never carries anything a client typed beyond a short, plain token.
function safe(s) {
	return String(s).replace(/[^A-Za-z0-9_./-]/g, '').slice(0, 64);
}

/**
 * A recorder of file reads per request. begin() opens a request, read() notes one file the first
 * time it is read in that request, end() closes the request into the log. The log is bounded
 * (maxRequests), so a forgotten FILE_TRACE=on cannot grow without limit; drain() returns and
 * clears it.
 */
export function createTrace({ maxRequests = 500 } = {}) {
	let cur = null;
	let log = [];
	let dropped = 0;
	return {
		begin(info) {
			cur = { ...info, reads: new Map() };
		},
		read(src, path, bytes) {
			if (!cur) return;
			const k = src + ':' + path;
			if (!cur.reads.has(k)) cur.reads.set(k, bytes);
		},
		end(extra) {
			if (!cur) return null;
			const rec = { ...cur, ...extra, reads: [...cur.reads].map(([k, b]) => [k, b]) };
			cur = null;
			log.push(rec);
			if (log.length > maxRequests) {
				log.shift();
				dropped++;
			}
			return rec;
		},
		drain() {
			const out = { dropped, requests: log };
			log = [];
			dropped = 0;
			return out;
		},
		get open() {
			return cur !== null;
		},
	};
}
