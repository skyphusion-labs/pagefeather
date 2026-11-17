// OPcache shared memory for a runtime (#610). Measured on #610 (lean engine, local, one run per size, the empty-OPcache
// compile path): on the WooCommerce sample store 48 MB is full after the storefront alone (810 scripts on the file-cache
// fallback), and 64 MB lowers the peak heap 113 to 110 MiB with 196 fallbacks. On plain WordPress 48 MB holds every
// script with 20 MB spare, and 64 MB would cost 14 MiB of peak for nothing (75 to 89 MiB). The shared memory is
// reserved inside the wasm memory whether it is used or not, so the size follows the site: a STORE gets 64 (the deploy
// paths render OPCACHE_MC = "64" when the build primes WooCommerce), every other site 48. Exactly "64" is accepted;
// anything else is 48, never an unmeasured size. An explicit PHP_INI opcache.memory_consumption still wins (index.js
// spreads PHP_INI last).
export function opcacheMemoryMib(env) {
	return env && env.OPCACHE_MC === '64' ? '64' : '48';
}
