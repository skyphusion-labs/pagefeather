// GD must not claim FreeType the lean libgd was built without (#590).
//   node engine/tools/gd-freetype-smoke.mjs <php_8_3.js> <php_8_3.wasm>
// Run from spikes/b2-wordpress after prepare.sh, on the lean engine (GD kept).
// Node 24 or later (JSPI). The pure check is gdFreetypeReportFails; the CLI boots PHP.
import { pathToFileURL } from 'node:url';

const NAMES = ['imagettftext', 'imagettfbbox', 'imagefttext', 'imageftbbox'];

// Reasons the report is not the lean contract. Empty means it holds.
export function gdFreetypeReportFails(report) {
	const reasons = [];
	if (report.gd !== true) reasons.push('gd extension is not loaded');
	if (report.freetype !== false) reasons.push('gd_info FreeType Support is ' + JSON.stringify(report.freetype));
	if (report.png !== true) reasons.push('gd_info PNG Support is ' + JSON.stringify(report.png));
	if (report.jpeg !== true) reasons.push('gd_info JPEG Support is ' + JSON.stringify(report.jpeg));
	for (const name of NAMES) {
		if (report[name] !== false) reasons.push('function_exists(' + name + ') is ' + JSON.stringify(report[name]));
	}
	return reasons;
}

export const GD_FREETYPE_PHP = `<?php
$info = function_exists('gd_info') ? gd_info() : array();
$out = array(
  'gd' => extension_loaded('gd'),
  'freetype' => array_key_exists('FreeType Support', $info) ? (bool) $info['FreeType Support'] : null,
  'linkage' => isset($info['FreeType Linkage']) ? $info['FreeType Linkage'] : null,
  'png' => array_key_exists('PNG Support', $info) ? (bool) $info['PNG Support'] : null,
  'jpeg' => array_key_exists('JPEG Support', $info) ? (bool) $info['JPEG Support'] : null,
);
foreach (array('imagettftext', 'imagettfbbox', 'imagefttext', 'imageftbbox') as $n) {
  $out[$n] = function_exists($n);
}
echo json_encode($out);
`;

export function parseGdReport(text) {
	const line = String(text).trim().split('\n').filter(Boolean).pop();
	let report;
	try { report = JSON.parse(line); } catch { throw new Error('PHP printed no JSON: ' + String(text).slice(0, 300)); }
	if (!report || typeof report !== 'object') throw new Error('PHP JSON was not an object');
	return report;
}

async function main() {
	const js = process.argv[2];
	const wasm = process.argv[3];
	if (!js || !wasm) {
		console.error('usage: node engine/tools/gd-freetype-smoke.mjs <php_8_3.js> <php_8_3.wasm>');
		process.exit(2);
	}
	const { boot, engine } = await import('../../spikes/b2-wordpress/tests/engine-contract.mjs');
	const e = engine('gd-freetype-smoke', js, wasm, {});
	const { php } = await boot(e);
	const text = (await php.run({ code: GD_FREETYPE_PHP })).text;
	const report = parseGdReport(text);
	const reasons = gdFreetypeReportFails(report);
	console.log('@event gd-freetype ' + JSON.stringify({ ok: reasons.length === 0, report, reasons }));
	if (reasons.length) {
		console.error('gd freetype smoke failed:');
		for (const r of reasons) console.error('  ' + r);
		process.exit(1);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((err) => { console.error(err); process.exit(1); });
}
