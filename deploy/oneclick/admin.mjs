// The site manager's request handler (#414). worker.mjs is the Worker entry; it
// passes the dispatcher source in. Tests call handle() with stubs.
//
// Order of every request: the two static files (no data in them), then the owner
// check (auth.mjs), which fails CLOSED, then the route. Nothing that reads or
// changes the account runs before the owner check.
import { owner, sameOriginWrite } from './auth.mjs';
import { addSite, siteList, health, context, workersSubdomain, connectDatabase, disconnectDatabase, databaseList } from './sites.mjs';
import { installBundle } from './bundle.mjs';
import { shown } from './errors.mjs';
import { page, refusedPage, sitesScreen, addScreen, importScreen, healthScreen, databasesScreen, CSS, JS, esc } from './ui.mjs';

const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};
const html = (body, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS } });
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...SECURITY_HEADERS } });
const asset = (body, type) => new Response(body, { headers: { 'content-type': type, ...SECURITY_HEADERS, 'cache-control': 'public, max-age=300' } });

export async function handle(request, env, ctx, { fetchImpl = fetch, dispatcherSource } = {}) {
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === '/admin.css') return asset(CSS, 'text/css; charset=utf-8');
  if (request.method === 'GET' && url.pathname === '/admin.js') return asset(JS, 'text/javascript; charset=utf-8');

  const who = await owner(env, ctx);
  if (!who.ok) {
    if (url.pathname.startsWith('/api/')) return json({ ok: false, error: 'sign in required' }, who.status);
    return html(refusedPage(who.reason), who.status);
  }

  try {
    if (request.method === 'POST' && url.pathname.startsWith('/api/')) {
      if (!sameOriginWrite(request)) return json({ ok: false, error: 'refused: not from this page' }, 403);
      let body;
      try { body = await request.json(); } catch { return json({ ok: false, error: 'body is not JSON' }, 400); }
      if (url.pathname === '/api/sites') {
        if (typeof dispatcherSource !== 'string' || !dispatcherSource) throw new Error('the site front door code is missing');
        return json(await addSite(env, { body, fetchImpl, dispatcherSource }));
      }
      if (url.pathname === '/api/bundle') return json(await installBundle(env, { fetchImpl }));
      if (url.pathname === '/api/databases') return json(await connectDatabase(env, { body, fetchImpl }));
      if (url.pathname === '/api/databases/remove') return json(await disconnectDatabase(env, { body, fetchImpl }));
      return json({ ok: false, error: 'not found' }, 404);
    }
    if (request.method !== 'GET') return json({ ok: false, error: 'method not allowed' }, 405);
    const view = (title, current, body) => html(page({ title, current, email: who.email, body }));
    if (url.pathname === '/') return view('Sites', '/', sitesScreen(await siteList(env, { fetchImpl })));
    if (url.pathname === '/add') {
      let subdomain = '';
      try { subdomain = await workersSubdomain(await context(env, fetchImpl)); } catch { subdomain = ''; }
      let databases = [];
      try { databases = await databaseList(env, { fetchImpl }); } catch { databases = []; }
      return view('Add New Site', '/add', addScreen({ subdomain, databases }));
    }
    if (url.pathname === '/databases') return view('Databases', '/databases', databasesScreen(await databaseList(env, { fetchImpl })));
    if (url.pathname === '/import') return view('Import', '/import', importScreen());
    if (url.pathname === '/health') return view('Site Health', '/health', healthScreen(await health(env, { fetchImpl })));
    return html(page({ title: 'Not found', current: '', email: who.email, body: '<h1>Not found</h1>' }), 404);
  } catch (e) {
    // Only a BadRequest's own text is shown; anything else is a reference (errors.mjs).
    const { status, message } = shown(e, `${request.method} ${url.pathname}`);
    if (url.pathname.startsWith('/api/')) return json({ ok: false, error: message }, status);
    return html(page({ title: 'Error', current: '', email: who.email, body: `<h1>Something went wrong</h1><div class="notice notice-error"><p>${esc(message)}</p></div><p><a href="/health">Open Site Health</a></p>` }), status);
  }
}
