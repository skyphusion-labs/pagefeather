#!/usr/bin/env node
// #759 / #605: measure block editor mount after seed (welcome guide dismissed). Not part of the suite gate.
//   BASE_URL=https://<site> WP_USERNAME=admin WP_PASSWORD=<pw> node tests/conformance/editor-probe.mjs
// Optional: EDITOR_PROBE_TIMEOUT_MS (default 30000), EDITOR_PROBE_NAV_TIMEOUT_MS (default 60000).
import { chromium } from 'playwright';

const base = ( process.env.BASE_URL || process.env.WP_BASE_URL || '' ).replace( /\/+$/, '' );
const user = process.env.WP_USERNAME || process.env.ADMIN_USER || 'admin';
const pass = process.env.WP_PASSWORD || process.env.ADMIN_PASSWORD || '';
const budget = Number( process.env.EDITOR_PROBE_TIMEOUT_MS || 30000 );
const navBudget = Number( process.env.EDITOR_PROBE_NAV_TIMEOUT_MS || 60000 );

function die( msg ) {
	console.error( 'editor-probe: ' + msg );
	process.exit( 2 );
}

if ( ! base.startsWith( 'https://' ) ) die( 'BASE_URL must be https' );
if ( ! pass ) die( 'WP_PASSWORD is not set' );

const out = { base, budget_ms: budget, nav_timeout_ms: navBudget };

( async () => {
	const browser = await chromium.launch();
	const ctx = await browser.newContext();
	const page = await ctx.newPage();
	const t0 = Date.now();
	await page.goto( base + '/wp-login.php', { waitUntil: 'domcontentloaded', timeout: navBudget } );
	await page.fill( '#user_login', user );
	await page.fill( '#user_pass', pass );
	await page.click( '#wp-submit' );
	await page.waitForURL( /\/wp-admin\//, { timeout: navBudget } );
	const nav0 = Date.now();
	await page.goto( base + '/wp-admin/post-new.php', { waitUntil: 'domcontentloaded', timeout: navBudget } );
	const navMs = Date.now() - nav0;
	let canvasMs = null;
	let selector = null;
	try {
		const el = await page.waitForSelector( '#editor, .edit-post-layout', { timeout: budget } );
		canvasMs = Date.now() - nav0;
		selector = await el.evaluate( ( n ) => n.id || n.className );
	} catch ( e ) {
		canvasMs = null;
	}
	out.nav_ms = navMs;
	out.canvas_ms = canvasMs;
	out.canvas_within_budget = canvasMs !== null && canvasMs <= budget;
	out.selector = selector;
	out.total_ms = Date.now() - t0;
	if ( process.env.EDITOR_PROBE_SCREENSHOT ) {
		await page.screenshot( { path: process.env.EDITOR_PROBE_SCREENSHOT, fullPage: true } );
		out.screenshot = process.env.EDITOR_PROBE_SCREENSHOT;
	}
	await browser.close();
	console.log( JSON.stringify( out ) );
	process.exit( out.canvas_within_budget ? 0 : 1 );
} )().catch( ( e ) => {
	die( e.message || String( e ) );
} );
