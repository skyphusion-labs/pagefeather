// The resolve hook for the lean client tests (#1101). Tests only.
// - cloudflare:sockets -> a stub (Node cannot resolve it);
// - ./mysql-lean.js imported by a bridge loaded with ?fake -> a fake LeanMysql the test drives;
// - spikes/b2-wordpress/*.js are ES modules (wrangler bundles them so; that directory has no "type": "module").
export async function resolve(specifier, context, next) {
	if (specifier === 'cloudflare:sockets') return { url: new URL('./fake-cf-sockets.mjs', import.meta.url).href, shortCircuit: true, format: 'module' };
	if (specifier === './mysql-lean.js' && context.parentURL && context.parentURL.includes('mysql-lean-bridge.js?fake')) {
		return { url: new URL('./fake-lean.mjs', import.meta.url).href, shortCircuit: true, format: 'module' };
	}
	const r = await next(specifier, context);
	if (/\/spikes\/b2-wordpress\/[^/]+\.js(\?|$)/.test(r.url)) return { ...r, format: 'module' };
	return r;
}
