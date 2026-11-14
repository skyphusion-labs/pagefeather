// The site manager's screens (#414), in the wp-admin look of
// docs/design-401/admin-mockup.html. Plain HTML from code (not static assets:
// ctx.access is not passed to a Worker with static assets). Every dynamic value is
// escaped. The CSS and the one small script are served by this Worker from
// /admin.css and /admin.js, so the page needs no inline script or style
// (Content-Security-Policy allows 'self' only). No edge word on any screen.
import { RESERVED_NAMES, RESERVED_PREFIXES, DEMO_NAME_PREFIX, SITE_NAME_RE } from './vendor/provision/shared.mjs';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// The reserved-name rule the page checks BEFORE submit. It is the same data the
// server checks (validateRequest -> isCallerReservedName), passed to the page, so
// the two cannot drift. The server check stays the authority.
export function reservedRule() {
  return { names: [...RESERVED_NAMES].sort(), prefixes: [...RESERVED_PREFIXES, DEMO_NAME_PREFIX], pattern: SITE_NAME_RE.source };
}

const MENU = [
  ['/', 'Sites'], ['/add', 'Add New Site', true], ['/import', 'Import'], ['/databases', 'Databases'], ['/health', 'Site Health'],
];

export function page({ title, current, email, body }) {
  const menu = MENU.map(([href, label, sub]) => `<a${sub ? ' class="sub"' : ''}${href === current ? ' aria-current="page"' : ''} href="${href}">${esc(label)}</a>`).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} &lsaquo; Pagefeather</title>
<link rel="stylesheet" href="/admin.css">
<script src="/admin.js" defer></script>
</head>
<body>
<div class="adminbar"><b>Pagefeather</b><span>My Sites</span><span class="right">${email ? `Howdy, ${esc(email)}` : ''}</span></div>
<nav class="menu" aria-label="Main menu">${menu}</nav>
<main class="wrap">
${body}
</main>
</body>
</html>`;
}

export function refusedPage(reason) {
  const text = reason === 'not-configured'
    ? 'This site manager has no owner email set. Set ADMIN_EMAIL, then deploy it again.'
    : 'Sign in to open this site manager. Turn on sign-in protection for it in Cloudflare (Workers & Pages, select this site manager, then Access, then Protect this Worker behind Access), and sign in with the owner email.';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign in required &lsaquo; Pagefeather</title><link rel="stylesheet" href="/admin.css"></head>
<body class="refused"><div class="install"><h1>Sign in required</h1><p>${esc(text)}</p></div></body></html>`;
}

export function sitesScreen(sites) {
  const rows = sites.length ? sites.map((s) => `<tr><td><b>${esc(s.name)}</b><div class="row-actions"><a href="${esc(s.adminUrl)}">Log In</a> | <a href="https://${esc(s.hostname)}/">Visit</a> | <a href="/import">Import content</a></div></td><td>${esc(s.hostname)}</td><td class="hide-sm">${s.installed ? 'Ready' : 'Not installed'}${s.tier === 'a' ? ' (Hyperdrive store)' : ''}</td></tr>`).join('')
    : '<tr><td colspan="3">No sites yet. <a href="/add">Add your first site</a>.</td></tr>';
  return `<h1>Sites <a class="page-title-action" href="/add">Add New Site</a></h1>
<table class="list"><thead><tr><th>Name</th><th>Address</th><th class="hide-sm">Status</th></tr></thead><tbody>${rows}</tbody></table>
<div class="notice notice-warning"><p>Email from these sites is off until you connect a domain.</p></div>
<div class="notice"><p>New plugins and themes cannot be added from a site's own admin yet. Each site comes with its plugins and themes.</p></div>`;
}

export function addScreen({ subdomain, databases = [] }) {
  const rule = esc(JSON.stringify(reservedRule()));
  const dbOptions = databases.map((d) => `<option value="${esc(d.id)}">${esc(d.name || d.id)}${d.host ? ` (${esc(d.host)})` : ''}</option>`).join('');
  return `<h1>Add New Site</h1>
<p>Make a new WordPress site. It is ready in about a minute.</p>
<div id="error" class="notice notice-error" hidden><p></p></div>
<form id="add-site" data-subdomain="${esc(subdomain || '')}" data-rule="${rule}">
<table class="form-table" role="presentation">
<tr><th><label for="name">Site name</label></th>
<td><input id="name" name="name" type="text" autocomplete="off" spellcheck="false" maxlength="30" required>
<p class="description">Lower case letters, numbers and hyphens. 1 to 30 characters.</p>
<p id="name-warning" class="description warning" role="alert" hidden></p></td></tr>
<tr><th>Site address</th><td><code id="address">https://wp-&hellip;${subdomain ? '.' + esc(subdomain) : ''}.workers.dev</code><p class="description">Use your own domain: coming later.</p></td></tr>
<tr><th>Store</th><td><label><input id="store" name="store" type="checkbox"> This site is a store (WooCommerce)</label></td></tr>
<tr id="row-busy" hidden><th>Busy times</th><td><fieldset><legend class="screen-reader-text">At your busiest, how many people check out at the same moment?</legend>
<p>At your busiest, how many people check out at the same moment?</p>
<label><input type="radio" name="busy" value="few" checked> 1 to 5</label><br>
<label><input type="radio" name="busy" value="more"> More than 5</label><br>
<label><input type="radio" name="busy" value="unknown"> I do not know</label></fieldset>
<p id="busy-advice" class="description"></p></td></tr>
<tr id="row-tier" hidden><th>Store type</th><td><fieldset><legend class="screen-reader-text">Store type</legend>
<label><input type="radio" name="tier" value="wp" checked> Standard store</label>
<p class="description">Everything is in Cloudflare. Nothing else to set up. Good for most stores.</p>
<label><input type="radio" name="tier" value="a"> Hyperdrive store</label>
<p class="description">Uses your own MySQL database, through Cloudflare Hyperdrive. For stores where many people check out at once.</p></fieldset></td></tr>
<tr id="row-db" hidden><th><label for="database">Database</label></th><td>${dbOptions
    ? `<select id="database" name="database">${dbOptions}</select><p class="description">The store's tables go in this database, under a prefix named for the site. We recommend a separate database for each store. If the database already holds a WordPress site under that prefix, the store is not made.</p>`
    : '<p>No database is connected yet. <a href="/databases">Connect a database</a>, then come back here.</p>'}</td></tr>
</table>
<p><button id="submit" class="button button-primary button-hero" type="submit" disabled>Add New Site</button></p>
</form>
<div id="creating" class="card" hidden><h2>Creating your site</h2><p>This can take a minute. Please do not leave this page.</p>
<ul class="steps"><li>Making storage</li><li>Copying WordPress</li><li>Installing WordPress</li><li id="step-woo" hidden>Turning on WooCommerce</li></ul></div>
<div id="success" class="install" hidden><h1>Success!</h1><p>WordPress has been installed. Thank you, and enjoy!</p>
<table class="form-table" role="presentation"><tr><th>Username</th><td id="s-user"></td></tr>
<tr><th>Password</th><td><code id="s-pass"></code><p class="description"><b>Important:</b> Copy this password now. It is shown only once.</p></td></tr>
<tr><th>Address</th><td id="s-url"></td></tr></table>
<p id="s-note" class="description" hidden></p>
<p><a id="s-login" class="button button-primary button-hero" href="#">Log In</a></p></div>`;
}

// Databases for the Hyperdrive store (#431). The owner makes the Hyperdrive
// configuration in Cloudflare, where Cloudflare takes the database password, and
// pastes only its ID here. This page never asks for a password.
export function databasesScreen(databases) {
  const rows = databases.length ? databases.map((d) => `<tr><td><b>${esc(d.name || d.id)}</b><div class="row-actions"><a href="#" class="db-remove" data-id="${esc(d.id)}">Disconnect</a></div></td><td>${esc(d.host)}${d.database ? ` / ${esc(d.database)}` : ''}</td><td class="hide-sm">${esc(d.provider === 'azure' ? 'Azure Database for MySQL' : 'Another MySQL 8')}</td></tr>`).join('')
    : '<tr><td colspan="3">No databases yet.</td></tr>';
  return `<h1>Databases</h1>
<p>A Hyperdrive store keeps its data in your own MySQL database. Connect the database here once. Then choose it when you add a store.</p>
<div id="db-error" class="notice notice-error" hidden><p></p></div>
<table class="list"><thead><tr><th>Name</th><th>Server</th><th class="hide-sm">Where it runs</th></tr></thead><tbody>${rows}</tbody></table>
<div class="card"><h2>Connect a database</h2>
<ol>
<li>Make a MySQL 8 database. We recommend <b>Azure Database for MySQL</b> (Flexible Server), with <b>a separate database for each store</b> (one server can hold many databases). On Azure, set the server parameter <code>sql_mode</code> to <code>ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION</code>, and keep SSL on.</li>
<li>In Cloudflare, go to <b>Storage &amp; databases &gt; Hyperdrive</b>. Select <b>Create configuration</b>. Enter the database's server name, port, database name, user and password. Cloudflare keeps the password. This site manager never sees it.</li>
<li>Turn <b>caching off</b> for the configuration. With caching on, a store can show old prices and stock.</li>
<li>Copy the configuration's ID. Paste it below.</li>
</ol>
<form id="db-connect"><table class="form-table" role="presentation">
<tr><th><label for="hyperdrive-id">Hyperdrive configuration ID</label></th><td><input id="hyperdrive-id" name="hyperdriveId" type="text" autocomplete="off" spellcheck="false" maxlength="32" required><p class="description">32 letters and numbers. This is not a password.</p></td></tr>
<tr><th>Where the database runs</th><td><fieldset><legend class="screen-reader-text">Where the database runs</legend>
<label><input type="radio" name="provider" value="azure" checked> Azure Database for MySQL (recommended)</label><br>
<label><input type="radio" name="provider" value="mysql"> Another MySQL 8</label></fieldset></td></tr>
</table>
<p><button id="db-submit" class="button button-primary" type="submit">Connect database</button></p></form></div>`;
}

export function importScreen() {
  return `<h1>Import</h1>
<div class="card"><h2>Move content from another WordPress site</h2><ol>
<li>On your old site, go to <b>Tools &gt; Export</b>. Choose <b>All content</b>. Select <b>Download Export File</b>.</li>
<li>Log in to your new site. Go to <b>Tools &gt; Import &gt; WordPress</b>. Select <b>Run Importer</b>.</li>
<li>Upload the file. Choose <b>Download and import file attachments</b>. Keep your old site online until the import ends, so the images can be copied.</li></ol></div>
<div class="card"><h2>What comes across</h2><p>Posts, pages, comments, menus, categories, tags and images.</p>
<h2>What does not come across</h2><p>Your theme, your plugins, your settings and your users' passwords. Authors are added, and they set a new password.</p></div>`;
}

const CHECK_TEXT = {
  key: ['The key works', 'The site manager can make sites in your Cloudflare account.', 'Make the key: in Cloudflare, create an account API token with the permissions in the setup guide, then set it as PAGEFEATHER_KEY.'],
  platforms: ['Workers for Platforms is on', 'Your sites run on this Cloudflare plan. It costs $25 a month, billed by Cloudflare to your own account.', 'Turn on Workers for Platforms in Cloudflare (Workers for Platforms, then Purchase). Then come back here.'],
  subdomain: ['Your site addresses are ready', 'New sites get an address under your workers.dev name.', 'Choose your workers.dev name in Cloudflare (Workers & Pages, then Your subdomain).'],
  files: ['WordPress files are ready', 'The WordPress files for your sites are in place and checked.', 'Get the WordPress files for your sites. This is done once, and checked before it is used.'],
  hyperdrive: ['The key can read Hyperdrive (optional)', 'You can connect a database for a Hyperdrive store.', 'Only for a Hyperdrive store. Add the Hyperdrive Read permission to the key in Cloudflare (Manage Account, Account API Tokens, edit the key).'],
  filesA: ['Hyperdrive store files are ready (optional)', 'The files for Hyperdrive stores are in place and checked.', 'Only for a Hyperdrive store. Set A_BUNDLE_MANIFEST_SHA256 for this release, deploy again, then select Get WordPress files.'],
};

export function healthScreen(checks) {
  const items = checks.map((c) => {
    const [title, okText, todoText] = CHECK_TEXT[c.id] || [c.id, '', ''];
    const action = c.id === 'files' && !c.ok ? '<p><button id="get-files" class="button" type="button">Get WordPress files</button></p><p id="files-result" class="description" hidden></p>' : '';
    const badge = c.ok ? 'ok' : (c.optional ? 'optional' : 'todo');
    return `<li><span class="badge ${badge}">${c.ok ? 'Done' : (c.optional ? 'Optional' : 'To do')}</span><div><b>${esc(title)}</b><p>${esc(c.ok ? okText : todoText)}</p>${c.ok || !c.detail ? '' : `<p class="description">${esc(c.detail)}</p>`}${action}</div></li>`;
  }).join('');
  const all = checks.every((c) => c.ok || c.optional);
  return `<h1>Site Health</h1>
<div class="notice${all ? ' notice-success' : ''}"><p>${all ? 'Everything is ready. You can add sites.' : 'Finish these steps once. Then you can add sites.'}</p></div>
<ul class="health">${items}</ul>`;
}

export const CSS = `:root{--bar:#1d2327;--menu:#1d2327;--menu-text:#f0f0f1;--menu-hover:#2c3338;--current:#2271b1;--page:#f0f0f1;--card:#fff;--line:#c3c4c7;--text:#1d2327;--muted:#50575e;--link:#2271b1;--ok:#00a32a;--warn:#dba617;--bad:#d63638}
*{box-sizing:border-box}html,body{margin:0}
body{background:var(--page);color:var(--text);font:13px/1.4em -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Oxygen-Sans,Ubuntu,Cantarell,"Helvetica Neue",sans-serif}
a{color:var(--link)}
.adminbar{position:fixed;top:0;left:0;right:0;height:32px;background:var(--bar);color:var(--menu-text);display:flex;align-items:center;padding:0 12px;gap:16px;z-index:2}
.adminbar b{font-weight:600}.adminbar .right{margin-left:auto}
.menu{position:fixed;top:32px;bottom:0;left:0;width:160px;background:var(--menu);padding-top:12px}
.menu a{display:block;color:var(--menu-text);text-decoration:none;padding:8px 12px;font-size:14px}
.menu a:hover{background:var(--menu-hover);color:#72aee6}.menu a[aria-current=page]{background:var(--current);color:#fff}
.menu a.sub{padding-left:24px;font-size:13px}
.wrap{margin-left:160px;padding:52px 20px 40px;max-width:1100px}
h1{font-size:23px;font-weight:400;margin:0 0 16px}
h1 .page-title-action{margin-left:8px;font-size:13px;padding:4px 8px;border:1px solid var(--link);border-radius:3px;text-decoration:none;vertical-align:middle}
.notice{background:var(--card);border-left:4px solid var(--current);box-shadow:0 1px 1px rgba(0,0,0,.04);padding:1px 12px;margin:16px 0}
.notice-warning{border-left-color:var(--warn)}.notice-success{border-left-color:var(--ok)}.notice-error{border-left-color:var(--bad)}
.card{background:var(--card);border:1px solid var(--line);padding:16px 20px;margin-bottom:16px}
.button{display:inline-block;padding:0 10px;min-height:30px;line-height:28px;border:1px solid var(--link);border-radius:3px;background:#f6f7f7;color:var(--link);text-decoration:none;font-size:13px;cursor:pointer;font-family:inherit}
.button-primary{background:var(--current);color:#fff}.button[disabled]{opacity:.5;cursor:default}
.button-hero{min-height:46px;line-height:44px;padding:0 36px;font-size:14px}
table.form-table{border-collapse:collapse;width:100%}
.form-table th{text-align:left;vertical-align:top;width:200px;padding:20px 10px 20px 0;font-weight:600}
.form-table td{padding:15px 10px}
.form-table input[type=text]{width:25em;max-width:100%;padding:0 8px;min-height:30px;border:1px solid #8c8f94;border-radius:4px}
.description{color:var(--muted);margin:4px 0 0}.warning{color:var(--bad)}
table.list{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line)}
.list th,.list td{text-align:left;padding:8px 10px;border-bottom:1px solid #f0f0f1}
.list thead th{border-bottom:1px solid var(--line);font-weight:400}
.list .row-actions{font-size:12px;color:var(--muted);padding-top:2px}
.health{list-style:none;margin:0;padding:0}
.health li{background:var(--card);border:1px solid var(--line);margin-bottom:-1px;padding:12px 16px;display:flex;gap:12px;align-items:flex-start}
.badge{flex:none;width:76px;text-align:center;font-size:12px;padding:2px 0;border-radius:3px;color:#fff}
.badge.ok{background:var(--ok)}.badge.todo{background:var(--bad)}.badge.optional{background:var(--muted)}
fieldset{border:0;margin:0;padding:0}.screen-reader-text{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
.form-table select{min-height:30px;max-width:100%}
.health p{margin:4px 0 8px}
.steps{list-style:none;padding:0}.steps li{padding:4px 0}.steps li::before{content:"\\2026  ";color:var(--muted)}
.install{max-width:620px;margin:0 auto;background:var(--card);border:1px solid var(--line);padding:24px 32px}
.refused .install{margin-top:80px}
[hidden]{display:none!important}
@media (max-width:782px){.menu{position:static;width:auto;display:flex;flex-wrap:wrap;padding:44px 8px 4px}.menu a.sub{padding-left:12px}.wrap{margin-left:0;padding:16px}.form-table th,.form-table td{display:block;width:auto;padding:8px 0}.list .hide-sm{display:none}}
`;

// The one script. It checks the name before submit (format and reserved names),
// shows the address as you type, posts the form, and shows the result. No library.
export const JS = `(function () {
  'use strict';
  function nameProblem(name, rule) {
    if (!name) return '';
    if (!new RegExp(rule.pattern).test(name)) return 'Use only lower case letters, numbers and hyphens, 1 to 30 characters, with no hyphen at the start or end.';
    if (rule.names.indexOf(name) !== -1) return '"' + name + '" is reserved. Pick another name.';
    for (var i = 0; i < rule.prefixes.length; i++) {
      if (name.indexOf(rule.prefixes[i]) === 0) return 'A name cannot start with "' + rule.prefixes[i] + '". Pick another name.';
    }
    return '';
  }
  window.pagefeatherNameProblem = nameProblem;
  function post(url, body) {
    return fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-pagefeather': '1' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status }; }); });
  }
  var form = document.getElementById('add-site');
  if (form) {
    var rule = JSON.parse(form.getAttribute('data-rule'));
    var sub = form.getAttribute('data-subdomain');
    var input = document.getElementById('name');
    var warn = document.getElementById('name-warning');
    var addr = document.getElementById('address');
    var submit = document.getElementById('submit');
    var err = document.getElementById('error');
    var check = function () {
      var name = input.value.trim().toLowerCase();
      if (input.value !== name) input.value = name;
      var p = nameProblem(name, rule);
      warn.textContent = p; warn.hidden = !p;
      submit.disabled = !name || !!p;
      addr.textContent = 'https://wp-' + (name || '\\u2026') + (sub ? '.' + sub : '') + '.workers.dev';
    };
    input.addEventListener('input', check);
    check();
    var storeBox = document.getElementById('store');
    var radio = function (n) { var c = form.querySelector('input[name=' + n + ']:checked'); return c ? c.value : ''; };
    var advice = document.getElementById('busy-advice');
    var storeRows = function () {
      var on = storeBox.checked;
      document.getElementById('row-busy').hidden = !on;
      document.getElementById('row-tier').hidden = !on;
      var busy = radio('busy');
      advice.textContent = busy === 'more' ? 'We recommend the Hyperdrive store. With more than 5 at once, a standard store gets slow at checkout.'
        : busy === 'unknown' ? 'Start with a standard store. If checkout gets slow at busy times, move to a Hyperdrive store.'
        : 'A standard store is right for this.';
      var t = form.querySelector('input[name=tier][value=' + (busy === 'more' ? 'a' : 'wp') + ']');
      if (t && !form.getAttribute('data-tier-chosen')) t.checked = true;
      document.getElementById('row-db').hidden = !(on && radio('tier') === 'a');
    };
    storeBox.addEventListener('change', storeRows);
    Array.prototype.forEach.call(form.querySelectorAll('input[name=busy]'), function (b) { b.addEventListener('change', storeRows); });
    Array.prototype.forEach.call(form.querySelectorAll('input[name=tier]'), function (b) { b.addEventListener('change', function () { form.setAttribute('data-tier-chosen', '1'); storeRows(); }); });
    storeRows();
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var name = input.value.trim();
      if (nameProblem(name, rule)) { check(); return; }
      var store = document.getElementById('store').checked;
      var tier = store ? radio('tier') : 'wp';
      var dbSel = document.getElementById('database');
      var database = tier === 'a' && dbSel ? dbSel.value : '';
      if (tier === 'a' && !database) {
        err.querySelector('p').textContent = 'Connect a database first (Databases).';
        err.hidden = false; return;
      }
      err.hidden = true;
      form.hidden = true;
      document.getElementById('step-woo').hidden = !store;
      document.getElementById('creating').hidden = false;
      post('/api/sites', tier === 'a' ? { name: name, store: true, tier: 'a', database: database } : { name: name, store: store }).then(function (r) {
        document.getElementById('creating').hidden = true;
        if (!r || !r.ok) {
          err.querySelector('p').textContent = (r && r.error) || 'The site was not made.';
          err.hidden = false; form.hidden = false; check(); return;
        }
        document.getElementById('s-user').textContent = r.user || 'admin';
        document.getElementById('s-pass').textContent = r.password || '(set earlier; this site already existed)';
        document.getElementById('s-url').textContent = r.url;
        document.getElementById('s-login').setAttribute('href', r.loginUrl);
        var note = [];
        if (r.note) note.push(r.note);
        if (r.store && r.woo && !r.woo.activated) note.push('WooCommerce did not turn on. Turn it on in Plugins.');
        if (note.length) { var n = document.getElementById('s-note'); n.textContent = note.join(' '); n.hidden = false; }
        document.getElementById('success').hidden = false;
      }, function () {
        document.getElementById('creating').hidden = true;
        err.querySelector('p').textContent = 'The site manager did not answer. Check Sites before you try again.';
        err.hidden = false; form.hidden = false; check();
      });
    });
  }
  var dbForm = document.getElementById('db-connect');
  var dbErr = document.getElementById('db-error');
  var dbFail = function (text) { dbErr.querySelector('p').textContent = text; dbErr.hidden = false; };
  if (dbForm) {
    dbForm.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var id = document.getElementById('hyperdrive-id').value.trim().toLowerCase();
      var prov = dbForm.querySelector('input[name=provider]:checked');
      if (!/^[0-9a-f]{32}$/.test(id)) { dbFail('That is not a Hyperdrive configuration ID. Copy the ID (32 letters and numbers) from Cloudflare.'); return; }
      dbErr.hidden = true;
      var btn = document.getElementById('db-submit'); btn.disabled = true;
      post('/api/databases', { hyperdriveId: id, provider: prov ? prov.value : 'azure' }).then(function (r) {
        if (r && r.ok) { window.location.reload(); return; }
        btn.disabled = false; dbFail((r && r.error) || 'The database was not connected.');
      }, function () { btn.disabled = false; dbFail('The site manager did not answer.'); });
    });
  }
  if (document.querySelectorAll) Array.prototype.forEach.call(document.querySelectorAll('.db-remove'), function (a) {
    a.addEventListener('click', function (ev) {
      ev.preventDefault();
      post('/api/databases/remove', { id: a.getAttribute('data-id') }).then(function (r) {
        if (r && r.ok) { window.location.reload(); return; }
        dbFail((r && r.error) || 'The database was not disconnected.');
      }, function () { dbFail('The site manager did not answer.'); });
    });
  });
  var files = document.getElementById('get-files');
  if (files) {
    files.addEventListener('click', function () {
      files.disabled = true;
      var out = document.getElementById('files-result');
      out.hidden = false; out.textContent = 'Getting the WordPress files. This can take a minute.';
      post('/api/bundle', {}).then(function (r) {
        out.textContent = r && r.ok ? 'Done. The WordPress files are ready.' : ((r && r.error) || 'It did not work.');
        if (!(r && r.ok)) files.disabled = false;
      });
    });
  }
})();
`;
