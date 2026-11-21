// #1195: $_SERVER['PHP_SELF'] as stock front controllers set it.
//
// php-wasm's PHPRequestHandler builds PHP_SELF from the requested URL. When a path has no file, our handler's
// file-not-found action redirects internally to /index.php: SCRIPT_NAME becomes /index.php, but PHP_SELF stays the
// requested path (/cart/x/y/z). Apache (mod_rewrite to index.php) and nginx (try_files ... /index.php) give
// PHP_SELF = SCRIPT_NAME . PATH_INFO, here /index.php.
//
// WordPress depends on it. WP::parse_request clears its 404 when the requested path equals PHP_SELF ("a request for
// ourself"). So with a structure whose rules match nothing for a path (/%postname%/ and a missing page), core ran the
// home query instead of a 404, canonical redirected it to a trailing slash (301), and the next request served the
// home page with 200: a soft 404 on every unknown path, where stock answers 404.
//
// One runtime serves the object and approach A's Worker; runStream is where php-wasm hands PHP the $_SERVER it built,
// as in php-auth.mjs. A request without SCRIPT_NAME is left exactly as it came.

const INSTALLED = Symbol.for('skyphusion.phpSelf');

/** The request with PHP_SELF = SCRIPT_NAME . PATH_INFO; the same object when there is nothing to change. */
export function applyPhpSelf(request) {
	const server = request && request.$_SERVER;
	if (!server || typeof server.SCRIPT_NAME !== 'string') return request;
	const self = server.SCRIPT_NAME + (typeof server.PATH_INFO === 'string' ? server.PATH_INFO : '');
	if (server.PHP_SELF === self) return request;
	return { ...request, $_SERVER: { ...server, PHP_SELF: self } };
}

export function installPhpSelf(php) {
	if (!php || typeof php !== 'object' || typeof php.runStream !== 'function' || php[INSTALLED]) return php;
	const orig = php.runStream;
	php.runStream = function (request) {
		return orig.call(this, applyPhpSelf(request));
	};
	php[INSTALLED] = true;
	return php;
}
