// #650: OBJECT_CACHE_VERSIONS=on (#643, #296 (2)) is refused unless the site's Hyperdrive config does NOT cache
// queries. The feature keeps options and transients across isolates under exact versions read once per request
// from MySQL. A Hyperdrive config with caching on answers a repeated SELECT from its own cache (up to max_age,
// default 60 s, blind to writes), so a request could read an OLD version, ask for the old keys and be served old
// values: the #491 stale read the versions exist to prevent. Read from the Cloudflare API at provision time.
// Fail closed: a failed read, a missing field or any value but caching.disabled === true refuses. The message
// names the config id, never the token.
import { cfFetch } from './cf.mjs';

export function cachingDisabled(config) {
	return !!(config && config.caching && config.caching.disabled === true);
}

// The flag, as aVars renders it (a plain_text binding).
export function versionsFlagOn(bindings) {
	return (bindings || []).some((b) => b && b.type === 'plain_text' && b.name === 'OBJECT_CACHE_VERSIONS' && b.text === 'on');
}

// ctx { acct, token, fetchImpl? }. Returns { checked: false } with the flag off (no read), { checked: true } when
// the config is read and does not cache. Throws otherwise.
export async function versionsGate(ctx, { hyperdriveId, flagOn }) {
	if (!flagOn) return { checked: false };
	if (!hyperdriveId) throw new Error('#650: OBJECT_CACHE_VERSIONS=on needs the site Hyperdrive config id, to check that it does not cache queries');
	const r = await cfFetch(ctx.token, 'GET', `/accounts/${ctx.acct}/hyperdrive/configs/${encodeURIComponent(hyperdriveId)}`, { fetchImpl: ctx.fetchImpl });
	if (!r.ok || !r.result) {
		const codes = (r.errors || []).map((e) => e && e.code).filter(Boolean).join(',');
		throw new Error(`#650: could not read Hyperdrive config ${hyperdriveId} (HTTP ${r.status}${codes ? ', codes ' + codes : ''}); OBJECT_CACHE_VERSIONS=on is refused (fail closed)`);
	}
	if (!cachingDisabled(r.result)) {
		throw new Error(`#650: Hyperdrive config ${hyperdriveId} caches queries (caching.disabled is not true); OBJECT_CACHE_VERSIONS=on would read stale versions. Disable its caching, or leave the flag off`);
	}
	return { checked: true };
}
