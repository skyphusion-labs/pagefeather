// Who may use the site manager (#414). It fails CLOSED.
//
// The only proof of identity is ctx.access. Cloudflare sets it when Cloudflare
// Access authenticated the request that invoked this Worker, and leaves it
// undefined otherwise. A request header cannot set it, so a forged
// Cf-Access-Jwt-Assertion or Cf-Access-Authenticated-User-Email header proves
// nothing here and is never read.
// Source: https://developers.cloudflare.com/workers/configuration/cloudflare-access/
// (read 2026-11-13): "ctx.access is undefined if Access did not authenticate the request."
//
// On top of that, the signed-in email must equal ADMIN_EMAIL (the owner, set at
// deploy). With no ADMIN_EMAIL the manager refuses everyone. When ACCESS_AUD is set,
// the Access application's audience must match it too.
//
// Limits from the same page that shape this Worker: ctx.access is not passed to a
// Worker that has static assets (so the screens are served from code), and for a
// non-browser client only aud is filled (so a request with no email is refused).

export async function owner(env, ctx) {
  const want = typeof env.ADMIN_EMAIL === 'string' ? env.ADMIN_EMAIL.trim().toLowerCase() : '';
  if (!want) return { ok: false, status: 503, reason: 'not-configured' };
  const access = ctx && ctx.access;
  if (!access || typeof access.getIdentity !== 'function') return { ok: false, status: 403, reason: 'no-access' };
  if (typeof env.ACCESS_AUD === 'string' && env.ACCESS_AUD && access.aud !== env.ACCESS_AUD) {
    return { ok: false, status: 403, reason: 'wrong-audience' };
  }
  let identity;
  try { identity = await access.getIdentity(); } catch { return { ok: false, status: 403, reason: 'no-identity' }; }
  const email = identity && typeof identity.email === 'string' ? identity.email.trim().toLowerCase() : '';
  if (!email) return { ok: false, status: 403, reason: 'no-identity' };
  if (email !== want) return { ok: false, status: 403, reason: 'not-owner' };
  return { ok: true, email };
}

// A state-changing request must come from this page. A custom header cannot be
// sent cross-site without a CORS preflight, which this Worker never answers, and
// a browser Origin, when present, must be this Worker's own.
export function sameOriginWrite(request) {
  if (request.headers.get('x-pagefeather') !== '1') return false;
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) return false;
  const ct = request.headers.get('content-type') || '';
  return ct.split(';')[0].trim() === 'application/json';
}
