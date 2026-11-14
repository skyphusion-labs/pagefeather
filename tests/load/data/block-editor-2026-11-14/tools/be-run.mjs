// sb1114e block editor round (pagefeather #394). One client, sequential, headless Chromium.
// Env: PLATFORMS="hwp,pf" ; per platform <P>_B, <P>_USER, <P>_PASS (values never logged),
// optional PF_SPIKE_TOKEN (added only to same-origin requests of the pf site, for x-perf).
// ITER (10), OUT (dir). Writes requests.csv, steps.csv, setup.json. Headers only, never bodies.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const ITER = Number(process.env.ITER || 10);
const OUT = process.env.OUT || '.';
const PLATFORMS = (process.env.PLATFORMS || 'hwp,pf').split(',');
const TAG = 'sb1114e-be';
const KEEP = ['x-perf', 'x-hostlesswp', 'x-hostlesswp-cache', 'x-isolate-reset', 'x-isolate-retry', 'x-write-loss', 'x-runtime-recycled', 'x-wasm-mib', 'x-boot', 'cf-ray'];
const LOAD_MS = 120000, SAVE_MS = 90000;
fs.mkdirSync(OUT, { recursive: true });
const csvq = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v));
function csv(file, cols) {
  const f = path.join(OUT, file);
  // Create with the header atomically ('wx'); a file that already exists keeps its rows (no check-then-write race).
  try { fs.writeFileSync(f, cols.join(',') + '\n', { flag: 'wx' }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  return (row) => fs.appendFileSync(f, cols.map((c) => csvq(row[c])).join(',') + '\n');
}
const REQ_COLS = ['platform', 'iter', 'step', 't_utc', 'method', 'kind', 'path', 'rest_route', 'query_keys', 'status', 'ms', 'failure', ...KEEP.map((k) => k.replace(/-/g, '_'))];
const STEP_COLS = ['platform', 'iter', 'step', 't_utc', 'ok', 'ms', 'verified', 'fail_reason', 'editor_error', 'failing_call', 'retry_ok', 'php_calls', 'php_5xx', 'aborted'];
const wreq = csv('requests.csv', REQ_COLS);
const wstep = csv('steps.csv', STEP_COLS);
const wev = csv('events.csv', ['platform', 'iter', 'step', 't_utc', 'kind', 'text']);

function kindOf(u, rtype) {
  const p = u.pathname;
  if (p.startsWith('/wp-json/') || u.searchParams.has('rest_route')) return 'rest';
  if (p.endsWith('/admin-ajax.php')) return 'ajax';
  if (rtype === 'document' || p.endsWith('.php') || p.endsWith('/')) return 'html';
  return 'static';
}
// Path only; query VALUES dropped (nonces), rest_route kept without its numbers.
function scrub(u) {
  const rr = u.pathname.startsWith('/wp-json/') ? u.pathname.slice(8) : u.searchParams.get('rest_route') || '';
  return { path: u.pathname.startsWith('/wp-json/') ? '/wp-json' : u.pathname, rest_route: rr.replace(/\/\d+/g, '/<id>'), query_keys: [...u.searchParams.keys()].filter((k) => k !== 'rest_route').sort().join(' ') };
}

async function platformRun(browser, P) {
  const B = process.env[P.toUpperCase() + '_B'].replace(/\/$/, '');
  const origin = new URL(B).origin;
  const token = P === 'pf' ? process.env.PF_SPIKE_TOKEN || '' : '';
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  // Same route handler on both platforms, so interception cost is equal; the token header is pf-only, same-origin only.
  await ctx.route((url) => url.origin === origin, (route) => route.continue(token ? { headers: { ...route.request().headers(), 'x-spike-token': token } } : {}));
  const page = await ctx.newPage();
  const cur = { iter: 'setup', step: 'login', calls: [] };
  const started = new Map();
  page.on('request', (r) => started.set(r, Date.now()));
  const done = async (r, failure) => {
    const u = new URL(r.url());
    if (!/^https?:$/.test(u.protocol) || u.origin !== origin) return;
    const resp = failure ? null : await r.response().catch(() => null);
    const h = resp ? await resp.allHeaders().catch(() => ({})) : {};
    const row = { platform: P, iter: cur.iter, step: cur.step, t_utc: new Date(started.get(r) || Date.now()).toISOString(), method: r.method(), kind: kindOf(u, r.resourceType()), ...scrub(u), status: resp ? resp.status() : 'NO-ANSWER', ms: Date.now() - (started.get(r) || Date.now()), failure: failure || '' };
    for (const k of KEEP) if (h[k]) row[k.replace(/-/g, '_')] = String(h[k]).slice(0, 300);
    started.delete(r);
    wreq(row);
    if (row.kind !== 'static') cur.calls.push(row);
  };
  const scrubText = (t) => String(t).split(origin).join('<origin>').replace(/https?:\/\/[^\s"')]+/g, (u) => { try { return new URL(u).pathname; } catch { return '<url>'; } }).replace(/_wpnonce=[^&\s]+/g, '_wpnonce=<x>').slice(0, 240);
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') wev({ platform: P, iter: cur.iter, step: cur.step, t_utc: new Date().toISOString(), kind: 'console-' + m.type(), text: scrubText(m.text()) }); });
  page.on('pageerror', (e) => wev({ platform: P, iter: cur.iter, step: cur.step, t_utc: new Date().toISOString(), kind: 'pageerror', text: scrubText(e.message) }));
  page.on('requestfinished', (r) => done(r));
  page.on('requestfailed', (r) => done(r, (r.failure() || {}).errorText || 'failed'));

  const canvas = () => page.frameLocator('iframe[name="editor-canvas"]');
  async function editorError() {
    const t = await page.locator('.components-snackbar, .components-notice.is-error, .editor-error-boundary, .wp-die-message').allInnerTexts().catch(() => []);
    const bad = t.filter((x) => /fail|not a valid JSON|error|offline|critical/i.test(x));
    if (bad.length) return bad.join(' | ').slice(0, 200);
    const body = (await page.locator('body').innerText().catch(() => '')).trim();
    return body.length < 20 ? 'WHITE-SCREEN' : '';
  }
  async function step(iter, name, fn) {
    cur.iter = iter; cur.step = name; cur.calls = [];
    const t0 = Date.now(); let ok = false, verified = '', reason = '';
    try { verified = (await fn()) ?? ''; ok = true; } catch (e) { reason = String(e.message || e).split('\n')[0].slice(0, 200); }
    const err = await editorError();
    const real = (c) => !(c.status === "NO-ANSWER" && /ERR_ABORTED/.test(c.failure));
    const bad = cur.calls.filter(real).find((c) => c.status === "NO-ANSWER" || c.status >= 500) || cur.calls.find((c) => c.status >= 400 && c.kind !== 'static');
    const php = cur.calls.filter((c) => c.kind !== 'static');
    const row = { platform: P, iter, step: name, t_utc: new Date(t0).toISOString(), ok: ok ? 1 : 0, ms: Date.now() - t0, verified, fail_reason: reason, editor_error: err, failing_call: bad ? `${bad.method} ${bad.path}${bad.rest_route ? ' ' + bad.rest_route : ''} ${bad.status}` : '', retry_ok: '', php_calls: php.length, php_5xx: php.filter(real).filter((c) => c.status === "NO-ANSWER" || c.status >= 500).length, aborted: php.length - php.filter(real).length };
    if (!ok) {
      // One user-style retry of the same step, recorded; the iteration still counts as failed.
      cur.step = name + ':retry'; cur.calls = [];
      try { await fn(); row.retry_ok = 1; } catch { row.retry_ok = 0; }
    }
    wstep(row);
    return ok || row.retry_ok === 1; // true: the user got past this step (first try or one reload); steps.csv keeps ok and retry_ok apart
  }
  async function openEditor(url) {
    await page.goto(B + url, { waitUntil: 'domcontentloaded', timeout: LOAD_MS });
    await page.locator('body.block-editor-page').waitFor({ timeout: LOAD_MS });
    await canvas().locator('.editor-post-title__input').waitFor({ state: 'visible', timeout: LOAD_MS });
    await page.waitForFunction(() => window.wp && wp.data && wp.data.select('core/editor').getCurrentPostId() && !wp.data.select('core/editor').isSavingPost(), null, { timeout: LOAD_MS });
    await closeModals();
  }
  // The welcome guide and the block theme's "Choose a pattern" modal (new pages) can open late; a person closes them.
  async function closeModals() {
    const ov = page.locator('.components-modal__screen-overlay');
    for (let i = 0; i < 10; i++) {
      if (await ov.count() && await ov.first().isVisible().catch(() => false)) { await page.keyboard.press('Escape'); await page.waitForTimeout(300); continue; }
      if (i >= 4) break; // seen clear for long enough (about 2 s)
      await page.waitForTimeout(500);
    }
  }
  const postId = () => page.evaluate(() => wp.data.select('core/editor').getCurrentPostId());
  async function waitSaved(re) {
    await page.locator('.components-snackbar', { hasText: re }).first().waitFor({ timeout: SAVE_MS });
    const e = await editorError(); if (e) throw new Error('editor error: ' + e);
  }
  async function readBack(id, type, marks, title) {
    const restBase = type === 'page' ? 'pages' : 'posts';
    const got = await page.evaluate(async ([rb, id]) => { const r = await wp.apiFetch({ path: `/wp/v2/${rb}/${id}?context=edit&_fields=title,content,status` }); return { t: r.title.raw, c: r.content.raw, s: r.status }; }, [restBase, id]);
    const dom = (await canvas().locator('.is-root-container').first().innerText()) + ' ' + (await canvas().locator('.editor-post-title__input').innerText());
    for (const m of [...marks, ...(title ? [title] : []), ...(process.env.FORCE_MISSING === "1" ? ["sb1114e-be-forced-missing"] : [])]) {
      if (!got.c.includes(m) && got.t !== m) throw new Error(`REST lacks ${m}`);
      if (!dom.includes(m)) throw new Error(`editor lacks ${m}`);
    }
    if (process.env.FORCE_MISSING === "dom" && !dom.includes("sb1114e-be-forced-missing")) throw new Error("editor lacks sb1114e-be-forced-missing");
    if (got.s !== 'publish') throw new Error('status ' + got.s);
    return 'rest+dom';
  }

  // Login, once. A failed setup skips the platform: no iteration runs blind.
  let setupOk = await step('setup', 'login', async () => {
    await page.goto(B + '/wp-login.php', { timeout: LOAD_MS });
    await page.fill('#user_login', process.env[P.toUpperCase() + '_USER']);
    await page.fill('#user_pass', process.env[P.toUpperCase() + '_PASS']);
    // A Turnstile widget on the form (pf394a: the test key) fills its token after a few seconds; a person waits for it too.
    if (await page.locator('[name="cf-turnstile-response"]').count()) {
      await page.waitForFunction(() => { const f = document.querySelector('[name="cf-turnstile-response"]'); return f && f.value; }, null, { timeout: 60000 });
    }
    await Promise.all([page.waitForURL(/wp-admin/, { timeout: LOAD_MS }), page.click('#wp-submit')]);
  });
  // Setup: block editor active, the existing post and page picked by one rule, their content snapshotted.
  const setup = {};
  const editorCheck = async () => {
    await openEditor('/wp-admin/post-new.php');
    const s = await page.evaluate(async () => {
      const plugins = await wp.apiFetch({ path: '/wp/v2/plugins?status=active&_fields=plugin' }).catch(() => null);
      const wcPages = ['woocommerce_shop_page_id', 'woocommerce_cart_page_id', 'woocommerce_checkout_page_id', 'woocommerce_myaccount_page_id'];
      const posts = await wp.apiFetch({ path: '/wp/v2/posts?status=publish&per_page=20&orderby=date&order=desc&context=edit&_fields=id,title,content' });
      const pages = await wp.apiFetch({ path: '/wp/v2/pages?status=publish&per_page=50&orderby=id&order=asc&context=edit&_fields=id,title,content,slug' });
      return { blockEditorBody: document.body.classList.contains('block-editor-page'), gutenberg: !!(wp.blocks && wp.blocks.getBlockTypes().length), blockTypes: wp.blocks.getBlockTypes().length, classicEditorActive: plugins ? plugins.some((p) => /classic-editor/.test(p.plugin)) : 'unreadable', activePlugins: plugins ? plugins.map((p) => p.plugin) : null, wpVersion: (document.body.className.match(/branch-(\d+-\d+)/) || [])[1] || null, wcPages,
        post: posts.find((p) => !p.title.raw.startsWith('sb1114e-be')), pages: pages.filter((p) => !p.title.raw.startsWith('sb1114e-be')).map((p) => ({ id: p.id, slug: p.slug, title: p.title.raw, content: p.content.raw })) };
    });
    const skip = new Set(['shop', 'cart', 'checkout', 'my-account']);
    const pg = s.pages.find((p) => !skip.has(p.slug));
    Object.assign(setup, s, { page: pg, pages: undefined });
    if (!s.blockEditorBody || !s.gutenberg || s.classicEditorActive === true) throw new Error('block editor not active');
    fs.writeFileSync(path.join(OUT, `setup-${P}.json`), JSON.stringify({ blockEditorBody: s.blockEditorBody, blockTypes: s.blockTypes, classicEditorActive: s.classicEditorActive, activePlugins: s.activePlugins, wpBranch: s.wpVersion, postId: s.post.id, postContentLen: s.post.content.raw.length, pageId: pg.id, pageSlug: pg.slug, pageContentLen: pg.content.length }, null, 1));
    fs.writeFileSync(path.join(OUT, `snapshot-${P}.json`), JSON.stringify({ post: { id: s.post.id, content: s.post.content.raw }, page: { id: pg.id, content: pg.content } }), { mode: 0o600 });
    return 'block-editor';
  };
  if (process.env.CLEANUP_ONLY === '1') setupOk = false; // cleanup reads the saved snapshot; nothing else runs
  else if (setupOk) { let ok = false; for (let a = 1; a <= 3 && !ok; a++) ok = await step('setup', a === 1 ? 'editor-check' : 'editor-check#' + a, editorCheck); setupOk = ok; }
  const created = [];
  const appended = { post: [], page: [] };
  return {
    created, setup, appended,
    setupOk: () => setupOk,
    async iteration(n) {
      if (!setupOk) return;
      for (const type of ['post', 'page']) {
        const S = (x) => `${type}-${x}`;
        const title = `${TAG}-${P}-${n}-${type}`, para = `${TAG}-${P}-${n}-${type} paragraph`, app = `${TAG}-${P}-${n}-${type} appended`;
        let id = null;
        const newUrl = type === 'page' ? '/wp-admin/post-new.php?post_type=page' : '/wp-admin/post-new.php';
        const chain = [
          [S('new-load'), () => openEditor(newUrl)],
          [S('new-type'), async () => { const t = canvas().locator('.editor-post-title__input'); await t.click(); await page.keyboard.type(title); await page.keyboard.press('Enter'); await page.keyboard.type(para); }],
          [S('publish'), async () => {
            await closeModals();
            if (!(await page.locator('.editor-post-publish-panel').isVisible().catch(() => false))) await page.locator('.editor-post-publish-panel__toggle').click(); // a retry may find the panel open
            await page.locator('.editor-post-publish-panel .editor-post-publish-button').click();
            await waitSaved(/published/i); id = await postId(); created.push({ type, id });
          }],
          [S('new-verify'), async () => { await openEditor(`/wp-admin/post.php?post=${id}&action=edit`); return readBack(id, type, [para], title); }],
          [S('edit-load'), () => openEditor(`/wp-admin/post.php?post=${setup[type].id}&action=edit`)],
          [S('edit-append'), async () => {
            const last = canvas().locator('.is-root-container > .wp-block').last();
            await last.click(); await page.keyboard.press('ControlOrMeta+Alt+y'); await page.keyboard.type(app);
            await closeModals();
            await page.locator('.editor-header .editor-post-publish-button, .edit-post-header .editor-post-publish-button').first().click();
            await waitSaved(/updated|saved/i); appended[type].push(app);
          }],
          [S('edit-verify'), async () => { await openEditor(`/wp-admin/post.php?post=${setup[type].id}&action=edit`); return readBack(setup[type].id, type, appended[type], null); }],
        ];
        for (const [name, fn] of chain) if (!(await step(n, name, fn))) break; // a step not passed even after one retry stops its chain; the other type still runs
      }
    },
    async cleanup() {
      cur.iter = 'cleanup';
      if (!fs.existsSync(path.join(OUT, `snapshot-${P}.json`))) { await ctx.close(); return; }
      for (let a = 1; a <= 3; a++) if (await step('cleanup', a === 1 ? 'delete-and-restore' : 'delete-and-restore#' + a, async () => {
        const snap = JSON.parse(fs.readFileSync(path.join(OUT, `snapshot-${P}.json`)));
        await page.goto(B + '/wp-admin/profile.php', { waitUntil: 'domcontentloaded', timeout: LOAD_MS });
        const r = await page.evaluate(async ([created, snap]) => {
          const nonce = (await (await fetch('/wp-admin/admin-ajax.php?action=rest-nonce', { credentials: 'same-origin' })).text()).trim();
          if (!/^[0-9a-f]{6,}$/.test(nonce)) throw new Error('no rest nonce');
          const wp = { apiFetch: async ({ path, method = 'GET', data }) => {
            const res = await fetch('/index.php?rest_route=' + encodeURIComponent(path.split('?')[0]) + (path.includes('?') ? '&' + path.split('?')[1] : ''), { method, credentials: 'same-origin', headers: { 'X-WP-Nonce': nonce, ...(data ? { 'content-type': 'application/json' } : {}) }, body: data ? JSON.stringify(data) : undefined });
            if (method === 'DELETE' && res.status === 404) { out.gone404 = (out.gone404 || 0) + 1; return {}; }
            if (!res.ok) throw new Error(method + ' ' + path.split('?')[0] + ' ' + res.status);
            return res.json();
          } };
          var out = { deleted: 0, restored: 0, revs: 0 };
          // Inventory first: what is there now (tagged items, and which of our markers sit in the existing two), names and ids only.
          out.inventory = { tagged: [], markersInExisting: {} };
          for (const t of ['posts', 'pages']) for (const st of ['publish', 'draft', 'auto-draft', 'trash']) {
            const l = await wp.apiFetch({ path: `/wp/v2/${t}?status=${st}&search=sb1114e-be&per_page=100&_fields=id,title,status&context=edit` }).catch(() => []);
            for (const p of l) if (p.title.raw.startsWith('sb1114e-be')) out.inventory.tagged.push({ type: t, id: p.id, status: p.status, title: p.title.raw });
          }
          for (const [t, sn] of [['posts', snap.post], ['pages', snap.page]]) {
            const cur = await wp.apiFetch({ path: `/wp/v2/${t}/${sn.id}?context=edit&_fields=content` });
            out.inventory.markersInExisting[t] = (cur.content.raw.match(/sb1114e-be-[a-z]+-\d+-[a-z]+ appended/g) || []);
          }
          for (const c of created) { await wp.apiFetch({ path: `/wp/v2/${c.type}s/${c.id}?force=true`, method: 'DELETE' }); out.deleted++; }
          for (const [t, s] of [['posts', snap.post], ['pages', snap.page]]) {
            const before = (await wp.apiFetch({ path: `/wp/v2/${t}/${s.id}/revisions?per_page=100&_fields=id,date_gmt` }));
            await wp.apiFetch({ path: `/wp/v2/${t}/${s.id}`, method: 'POST', data: { content: s.content } }); out.restored++;
            const after = await wp.apiFetch({ path: `/wp/v2/${t}/${s.id}?context=edit&_fields=content` });
            if (after.content.raw !== s.content) throw new Error('restore mismatch ' + t);
            out.revs += before.length;
          }
          // Our own leftover drafts and autosaves, by title tag.
          for (const t of ['posts', 'pages']) for (const st of ['publish', 'draft', 'auto-draft', 'trash']) {
            const l = await wp.apiFetch({ path: `/wp/v2/${t}?status=${st}&search=sb1114e-be&per_page=100&_fields=id,title&context=edit` }).catch(() => []);
            for (const p of l) if (p.title.raw.startsWith('sb1114e-be')) { await wp.apiFetch({ path: `/wp/v2/${t}/${p.id}?force=true`, method: 'DELETE' }); out.deleted++; }
          }
          return out;
        }, [created, snap]);
        fs.writeFileSync(path.join(OUT, `cleanup-${P}.json`), JSON.stringify(r, null, 1));
        return JSON.stringify({ deleted: r.deleted, restored: r.restored, revs: r.revs, gone404: r.gone404 || 0, tagged: r.inventory.tagged.length });
      })) break;
      await ctx.close();
    },
  };
}

const browser = await chromium.launch();
const runs = {};
for (const P of PLATFORMS) runs[P] = await platformRun(browser, P);
// Interleaved: iteration n on each platform, then n+1, so time of day and Azure load hit both alike.
for (let n = 1; n <= ITER; n++) for (const P of PLATFORMS) await runs[P].iteration(n);
if (process.env.CLEANUP !== '0') for (const P of PLATFORMS) await runs[P].cleanup();
await browser.close();
