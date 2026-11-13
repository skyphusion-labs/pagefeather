// node --test spikes/b2-wordpress/tests/file-trace.test.mjs (#394 M0)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeClass, createTrace } from '../file-trace.mjs';

test('route classes from method and URL', () => {
	const cases = [
		['/', '', 'front'],
		['/product/hoodie/', '', 'front'],
		['/', '?post_type=product', 'front'],
		['/wp-admin/', '', 'admin:index'],
		['/wp-admin', '', 'admin:index'],
		['/wp-admin/index.php', '', 'admin:index'],
		['/wp-admin/post-new.php', '?post_type=page', 'admin:post-new'],
		['/wp-admin/profile.php', '', 'admin:profile'],
		['/wp-admin/network/sites.php', '', 'admin:other'],
		['/wp-admin/admin-ajax.php', '?action=heartbeat', 'ajax:heartbeat'],
		['/wp-admin/admin-ajax.php', '', 'ajax:(none)'],
		['/wp-login.php', '?action=lostpassword', 'login'],
		['/wp-cron.php', '', 'cron'],
		['/', '?rest_route=/wp/v2/pages', 'rest:wp/v2'],
		['/', '?rest_route=/wc/store/v1/cart', 'rest:wc/store'],
		['/wp-json/wp/v2/posts/5', '', 'rest:wp/v2'],
		['/wp-json', '', 'rest:(index)'],
		['/wp-json/', '', 'rest:(index)'],
	];
	for (const [p, s, want] of cases) assert.equal(routeClass('GET', p, s), want, p + s);
});

test('a class never carries client junk', () => {
	assert.equal(routeClass('GET', '/wp-admin/admin-ajax.php', '?action=<script>x'), 'ajax:scriptx');
	assert.equal(routeClass('GET', '/', '?rest_route=/a b/c%0d').startsWith('rest:'), true);
	assert.ok(routeClass('GET', '/wp-admin/admin-ajax.php', '?action=' + 'a'.repeat(500)).length <= 5 + 64);
});

test('trace records first read per request, bounded', () => {
	const t = createTrace({ maxRequests: 2 });
	t.read('site', '/x', 1); // outside a request: ignored
	t.begin({ cls: 'front', boot: 1 });
	t.read('site', '/a.php', 10);
	t.read('site', '/a.php', 10);
	t.read('opcache', '/a.php.bin', 20);
	const rec = t.end({ status: 200 });
	assert.deepEqual(rec.reads, [['site:/a.php', 10], ['opcache:/a.php.bin', 20]]);
	assert.equal(rec.status, 200);
	t.begin({ cls: 'b' }); t.end();
	t.begin({ cls: 'c' }); t.end();
	const d = t.drain();
	assert.equal(d.dropped, 1);
	assert.deepEqual(d.requests.map((r) => r.cls), ['b', 'c']);
	assert.deepEqual(t.drain(), { dropped: 0, requests: [] });
});
