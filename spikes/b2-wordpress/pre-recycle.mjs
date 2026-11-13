// Recycle BEFORE a heavy admin request (#394, design on the issue, comment 6865462939).
//
// post-new.php ends at 117 to 121 MiB of WebAssembly memory whether its runtime starts warm (96 to
// 100 MiB) or from a fresh boot (24 MiB): that is its own working set. On a warm runtime of 90 MiB
// or more it died on isolate memory in 72 of 133 measured cases (pf394a, 2026-11-13); the ones
// that ran on a fresh boot in a fresh isolate did not. So when an admin page arrives and the runtime
// it would use is already at or above PRE_RECYCLE_MIB, index.js releases that runtime and boots a
// fresh one BEFORE PHP runs. Off unless the site sets PRE_RECYCLE_MIB (deploy/wfp lib.sh).
//
// Only a GET of an admin screen (/wp-admin/*.php): not admin-ajax, async-upload, admin-post (form
// posts and uploads that the screen itself started), not REST, not the front end. Those end near
// 97 MiB too, so they would pay a boot on every request.

import { routeClass } from './file-trace.mjs';

const MIB = 1048576;
// The line, from env.PRE_RECYCLE_MIB: an integer from 32 to 1024, or null (off). Anything else is
// off too (the render refuses it first; this keeps a hand-set bad value from doing harm).
export function preRecycleMib(env) {
	const v = env && env.PRE_RECYCLE_MIB;
	if (v === undefined || v === null || v === '') return null;
	const s = String(v);
	if (!/^[0-9]{2,4}$/.test(s)) return null;
	const n = Number(s);
	return n >= 32 && n <= 1024 ? n : null;
}

const NOT_SCREENS = new Set(['admin:async-upload', 'admin:admin-post', 'admin:other']);

// True when the request is an admin screen GET (the heavy class).
export function heavyAdminGet(method, pathname, search) {
	if (method !== 'GET') return false;
	const cls = routeClass(method, pathname, search);
	return cls.startsWith('admin:') && !NOT_SCREENS.has(cls);
}

// True when the runtime should be recycled before this request runs.
export function shouldPreRecycle({ lineMib, wasmBytes, method, pathname, search }) {
	if (!lineMib || !(wasmBytes >= 0)) return false;
	return wasmBytes >= lineMib * MIB && heavyAdminGet(method, pathname, search);
}
