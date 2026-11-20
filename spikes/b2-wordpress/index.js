// Spike B2: WordPress in a Worker, database on D1.
import { sqlImport } from './sql-import.js';
import { releaseReservedName, releaseReservedD1, tryReserveName, RESERVE_DDL, RESERVE_INSERT } from './r2-reserve.mjs';
import { sender, replyTo, deliverableRecipients, bindingAddress } from './mail-from.mjs';
import { collapsedSlashRedirect } from './slash-path.mjs';
import { emailQueueEnabled, emailBackoffDelay, chunkBatch, isDeadLetterQueue, handleQueuedEmail } from './email-queue.mjs';
import { boundedWait, TIMED_OUT } from './promise-bound.mjs';
import { httpHostAllowed, resolveHttpAllowHosts } from './http-allow.mjs';
import { installPhpBasicAuth } from './php-auth.mjs';
import { purgeZoneBody, cfPurgeEndpoint, cachePurgeEnabled, ownPurgeHost } from './purge-zone.mjs';
import { wpCronState, idleDecision, parseGmt, IDLE_KEY } from './cron-idle.mjs';
import { armBeforeRun, rearm, pullIn, extendIfOurs, recordAlarmFatal, ALARM_FATAL_KEY, snapshotRearm, setAlarmRecorded, ALARM_SET_KEY, emailRushDue, emailAlarmAt, EMAIL_DUE_KEY, EMAIL_RETRY_MS } from './alarm-arm.mjs';
import { classifyObjectError, objectErrorHeaders, fetchWithMemoryRetry, isResetKind, objectErrorOutcome } from './object-error.mjs';
import { askPurgeAfterAnswer } from './purge-after-php.mjs';
import { callPhpObject, isObjectCallDeadline, objectCallDeadlineMs, objectCallExempt } from './object-deadline.mjs';
import { startByMs, objectShedPlan, startByResponse, shedAnswer, startByExempt, tagCallId, recheckStartBy, disconnectAnswer, disconnectSignal, tickFetch, tickResponse, TICK_PATH, START_BY_HEADER, CALL_HEADER } from './start-by.mjs';
import { IMPORT_HOLD_KEY, IMPORT_HOLD_MS, cronHeld } from './import-hold.mjs';
import { MOVE_HOLD_KEY, moveHoldRequest } from './move-hold.mjs';
import { SNAPSHOT_PATH, snapshotGate, gateResponse, takeSnapshot } from './db-snapshot.mjs';
import { cronBounds, cronCleanDue, cronLegDue, cronAsBudgetMs, cronMore, cronBacklogNext, cronBacklogDue, cronBacklogGapMs, backlogStreak } from './cron-bound.mjs';
import { CRON_RUN_KEY, cronBackoff, cronRunStart, cronRunDone, cronRunDeferred, cronMarkOf, cronFatalOf } from './cron-health.mjs';
import { approachACronEnabled, approachACronScheduled, CRON_TICK_PATH, CRON_TICK_HEADER, CRON_OBJECT_NAME } from './a-cron.mjs';
import { isMediaUploadRequest, markerKey, sweepUploadOrphans, dropMarkersOn } from './upload-intent.mjs';
import { cronFailureLine } from './cron-error.mjs';
import { pdfInvoiceEnabled, renderOpPlan, invoiceKey, bytesToHex, signDownload, verifyDownload, invoiceDownloadPath, parseDownloadQuery } from './pdf-invoice.mjs';
import { turnstileEnabled, turnstileForms, sanitizeSiteKey, verifyToken, siteHost, TURNSTILE_ACTION, setResultHeader, takeResultHeader, turnstileRoute, readRouteFields, readGatedToken, encodeResult, TurnstileSlot, turnstileTimeoutMs, retryAfterFor } from './turnstile.mjs';
import { analyticsEnabled, recordPageview } from './analytics.mjs';
import { cfBridgeEnabled, aiEmbedOp, vectorizeOp } from './cf-bridge.mjs';
import { demoLocked, lockDefines } from './site-lock.mjs';
import { exportRequest } from './mysql-export.mjs';
import { perfHeadersAllowed, scrubPerfHeaders, isOperatorRequest, noStoreAnywhere, operatorNoStore, serverTimingPhp } from './perf-headers.mjs';
import * as pageVersions from './page-versions.mjs';
import { opcacheMemoryMib } from './opcache-size.mjs';
import { createTrace as createQueryTrace } from './qtrace.mjs';
import { asyncEmailDefine } from './async-email-wiring.mjs';
import { hposCacheDefine } from './woo-hpos-cache.mjs';
import { resetFailures, platformFailures, writeLossResponse, rolledBackResponse, frameProvesRollback, statementFailureResponse, wantsJson, heldRequestMail, sqlShape, readRefusal, refusedReadResponse } from './write-loss.mjs';
import { MEMORY_RESET } from './object-error.mjs';
import { createL2Writer } from './oc-l2-writer.mjs';
import { createLedger, memfsBytes, createSqlMeter, ledgerOn, LEDGER_MIB, currentSerial } from './mem-ledger.mjs';
import { recycleLine, recycleDecision } from './recycle-line.mjs';
import { OBJECT_CACHE_MAX_BYTES, nextObjectCacheCap } from './object-cache-cap.mjs';
import { PHP_ENGINE, ENGINE_RECYCLE_MIB } from './vendor/engine.mjs'; // #771: written by prepare.sh
import { createTickMail, DEDUPE_PREFIX } from './email-handoff.mjs';
import { failureRecords, drainRetries, DEAD_PREFIX, scrub } from './email-retry.mjs';
import { routeClass, createTrace } from './file-trace.mjs';
import { refuseSocketsDecorator, parseMessage } from './runtime-guards.mjs';
import wasmModule from './vendor/php_8_3.wasm';
import * as loader from './vendor/php_8_3.js';
import { loadPHPRuntime, PHP, PHPRequestHandler, setPhpIniEntries, __private__dont__use } from '@php-wasm/universal';
import { inflateSync } from 'fflate';
import { createArena } from './inflate-arena.mjs';
import { headroomStream } from './headroom.mjs';
import { faultArmed, isFaultTarget, exhaustMemory, sqlFailNeedle, sqlFailMessage, undoFailSet, UNDO_FAIL_MESSAGE, emailFaultRejects } from './fault-inject.mjs';
import { failuresSince } from './activate-report.mjs';
import { createUndoLog } from './undo-log.mjs';
import { createRetirer } from './runtime-drop.mjs';
import { gateSettings, decide, BootRefused, bootRefusedResponse, createGateClock, withBootRefusal } from './boot-gate.mjs'; // #598
import { reuseOn, createSpare, bootTestDelayMs, bootTestDelayAt, moduleImportsMemory, offerWhenDrained } from './memory-reuse.mjs'; // #598 / #603
import { createPhpLock, PHP_SHED, shedMsFor } from './php-lock.mjs';
import { withDbRun } from './db-lifecycle.mjs';
import { isVersionedKey, l1ExpFor } from './oc-l1.mjs';
import { aPerfLine } from './perf-line.mjs';
import { templateQueuePriority, templateLookupYield, templateLookupForwardYield } from './template-boot.mjs';
import * as cacheVersions from './cache-versions.mjs';
import { overflowSettings, shouldOverflow, createPicker, overflowName, objectBusy, overHeld, overflowCapResponse, overflowHeldBlocksLocal, overflowHeldBlockResponse } from './overflow.mjs';
import { stampRendered } from './page-stamp.mjs';
import { PRODUCT_PAGE_HEADER, productTtl, isProductPage, edgeCacheControl } from './page-cache-ttl.mjs';
import { PURGE_GAP_MS, NO_CACHE_API, purgeWindowMs, onAsk, onDue, onResult } from './purge-state.mjs';
import { budgetAcquire, budgetRefused } from './purge-budget-client.mjs';
import { Container, ContainerProxy, getContainer } from '@cloudflare/containers';
import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import siteZip from './build/site.zip';
// Compiled PHP (OPcache file cache) made by opcache.sh with this same PHP build.
import opcacheZip from './build/opcache.zip';
// #394 L1 (opcache-split.py): the BOOT part of the OPcache file cache is not a static module. It is
// fetched from the Assets binding when a runtime boots and dropped after that request. null when
// the build was not split (build.sh writes the default).
import OPCACHE_BOOT from './build/opcache-boot-index.js';
// #563 (#394 Gate 1, OPCACHE_REMOTE=1): ALL OPcache files in static-asset packs, fetched when PHP
// opens one (remote-packs.mjs, opcache-remote.py). No split and no boot pack. null on a default
// build (build.sh writes it): nothing changes then.
import OPCACHE_REMOTE from './build/opcache-remote-index.js';
// #569 (#394 Gate 2, SITE_REMOTE=1, on top of OPCACHE_REMOTE): site.zip in packs too (site-remote.py).
// null on a default build. There is NO runtime off switch: the bytes are not in the bundle, so the
// rollback is a deploy without SITE_REMOTE.
import SITE_REMOTE from './build/site-remote-index.js';
import { createRemotePacks, createFetchBudget, createSiteHooks, selfCheckCode, checkSelfCheck, REMOTE_FETCH_CAP, REMOTE_HOLD_BYTES, SITE_FETCH_CAP, SITE_HOLD_BYTES } from './remote-packs.mjs';
// The build id baked at build time (build.sh writes build/build-id.js), so the
// object can report which code version it runs (issue #35 slice 5).
import BUILD_ID from './build/build-id.js';

const OPCACHE_DIR = '/internal/shared/opcache';
// The scripts OPcache must never cache (#294): the eval file of php.run.
const OPCACHE_BLACKLIST = '/internal/shared/opcache-blacklist.txt';

const DOCROOT = '/wordpress';
// php-wasm's defaults keep OPcache on with a file cache in PHP's in-memory
// filesystem. That saves recompiling about 500 scripts per request (CPU), at
// the cost of JS memory. Override through PHP_INI.
const INI_DEFAULTS = {};
// WebAssembly memory never shrinks. Past the recycle line, boot a fresh runtime for the next request.
// OPcache shared memory (48 MB since #394) is part of it. Measured 2026-11-04 on Paid:
// 81 MiB after the first page with OPcache on. The line is recycle-line.mjs's: RECYCLE_WASM_MIB, default
// 100 MiB (#598). A bad value is logged once per isolate.
let recycleRefusedLogged = false;
let ENV;
// Approach A (index-a.js) registers a MySQL handler here. B leaves it null and
// every database message goes to D1.
let dbHandler = null;
// The WordPress table prefix of this site (php/wp-config.php reads WP_TABLE_PREFIX from PHP_ENV).
function tablePrefix(env) {
	try { const p = JSON.parse((env && env.PHP_ENV) || '{}').WP_TABLE_PREFIX; if (typeof p === 'string' && p) return p; } catch {}
	return 'wp_';
}
export function setDbHandler(h) {
	dbHandler = h;
}
// DB_IN_DO=on (issue #2, docs/approach-b.md 8j): the PHP object's own SQLite
// (ctx.storage.sql). The object sets it for each PHP run, under the PHP lock.
// In the Worker it is always null and every statement goes to D1.
let sqlDb = null;
// The object's storage, for transactionSync (real transactions, #60). Set with sqlDb.
let sqlStorage = null;
// #730 (#589 B): this object request asked for the post-INSERT fault (fault-inject.mjs: the site var, the spike
// token and x-pf-fault, all three). One shot: sqlStatement clears it when it fires; the run clears it at the end.
let faultPending = false;
let faultReq = null; // its x-pf-req, for the log line
let sqlFailAt = null; // #766: the piece of SQL whose first statement this request fails (fault-inject.mjs sqlFailNeedle)
let sqlFailMsg = ''; // #766: and the message it throws (sqlFailMessage)
const faultHeld = []; // the memory the kill holds, so nothing can be collected before the platform resets

// Object cache across requests (php/object-cache.php, docs/perf-dosql.md), in
// the PHP object with DB_IN_DO only: one object is the only writer, so
// WordPress's own deletes keep it exact. Least recently used goes first past
// OBJECT_CACHE_BYTES (values are base64 strings; their length is counted).
const OBJECT_CACHE_BYTES = OBJECT_CACHE_MAX_BYTES;
const objectCache = new Map(); // key -> { v, exp, n }
let objectCacheBytes = 0;
let objectCacheCap = OBJECT_CACHE_BYTES; // #963: a product admin request may lower this for one request
function objectCacheClear() {
	objectCache.clear();
	objectCacheBytes = 0;
}
// #766: the object-cache keys this request wrote (set or del), so a request that met a reset-class SQL failure can
// take them back. Such a request saw failed statements as empty results (a product query that found nothing), and the
// cache would otherwise hand that to every later request: a 404 for a product that exists. poisoned also stops the
// request's L2 sets that the undo log still holds (#352 defer), which run after the response.
let ocReq = null;
// #766: a failed READ statement (SELECT, WITH): PHP saw an empty result, whatever the error's class.
function readFailed(failures) { return (failures || []).some((f) => f && /^\s*(SELECT|WITH)\b/i.test(String(f.sql || ''))); }
function ocReqBegin() { ocReq = { writes: new Set(), poisoned: false }; objectCacheCap = OBJECT_CACHE_BYTES; }
function ocReqForget() {
	const r = ocReq;
	if (!r) return { n: 0, groups: {} };
	r.poisoned = true;
	const l2 = ocL2On();
	const groups = {};
	for (const k of r.writes) {
		objectCacheDrop(k);
		const g = ocGroupOf(k).slice(-40);
		groups[g] = (groups[g] || 0) + 1;
		if (l2 && ocCtx) { try { ocCtx.waitUntil(ocL2Writer().del(ocKvKey(k))); } catch {} }
	}
	return { n: r.writes.size, groups };
}
function objectCacheDrop(k) {
	const e = objectCache.get(k);
	if (!e) return false;
	objectCache.delete(k);
	objectCacheBytes -= e.n;
	return true;
}
const OC_SEP = String.fromCharCode(0); // the NUL that object-cache-js.php puts after the group in a pkey
function ocGroupOf(k) { const i = k.indexOf(OC_SEP); return i < 0 ? k : k.slice(0, i); }
function ocCount(k, field) { const g = ocGroupOf(k) + "." + field; stats.ocGroups[g] = (stats.ocGroups[g] || 0) + 1; }
function dbTableOf(sql) { const m = /\b(?:FROM|INTO|UPDATE|JOIN)\s+`?([A-Za-z0-9_]+)`?/i.exec(sql); if (m) return m[1].toLowerCase(); const w = /^\s*([A-Za-z]+)/.exec(sql); return w ? w[1].toLowerCase() : "?"; }
function countTable(sql) { const t = dbTableOf(sql); stats.dbTables[t] = (stats.dbTables[t] || 0) + 1; }
function diffCounts(now, was) { const o = {}; for (const k in now) { const dv = now[k] - (was[k] || 0); if (dv) o[k] = dv; } return o; }

// L2 (KV) object cache (#218), BEHIND the in-isolate Map: a cold isolate reads a
// shared KV store instead of MySQL. Only groups PHP already persists reach here (the
// OBJECT_CACHE_GROUPS allowlist and salted groups; the Woo correctness groups never
// send a bridge op), so L2 inherits that safety by construction. Off unless the OC_KV
// binding is present and OBJECT_CACHE_L2=on, so b-dosql and D1 are untouched. Staleness
// is bounded: a del writes through to KV, and an allowlisted group already tolerates the
// bounded-TTL class of staleness; KV's min 60 s expiry is the cross-isolate bound.
let ocCtx = null; // the current request ctx, for L2 write-through via waitUntil
// #500: one KV writer per isolate: skip an unchanged PUT, at most one PUT per key per second (the
// latest value), a cap per request, and 429s counted (oc-l2-writer.mjs). Made on first use.
let ocL2W = null;
function ocL2Writer() {
	if (!ocL2W) ocL2W = createL2Writer({ put: (k, v, ttl) => ENV.OC_KV.put(k, v, { expirationTtl: ttl }), del: (k) => ENV.OC_KV.delete(k) });
	return ocL2W;
}
function ocL2On() { return !!(ENV && ENV.OBJECT_CACHE_L2 === 'on' && ENV.OC_KV); }
function ocTtlMs() { const t = Math.max(0, Math.min(3600, parseInt(ENV && ENV.OBJECT_CACHE_TTL, 10) || 10)); return t * 1000; }
function ocKvKey(k) { return 'oc:' + encodeURIComponent(k); } // NUL-safe KV key from the pkey
function ocStore(k, v, exp) {
	const n = k.length + v.length;
	if (n > objectCacheCap / 4) return false;
	objectCacheDrop(k);
	objectCache.set(k, { v, exp, n });
	objectCacheBytes += n;
	for (const kk of objectCache.keys()) { if (objectCacheBytes <= objectCacheCap) break; objectCacheDrop(kk); }
	return true;
}
// #734: a missing versions table is logged once per isolate (m: ocv), so deploy/doctor can warn.
let ocvMissLogged = false;
async function objectCacheOp(op) {
	stats.ocCalls++;
	if (op.op === 'vmiss') {
		if (!ocvMissLogged) {
			ocvMissLogged = true;
			console.log(JSON.stringify({ m: 'ocv', table: 'missing', iso: ISOLATE_ID }));
		}
		return {};
	}
	const now = Date.now();
	const l2 = ocL2On();
	if (op.op === 'get') {
		const out = [];
		for (const k of op.k) {
			ocCount(k, "get");
			const e = objectCache.get(k);
			if (e && !(e.exp && e.exp <= now)) {
				objectCache.delete(k); objectCache.set(k, e); // most recently used goes last
				stats.ocHits++; ocCount(k, "hit"); out.push(e.v); continue;
			}
			if (e) objectCacheDrop(k); // expired
			ocCount(k, "miss");
			if (l2) {
				let kv = null;
				const tl2 = Date.now();
				try { kv = await ENV.OC_KV.get(ocKvKey(k)); } catch { kv = null; }
				stats.l2N++;
				stats.l2Ms += Date.now() - tl2;
				if (kv != null) {
					ocStore(k, kv, l1ExpFor(k, now, ocTtlMs())); // warm in this isolate; a versioned key has no time bound (#1078)
					ocL2Writer().noteRead(ocKvKey(k), kv); // #500: a set of the same value needs no PUT
					stats.ocHits++; stats.l2Hits++; ocCount(k, "l2hit"); out.push(kv); continue;
				}
				ocCount(k, "l2miss");
			}
			out.push(null);
		}
		return { v: out };
	}
	if (op.op === 'set') {
		ocCount(op.k, "set");
		if (undoLog) undoLog.touch(op.k);
		const req0 = ocReq; // #766
		if (req0) req0.writes.add(op.k);
		const n = op.k.length + op.v.length;
		if (n > objectCacheCap / 4) return { ok: false };
		ocStore(op.k, op.v, isVersionedKey(op.k) ? 0 : op.ttl > 0 ? now + op.ttl * 1000 : 0); // #1078: a versioned key cannot go stale
		if (l2 && ocCtx) { const ttl = Math.max(60, op.ttl > 0 ? op.ttl : 60); const k2 = ocKvKey(op.k), v2 = op.v, c2 = ocCtx; const doSet = () => { if (req0 && req0.poisoned) return; try { const w = ocL2Writer().set(k2, v2, ttl); if (w) c2.waitUntil(w); } catch {} }; const holdOptions = !!(undoLog && undoLog.pluginStatusHeld() && ocGroupOf(op.k) === 'options'); if (!(undoLog && undoLog.defer(doSet, holdOptions))) doSet(); } // #352: held until the frame is kept; #954: an options set during a plugin hold waits for the request end
		return { ok: true };
	}
	if (op.op === 'del') {
		if (undoLog) for (const k of op.k) undoLog.touch(k);
		if (ocReq) for (const k of op.k) ocReq.writes.add(k); // #766
		let n = 0;
		for (const k of op.k) { ocCount(k, "del"); if (objectCacheDrop(k)) n++; if (l2 && ocCtx) { try { ocCtx.waitUntil(ocL2Writer().del(ocKvKey(k))); } catch {} } }
		return { n };
	}
	if (op.op === 'cap') {
		objectCacheCap = nextObjectCacheCap(op, objectCacheCap);
		for (const kk of objectCache.keys()) { if (objectCacheBytes <= objectCacheCap) break; objectCacheDrop(kk); }
		return { ok: true, n: objectCacheCap };
	}
	if (op.op === 'flush') {
		objectCacheClear();
		return { ok: true };
	}
	if (op.op === 'flush_group') {
		for (const k of [...objectCache.keys()]) if (k.startsWith(op.g)) objectCacheDrop(k);
		return { ok: true };
	}
	return { ok: false };
}
// Counters only grow. A request reports the difference, so a nested request
// (WordPress calling its own URL) cannot reset an outer one.
const stats = newStats();
let bootPromise;
// The most recently booted PHP, so the /_memprobe bridge (handleMessage probeMem) can
// read the live WASM heap size from JS. memory_get_usage() reports 0 under USE_ZEND_ALLOC=0.
let lastBootedPhp = null;
// Drop every hold on a runtime that will not be used again (#394 (b)), so its WebAssembly memory can
// be collected before the next boot grows a new one. exit() deletes php-wasm's Module reference; its
// errors are ignored, since the runtime is finished either way.
function releaseRuntime(php) {
	if (lastBootedPhp === php) lastBootedPhp = null;
	const M = php[__private__dont__use]; // exit() deletes it: read it first
	try {
		php.exit(0);
	} catch {
		// already exited, or exit threw: nothing more to release
	}
	// #598 / #603: the memory is handed on only once the runtime has DRAINED (memory-reuse.mjs drainAndRetire): no
	// call in flight, then one macrotask so the settled calls' JS continuations are done with the heap, then pfDead,
	// after which the loader refuses it every new call. The retirer calls this only on a clean reap (no PHP run
	// executing). The offer is the spare's pending offer, so the next boot waits for it (bounded).
	// With reuse off nothing here changes what the runtime does: the loader installed no guards (#598 condition 2).
	const on = reuseActive();
	if (M && on) {
		const mem = memOf.get(php);
		// current (#705 finding 1): a runtime was instantiated AFTER this one was dropped. It runs on a memory of
		// its own, so this one would be held beside it for its whole life: never kept. (A runtime with no drop
		// recorded, an orphan boot, counts as current: fail safe.)
		const droppedAt = droppedAtSerial.get(php);
		spare.setPending(offerWhenDrained(spare, M, mem, { on, droppedAt, serialNow: () => runtimeSerial }).then((why) => {
			lastSpareOffer = why;
			console.log(JSON.stringify({ m: 'mem-reuse', offer: why, spareMiB: spare.mib }));
		}));
	}
}
// #566: drop the runtime and RELEASE it, synchronously, at a point where nothing can be using it.
// withPhp brackets every PHP run with retirer.runStart / runEnd (in finally, on the request's own awaited
// path): a drop while a run executes queues the runtime, and the end of the last run releases it in that
// call; a drop while idle releases at once. No promise continuation is involved, because workerd drops
// those of a finished or aborted request (#568 chained one, and on pf394a the release never ran).
let bootGen = 0; // bumped on every drop, so a boot that finishes after one knows it is an orphan
const retirer = createRetirer(releaseRuntime);
// #598 / #603 (memory-reuse.mjs): the retired runtime's memory, kept for the next boot (PHP_MEMORY_REUSE=on).
const spare = createSpare();
// #603 (C): read once, from the module, before any instantiation: a build that does not import its memory never
// reuses (a spare handed to it would be held beside the memory it makes itself).
const MODULE_IMPORTS_MEMORY = moduleImportsMemory(wasmModule);
let reuseMismatchLogged = false;
function reuseActive() {
	const on = reuseOn(ENV);
	if (on && !MODULE_IMPORTS_MEMORY && !reuseMismatchLogged) {
		reuseMismatchLogged = true;
		console.log(JSON.stringify({ m: 'mem-reuse', off: 'the engine defines its own memory (a build without the prepare.sh transform)' }));
	}
	return on && MODULE_IMPORTS_MEMORY;
}
const memOf = new WeakMap(); // php -> its WebAssembly.Memory (instantiateWasm), for the spare
let lastSpareOffer = null;
// #705: the runtime serial at which each runtime was dropped (dropRuntime). An offer still waiting for the loader's
// pfOnIdle (php.exit leaves its exit handlers in flight for one microtask) is the spare's pending offer: a boot
// waits for it, at most PENDING_OFFER_MS (memory-reuse.mjs waitPending).
const droppedAtSerial = new WeakMap();
const PENDING_OFFER_MS = 100;
function dropRuntime() {
	const held = lastBootedPhp;
	if (held && !droppedAtSerial.has(held)) droppedAtSerial.set(held, runtimeSerial);
	bootGen++;
	bootPromise = null;
	retirer.retire(held);
}
// #705 (findings 1, 2): a drop at the START of a request, before it has run anything on that runtime. When this
// request's own run is the only one executing, nothing can be using the runtime, so it is released NOW: its memory
// can be the spare of the boot that follows in this request, and is not left alive beside it until the request ends.
// With a stale lock (another run executing) it stays queued, as dropRuntime leaves it.
function dropRuntimeIdle() {
	const held = lastBootedPhp;
	dropRuntime();
	if (held && reuseActive()) retirer.releaseNow(held); // #724 review, finding 3: with reuse off, queued as main
}
// The admin memory trace of the request now running (#434, php/mem-trace.php): set by the
// memTrace message at PHP shutdown, read once into the operator-only x-mem-trace header.
let lastMemTrace = null;
// The operator's per-request id (#434): x-perf-id, logged on the memory marks and on the reset
// lines, so a request killed by an isolate reset can be joined to its marks. Operator requests
// only (a valid spike token), and only a short safe token, so a visitor cannot write into logs.
const MEM_ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;
function memIdOf(req, env) {
	const id = req.headers.get('x-perf-id');
	return id && MEM_ID_RE.test(id) && perfHeadersAllowed(req, env) ? { id } : {};
}
// The isolate memory ledger (#394, mem-ledger.mjs): off unless MEM_LEDGER=on or an operator request
// sends x-mem-ledger: 1. ledgerActive is set per request (and per cron leg), ledgerId is its x-perf-id.
const ledger = createLedger();
const sqlMeter = createSqlMeter();
let ledgerActive = false;
// #1120: the running cron leg's gate (cronMore with its clock, budget and heap), or null outside a leg.
let cronMoreGate = null;
// #296 step 3: the query trace of THIS request (qtrace.mjs), or null. Spike token AND x-pf-qtrace: 1 only.
let qtrace = null;
let ledgerId = null;
let ledgerFailLogged = false;
// The inflate counters when this request (or cron leg) started (#394): every inflated copy is a new
// buffer, and an evicted one stays in the isolate until V8 collects it. The ledger reports what was
// inflated so far in the request and in the isolate, the upper bound on that garbage.
let ledgerInfl0 = { n: 0, b: 0, r: 0, ae: 0 };
const heapOf = (p) => p[__private__dont__use].HEAPU8.length; // a runtime's wasm heap bytes (the ledger, the gate)
function ledgerSnapshot(at) {
	const php = lastBootedPhp;
	let memfs = null;
	try {
		memfs = php ? memfsBytes(php[__private__dont__use].FS) : null;
	} catch (e) {
		memfs = { error: String((e && e.message) || e).slice(0, 80) };
	}
	return { at, iso: ISOLATE_ID, rt: runtimeSerial, wasmMiB: php ? LEDGER_MIB(heapOf(php)) : null, runtimes: ledger.runtimes(currentSerial(runtimeSerial, !!bootPromise), heapOf), memReuse: { on: reuseActive(), spareMiB: spare.mib, lastOffer: lastSpareOffer, ...spare.counts }, memfs, inflatedMiB: LEDGER_MIB(inflatedBytes), ocMiB: LEDGER_MIB(objectCacheBytes), sql: sqlMeter.read(), inflate: { reqN: stats.inflates - ledgerInfl0.n, reqMiB: LEDGER_MIB(stats.inflateBytes - ledgerInfl0.b), isoN: stats.inflates, isoMiB: LEDGER_MIB(stats.inflateBytes), reinflateN: stats.reinflates - ledgerInfl0.r, ...(inflateArena ? { arena: { mib: LEDGER_MIB(inflateArena.size), arenaEvict: inflateArena.counts.evicts - ledgerInfl0.ae, over: inflateArena.counts.over } } : {}) } };
}
// #394 /_headroom: the parts of the ledger that show memory arriving during the probe loop.
function headroomLedger() {
	const s = ledgerSnapshot('headroom-step');
	return { wasmMiB: s.wasmMiB, live: s.runtimes && s.runtimes.live, boots: s.rt, isoMiB: s.inflate && s.inflate.isoMiB, inflatedMiB: s.inflatedMiB };
}
function ledgerLog(at, extra) {
	console.log(JSON.stringify({ m: 'mem-ledger', ...(ledgerId ? { id: ledgerId } : {}), ...ledgerSnapshot(at), ...(extra || {}) }));
}
// Performance instrument (docs/perf-dosql.md), PHP object only. Counts do not
// need the clock: in a Worker or a Durable Object, Date.now() moves only at
// I/O, so a time measured across synchronous PHP and SQLite work can read 0.
const ISOLATE_ID = Math.random().toString(36).slice(2, 8);
// Set on the first request this isolate serves (#474). Date.now() reads 0 at module scope in
// Workers (time does not move outside a request), so a module-scope value made isoAgeS epoch seconds.
let isolateStart = 0;
let runtimeSerial = 0; // runtimes booted in this isolate
// Runtimes dropped without a plan (recycled for memory, crashed, a stale lock, a
// failed request, another origin). /_activate restarts on purpose and is not
// counted. opcache.sh needs 0, so one runtime compiled what the pages used.
let runtimeDrops = 0;
let runtimeServed = 0; // requests the current runtime served
let runtimeBootAt = 0;
let runtimeBootBytes = 0; // #603 (A): the memory's size when this runtime booted (an inherited size, with reuse)
let phpPending = 0; // object requests in the PHP queue or running
// When the last deploy-time spike long-op (/_install, /_activate) finished. The cron alarm
// skips a run within SPIKE_CRON_GRACE_MS of it, so an externally-armed alarm (a visitor to the
// public URL) cannot fire runCron in the gap between /_install and /_activate, where /_activate
// would then reuse the cron runtime and its output (#185).
let lastSpikeEndAt = 0;
// The origin the current runtime booted with (WP_HOME in wp-runtime.php).
let bootOrigin = null;

// The site's own origin, for WP_HOME and every link (issue #33): the var
// SITE_ORIGIN when it is set (deploy/deploy.sh and run.sh set it), so no first
// request can choose it: not PHP's own WebSocket (#55), not a health probe, not
// a second host name. Without SITE_ORIGIN (an unconfigured local run), the
// request's origin, as before; the runtime then reboots when that changes.
const ORIGIN_RE = /^https?:\/\/[a-z0-9.-]+(:[0-9]{1,5})?$/i;
let siteOriginWarned = false;
function siteOrigin(env, url) {
	const o = env && env.SITE_ORIGIN;
	if (typeof o === 'string' && ORIGIN_RE.test(o)) return o.toLowerCase();
	if (o && !siteOriginWarned) {
		siteOriginWarned = true;
		console.log(JSON.stringify({ m: 'site-origin-invalid', value: String(o).slice(0, 100) }));
	}
	return url.origin;
}
// One PHP runtime per isolate, and PHP is not re-entrant. Measured 2026-11-04:
// with 30 parallel requests on one isolate, about half crashed. So requests
// that use PHP run one at a time (php-lock.mjs). A templates list GET goes ahead of other queued boot calls (#962).
// If the request ahead never finishes, a waiter would wait forever. On Free a
// request stopped for CPU can leave the isolate alive with the lock held
// (measured 2026-11-04: 524 timeouts). Once the run AHEAD has executed
// LOCK_STALE_MS, a waiter goes on with a new PHP runtime. 60 s: the installer runs
// about 32 s on Paid. #296: a long WAIT behind healthy runs is never stale any more:
// it booted a second runtime beside a live one and reset the isolate's whole queue.
const LOCK_STALE_MS = 60000;
// #1060: a head is stale only when it has ALSO made no progress (a PHP bridge message: a query, a cache or R2 op) for
// this long. A slow run that is working (cross-region MySQL, #1054) is never stale. And no run takes a stale lock over:
// request runs shed (a retryable 503), background runs wait (withPhp staleAction). Measured on cf759hl, 2026-11-20:
// the takeover booted a second runtime beside the live one and the isolate died with every queued request.
const LOCK_STALL_MS = 30000;
// One line per contended event (php-lock.mjs: queued, granted, shed, stale), with this isolate's id.
const phpLock = createPhpLock({ staleMs: LOCK_STALE_MS, stallMs: LOCK_STALL_MS, staleAction: 'wait', log: (e) => console.log(JSON.stringify({ m: 'php-lock', iso: ISOLATE_ID, ...e })) });
let phpShedRefusedLogged = false;
// #714: the overflowed requests this Worker isolate holds in flight now (PHP_OVERFLOW_MAX_HELD caps it).
let ovHeld = 0;
// The shed bound of this path (PHP_QUEUE_SHED_MS; php-lock.mjs shedMsFor), with a bad value logged once.
function phpShedMs(env, inObject) {
	const b = shedMsFor(env, inObject);
	if (b.refused && !phpShedRefusedLogged) {
		phpShedRefusedLogged = true;
		console.log(JSON.stringify({ m: 'php-lock-setting', refused: b.refused }));
	}
	return b.ms;
}
// A request shed by the PHP lock: nothing ran, so the client may simply try again. Never stored by a cache.
function phpShedResponse() {
	return shedAnswer('The site is busy. Please try again in a few seconds.\n'); // #715 review2 10: one builder
}
// The cron alarm holds off this long after a deploy-time spike op finishes (#185).
const SPIKE_CRON_GRACE_MS = 2000;
// The alarm waits at most this long for the deferred-email sends, so a stuck or throttled
// env.EMAIL.send cannot hold the alarm until the DO wall-clock kills it (#194).
const SEND_TIMEOUT_MS = 5000;
// withPhp(fn, { shedMs, held }): fn's result, or PHP_SHED when the wait passed shedMs (0: never; only the
// two request paths pass one). Cron, snapshots, dumps and imports always wait their turn.
// #720: held reuses the lock the caller already holds. A second phpLock.run waits out staleMs, then
// onStale drops the runtime. The lock is not reentrant. Only /_runcron passes held, because that
// route is already inside the request withPhp. The alarm does not, so it always takes the lock.
// #1101: the call id of the PHP run executing now. PHP runs are serialized per isolate (the PHP lock), so it is exact for
// the run's length. Approach A's local run sets it (withRunCall); in the object it stays null and ctx.callId is used.
let runCallId = null;
async function withRunCall(callId, fn) {
	runCallId = callId;
	try {
		return await fn();
	} finally {
		if (runCallId === callId) runCallId = null;
	}
}
// The call id for a log line (#708, #1101): the object's ctx.callId, or approach A's run id.
function callTag(ctx) {
	const call = (ctx && ctx.callId) || runCallId;
	return call ? { call } : {};
}
function withPhp(fn, { shedMs = 0, tag = null, shedWhy = null, recheck = null, held = false, signal = null, priority = 0, staleAction = 'wait' } = {}) {
	if (held) return fn();
	return phpLock.run(
		async () => {
			retirer.runStart();
			try {
				return await withDbRun(dbHandler, fn); // #1087: approach A's MySQL connection lives exactly this run
			} finally {
				retirer.runEnd();
			}
		},
		{
			shedMs,
			tag, // #708: the forwarded request's correlation id, on its lock lines
			shedWhy,
			recheck,
			signal, // #721: the caller's request.signal (a disconnect sheds a waiter)
			priority, // #962: a templates list GET runs before other queued boot calls
			staleAction, // #1060: shed (request paths) or wait (everything else); never take over a live runtime
			onStale: () => {
				if (bootPromise) runtimeDrops++;
				dropRuntime(); // the old runtime's state is unknown; the stale run still counts as running, so it is released when that run ends too
			},
		},
	);
}
// D1 keeps a row up to 2 MB. A larger body cannot be stored, and a 4 MB body
// ran the isolate out of memory (measured 2026-11-04). Override with MAX_BODY_BYTES.
const MAX_BODY_BYTES = 2 * 1024 * 1024;
// A media upload can be larger: the Worker stores it in R2 first, and PHP gets
// a small marker (php/r2-uploads.php). 20 MB is the Images binding input limit.
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const STAGE_MIN_BYTES = 1024 * 1024;

function isMediaUpload(req, url) {
	if (req.method !== 'POST') return false;
	if (url.pathname === '/wp-admin/async-upload.php' || url.pathname === '/wp-admin/media-new.php') return true;
	const route = url.searchParams.get('rest_route') || (url.pathname.startsWith('/wp-json/') ? url.pathname.slice(8) : '');
	return /^\/wp\/v2\/media\/?$/.test(route);
}

// The type of a file from its first bytes, and whether it looks like markup or code.
function sniff(b) {
	const at = (o, str) => [...str].every((c, i) => b[o + i] === c.charCodeAt(0));
	let type = 'application/octet-stream';
	if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) type = 'image/jpeg';
	else if (at(0, '\x89PNG')) type = 'image/png';
	else if (at(0, 'GIF8')) type = 'image/gif';
	else if (at(0, 'RIFF') && at(8, 'WEBP')) type = 'image/webp';
	else if (at(4, 'ftyp')) {
		const brand = String.fromCharCode(...b.slice(8, 12));
		type = /avif|avis/.test(brand) ? 'image/avif' : /heic|heix|mif1|msf1/.test(brand) ? 'image/heic' : 'video/mp4';
	} else if (at(0, '%PDF')) type = 'application/pdf';
	const head = new TextDecoder().decode(b.slice(0, 1024)).toLowerCase();
	return { type, dangerous: /<\?php|<script|<html|<!doctype html|<svg/.test(head) };
}

async function stageFile(env, bytes, contentType) {
	const key = 'staging/' + crypto.randomUUID();
	await env.MEDIA.put(key, bytes, { httpMetadata: { contentType: contentType || 'application/octet-stream' } });
	const s = sniff(bytes);
	return new TextEncoder().encode('R2STAGED\n' + JSON.stringify({ key, size: bytes.length, sniffed: s.type, dangerous: s.dangerous }));
}

// Store the file part(s) of a large media upload in R2. Returns the body and
// content type PHP gets instead.
async function stageUpload(req, env) {
	const ct = req.headers.get('content-type') || '';
	if (/^multipart\/form-data/i.test(ct)) {
		const form = await req.formData();
		const out = new FormData();
		for (const [k, v] of form) {
			if (typeof v !== 'string' && v.size > 0) {
				const marker = await stageFile(env, new Uint8Array(await v.arrayBuffer()), v.type);
				out.append(k, new File([marker], v.name, { type: v.type }));
			} else {
				out.append(k, v);
			}
		}
		const res = new Response(out);
		return { body: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get('content-type') };
	}
	const marker = await stageFile(env, new Uint8Array(await req.arrayBuffer()), ct);
	return { body: marker, contentType: ct };
}

function newStats() {
	return { calls: 0, ms: 0, failures: [], log: [], r2: {}, rowsRead: 0, rowsWritten: 0, inflates: 0, inflateBytes: 0, reinflates: 0, lazyWrites: 0, rfN: 0, rfBytes: 0, rfMs: 0, rfFail: 0, rfCapped: 0, rfRetry: 0, rsN: 0, rsBytes: 0, rsMs: 0, rsFail: 0, rsCapped: 0, rsRetry: 0, dbTables: {}, ocGroups: {}, ocCalls: 0, ocHits: 0, l2N: 0, l2Ms: 0, l2Hits: 0, httpCalls: 0, httpMs: 0, txnOps: 0, undoRows: 0 };
}

// Every statement failure goes through here. resetFailTotal counts the isolate memory resets among
// them and only grows, so a cron tick can read how many writes it has lost so far (#362) even when
// trimStats cuts the list.
let resetFailTotal = 0;
let failureSeq = 0; // #744: each failure's number, so /_activate can name the failures of its own run
function noteFailure(f) {
	f.seq = ++failureSeq;
	stats.failures.push(f);
	resetFailTotal += resetFailures([f]);
}

// The log and failure lists live as long as the isolate. Keep the newest only.
function trimStats() {
	if (stats.log.length > 2000) stats.log.splice(0, stats.log.length - 1000);
	if (stats.failures.length > 500) stats.failures.splice(0, stats.failures.length - 250);
}

// Entries of a zip, from its central directory. data() returns the file
// bytes: a view for a stored entry, an inflated copy for a deflated one.
function zipEntries(zip) {
	const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
	let eocd = zip.length - 22;
	while (eocd >= 0 && dv.getUint32(eocd, true) !== 0x06054b50) eocd--;
	if (eocd < 0) return [];
	const total = dv.getUint16(eocd + 10, true);
	let p = dv.getUint32(eocd + 16, true);
	const dec = new TextDecoder();
	const out = [];
	for (let n = 0; n < total; n++) {
		if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('bad zip central directory');
		const method = dv.getUint16(p + 10, true);
		const csize = dv.getUint32(p + 20, true);
		const size = dv.getUint32(p + 24, true);
		const nlen = dv.getUint16(p + 28, true);
		const xlen = dv.getUint16(p + 30, true);
		const clen = dv.getUint16(p + 32, true);
		const local = dv.getUint32(p + 42, true);
		const name = dec.decode(zip.subarray(p + 46, p + 46 + nlen));
		p += 46 + nlen + xlen + clen;
		out.push({
			name,
			method,
			size,
			data(out) {
				const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
				const raw = zip.subarray(start, start + csize);
				return method === 0 ? raw : inflateSync(raw, { out: (out && out(size)) || new Uint8Array(size) });
			},
		});
	}
	return out;
}

// A MEMFS file whose contents are made on first read. Its size is known at
// once, so stat() does not inflate it. A write replaces the lazy contents.
// Lazy files whose contents are inflated now. evictLazy() drops them after a
// request: OPcache holds the compiled code, and a file can be inflated again.
// Measured 2026-11-04: with WooCommerce, keeping them hit "Worker exceeded
// memory limit".
// Within a request too: the inflated copies are capped at LAZY_CACHE_BYTES,
// oldest dropped first. A WooCommerce checkout reads about 1,500 compiled files.
// 2 MiB since #394 (was 8). At every failing post-new INSERT on pf394a the cache sat at its cap; at 2
// post-new died 60 of 100 rounds against 82 of 100 at 8, with boot time and inflates per boot unchanged
// (repeat pair, 2026-11-13/14, #394 issuecomment-6868335297). LAZY_CACHE_MB overrides (#218).
let LAZY_CACHE_BYTES = 2 * 1024 * 1024;
// #394 step 2 (LAZY_ARENA=on, off by default): inflate into ONE reused arena per isolate instead of a
// new buffer per file (inflate-arena.mjs). LAZY_ARENA_MB sizes it (default: LAZY_CACHE_BYTES).
let inflateArena = null;
function arenaOn() { return !!(ENV && ENV.LAZY_ARENA === 'on'); }
function getArena() {
	if (!inflateArena) {
		const mb = Number(ENV && ENV.LAZY_ARENA_MB);
		inflateArena = createArena(Number.isFinite(mb) && mb >= 1 && mb <= 64 ? Math.round(mb) * 1048576 : LAZY_CACHE_BYTES);
	}
	return inflateArena;
}
const inflated = new Map(); // drop function -> bytes
// FILE_TRACE=on (#394 M0): record which bundle files each request reads (file-trace.mjs, GET /_trace).
// Off by default; it changes no behavior, only notes the path of each read.
const fileTrace = createTrace();
const tracing = () => Boolean(ENV && ENV.FILE_TRACE === 'on');
let inflatedBytes = 0;
// #394 L1: the boot pack's file nodes, mounted for one request when a runtime boots.
let bootPackPaths = null;
// #563: the remote OPcache packs of the runtime booted last (null: none), and what its boot did with
// them, for x-perf (remote): 'packs <n> files', 'off', 'fallback:no-assets-binding', or 'none'.
let remotePacks = null;
// #569: the site packs of the runtime booted last, the request budget both share (the soft cap for
// OPcache opens, the hard cap for site opens), and the site state for x-perf (siteRemote).
let sitePacks = null;
let siteHooks = null; // #569: the hybrid hooks (createSiteHooks): .php at read, others at open
let fetchBudget = null;
let siteState = 'none';
let remoteState = 'none';
const remoteOn = () => Boolean(OPCACHE_REMOTE && ENV && ENV.OPCACHE_REMOTE !== 'off');
// The loader's open() asks this first (prepare.sh, #563). null: open now. A promise: PHP waits for the
// pack; if it rejects, the open fails with EIO and OPcache compiles the script from source.
function remoteOpenHook(path) {
	if (path.length > OPCACHE_DIR.length + 1 && path.startsWith(OPCACHE_DIR + '/')) return remotePacks ? remotePacks.open(path.slice(OPCACHE_DIR.length + 1)) : null;
	// #569: a site file (site.zip names have no leading slash). The hybrid: only a NON-.php is fetched at
	// open (a .php at its first read, remoteReadHook). A directory or a file the index does not hold
	// (one PHP wrote) is no fetch.
	return siteHooks ? siteHooks.open(path) : null;
}
// #569: the loader's reads ask this first (prepare.sh PY6). A remote .php whose pack is not held yet
// returns a promise: PHP waits, then reads; a rejection fails the read with EIO before any byte.
// #569: the remote pack counters, read BEFORE a request awaits its boot, so x-perf counts the fetches
// the boot itself made (the site self-check). The post-boot start snapshot missed them (pf570m: rsN 13
// against rsPacks 14 on a booting request).
function remoteCounters() {
	return { rfN: stats.rfN, rfBytes: stats.rfBytes, rfMs: stats.rfMs, rfFail: stats.rfFail, rfCapped: stats.rfCapped, rsN: stats.rsN, rsBytes: stats.rsBytes, rsMs: stats.rsMs, rsFail: stats.rsFail, rsCapped: stats.rsCapped, rsRetry: stats.rsRetry };
}
function remoteReadHook(stream, kind) {
	return siteHooks ? siteHooks.read(stream, kind) : null;
}
async function fetchRemotePack(name) {
	const r = await ENV.ASSETS.fetch(new Request('https://assets.local/_pf/' + (OPCACHE_REMOTE || SITE_REMOTE).id + '/' + name));
	if (!r.ok) throw new Error(name + ' answered ' + r.status);
	return new Uint8Array(await r.arrayBuffer());
}
// A node per remote file: its size is known at once (stat needs no bytes), its contents come from
// the held pack. A read with the pack not held fails with EIO (the open fetches it first).
// #569: a remote SITE file. The same, but PINNED while open (attachLazyContents tag.pin): no evict
// drops an open file's bytes, so after a successful open() every read succeeds.
// #569: a SITE_REMOTE boot that refuses (no ASSETS binding, OPcache off, the self-check failed). The
// request handler answers it with a 503 that NAMES the reason (x-site-remote-refused), never a bare 500.
function siteRefusal(code, message) {
	const e = new Error('site refused (' + code + '): ' + message);
	e.siteRemoteRefused = code;
	return e;
}
function remoteSiteFile(FS, path, name, size) {
	FS.writeFile(path, new Uint8Array(0));
	attachLazyContents(FS.lookupPath(path).node, size, (out) => {
		const b = sitePacks && sitePacks.data(name, out);
		if (!b) throw new FS.ErrnoError(29);
		return b;
	}, { src: 'site', path, pin: siteHooks.pinMode(name) });
}
function remoteFile(FS, path, name, size) {
	FS.writeFile(path, new Uint8Array(0));
	attachLazyContents(FS.lookupPath(path).node, size, (out) => {
		const b = remotePacks && remotePacks.data(name, out);
		if (!b) throw new FS.ErrnoError(29);
		return b;
	}, { src: 'opcache', path });
}
// What the last boot did with the boot pack, for x-perf (l1): 'assets', 'fallback:<why>', or 'none'.
let l1State = 'none';
async function loadBootPacks() {
	const t = Date.now();
	const base = 'https://assets.local/_pf/' + OPCACHE_BOOT.id + '/';
	// OPCACHE_BOOT_SOURCE=none forces the no-pack path (a test of it; see tests/l1-e2e.sh).
	if (ENV && ENV.ASSETS && ENV.OPCACHE_BOOT_SOURCE !== 'none') {
		try {
			const packs = await Promise.all(
				OPCACHE_BOOT.chunks.map(async (c) => {
					const r = await ENV.ASSETS.fetch(new Request(base + c));
					if (!r.ok) throw new Error(c + ' answered ' + r.status);
					return new Uint8Array(await r.arrayBuffer());
				}),
			);
			// #801: a pack that is not the length the split wrote (truncated, or another build's) is refused, loudly,
			// rather than reported as 'assets' while OPcache compiles the boot from source. An older index has no
			// chunkBytes and is not checked.
			const want = Array.isArray(OPCACHE_BOOT.chunkBytes) ? OPCACHE_BOOT.chunkBytes : null;
			if (want) packs.forEach((p, i) => { if (p.length !== want[i]) throw new Error(OPCACHE_BOOT.chunks[i] + ' is ' + p.length + ' bytes, the index says ' + want[i]); });
			const kib = Math.round(packs.reduce((n, p) => n + p.length, 0) / 1024);
			console.log(JSON.stringify({ m: 'l1', source: 'assets', chunks: packs.length, kib, ms: Date.now() - t }));
			l1State = `assets ${kib}KiB ${Date.now() - t}ms`;
			return packs;
		} catch (e) {
			l1State = 'fallback:compile:assets-failed';
			console.error(JSON.stringify({ m: 'l1', fallback: 'compile', why: 'assets failed: ' + String((e && e.message) || e).slice(0, 160) }));
			return [];
		}
	}
	// No boot pack: this boot compiles the boot-only scripts from source (OPcache's normal path).
	// There is NO in-memory fallback on purpose: #411 measured that a data module costs isolate memory
	// even when it is never imported (p411-lazy, 144 MiB, 3 of 3), so a fallback module would cost
	// exactly the memory L1 saves. Said loudly, every time.
	l1State = ENV && ENV.ASSETS ? 'fallback:compile:forced' : 'fallback:compile:no-assets-binding';
	console.error(JSON.stringify({ m: 'l1', fallback: 'compile', why: ENV && ENV.ASSETS ? 'OPCACHE_BOOT_SOURCE=none' : 'no ASSETS binding' }));
	return [];
}
function dropBootPack(FS) {
	if (!bootPackPaths) return;
	for (const p of bootPackPaths) {
		try {
			FS.unlink(p);
		} catch {
			// already gone
		}
	}
	bootPackPaths = null;
}
function evictLazy() {
	for (const drop of inflated.keys()) drop();
	if (inflateArena) inflateArena.evictAll(); // #394: the arena's entries too; the arena itself stays
	inflated.clear();
	inflatedBytes = 0;
}
function noteInflated(drop, bytes) {
	stats.inflates++;
	stats.inflateBytes += bytes;
	inflated.set(drop, bytes);
	inflatedBytes += bytes;
	for (const [old, n] of inflated) {
		if (inflatedBytes <= LAZY_CACHE_BYTES || old === drop) break;
		old();
		inflated.delete(old);
		inflatedBytes -= n;
	}
}

// Set the lazy contents getter on an already-created MEMFS file node: inflate on
// first read, cap+evict the inflated copies (noteInflated). Shared by lazyFile
// (eager node) and the lazy-node mount (node created on lookup).
function attachLazyContents(node, size, dataFn, tag) {
	let contents = null;
	let written = false;
	let used = size;
	let inflations = 0; // #394: a second inflate of this file is a RE-inflate (its copy was evicted)
	// #569: tag.pin (a REMOTE site file). Its bytes come from a pack that may be evicted, so from the
	// point its pack was fetched until its close, the inflated copy is PINNED: no evict drops it, and it
	// never lives in the arena (a later alloc could reuse that memory). Two modes (the hybrid):
	// - 'open' (non-.php): fetched at open(), pinned and inflated by the open;
	// - 'read' (.php): fetched at the FIRST READ (prepare.sh PY6), pinned there by pagefeatherPin.
	// After the pin, every read succeeds; the only failure point is the fetch: never a half file.
	const pin = tag && tag.pin ? (tag.pin === 'read' ? 'read' : 'open') : null;
	let pins = 0;
	const drop = () => {
		if (!written && pins === 0) contents = null;
	};
	Object.defineProperty(node, 'contents', {
		configurable: true,
		get() {
			if (tag && tracing()) fileTrace.read(tag.src, tag.path, size);
			if (contents === null) {
				if (inflations++ > 0) stats.reinflates++;
				// #394 step 2: with LAZY_ARENA=on, a deflated file inflates into the arena (a stored one is a view
				// of the bundle and needs no buffer; a file larger than the arena gets its own, as before).
				let inArena = false;
				const out = arenaOn() && !pin ? (n) => { const v = getArena().alloc(n, drop); inArena = !!v; return v; } : null;
				contents = dataFn(out);
				if (inArena) {
					stats.inflates++;
					stats.inflateBytes += contents.length;
				} else {
					noteInflated(drop, contents.length);
				}
			}
			return contents;
		},
		set(v) {
			contents = v;
			written = true; // PHP wrote this file. Keep it.
		},
	});
	Object.defineProperty(node, 'usedBytes', {
		configurable: true,
		get() {
			return used;
		},
		set(v) {
			used = v;
		},
	});
	// #530: MEMFS.write overwrites in place (contents.set) when a write fits inside usedBytes, and
	// never assigns node.contents, so the setter above never saw it: the file stayed unwritten and
	// drop() threw the edit away at the next evict (or, with LAZY_ARENA, the next ring overlap).
	// Every PHP write goes through stream.stream_ops.write, which FS.open copies from node.stream_ops,
	// so this node gets its own ops: before ANY write, take a private copy of the contents (never a
	// view into the bundle, the inflate cache or the arena) and mark the file written. msync calls
	// MEMFS.stream_ops.write directly, so it is wrapped too.
	const base = node.stream_ops;
	// #569 (Gate 2, step 3): FILE_TRACE=on also records each OPEN of a bundle file, as "<src>-open:" keys
	// beside the reads (the contents getter). The open() hook fetches on an open, and PHP opens files it
	// never reads (OPcache resolves a source it serves from its cache), so a trace of reads alone
	// measured the wrong event. Off with FILE_TRACE; consumers that match "site:" or "opcache:" never
	// see these keys.
	if (tag && base && tracing()) {
		const tbase = node.stream_ops;
		node.stream_ops = Object.assign(Object.create(tbase), {
			open(stream) {
				fileTrace.read(tag.src + '-open', tag.path, size);
				if (typeof tbase.open === 'function') tbase.open(stream);
			},
		});
	}
	const base2 = node.stream_ops;
	if (pin && base2) {
		// #569: FS.open copies node.stream_ops into the stream and calls its open, FS.close its close.
		const pinStream = (stream) => {
			pins++;
			stream.pfPinned = true;
			try {
				void node.contents; // inflate now, from the pack the fetch made sure is held
			} catch (e) {
				pins--;
				stream.pfPinned = false;
				throw e;
			}
		};
		const pinned = Object.create(base2);
		if (pin === 'open') {
			pinned.open = function (stream) {
				pinStream(stream);
				if (typeof base2.open === 'function') base2.open(stream);
			};
		} else {
			// The read hook (remote-packs.mjs createSiteHooks) pins at the first read.
			node.pagefeatherName = tag.path.slice(1);
			node.pagefeatherPin = pinStream;
		}
		pinned.close = function (stream) {
			if (stream.pfPinned) {
				stream.pfPinned = false;
				if (pins > 0) pins--;
			}
			if (typeof base2.close === 'function') base2.close(stream);
		};
		node.stream_ops = pinned;
	}
	const wbase = node.stream_ops;
	if (wbase && typeof wbase.write === 'function') {
		const own = () => {
			if (written) return;
			const c = node.contents; // inflates if it was dropped
			contents = c ? c.slice() : null;
			written = true;
			stats.lazyWrites++;
		};
		node.stream_ops = Object.assign(Object.create(wbase), {
			write(stream, buffer, offset, length, position, canOwn) {
				own();
				return wbase.write(stream, buffer, offset, length, position, canOwn);
			},
			...(typeof wbase.msync === 'function' ? { msync(stream, buffer, offset, length, flags) { own(); return wbase.msync(stream, buffer, offset, length, flags); } } : {}),
		});
	}
}

function lazyFile(FS, path, entry, src) {
	FS.writeFile(path, new Uint8Array(0));
	attachLazyContents(FS.lookupPath(path).node, entry.size, (out) => entry.data(out), src ? { src, path } : null);
}

// Lazy MEMFS NODE creation (issue #218, LAZY_NODES=on). Eager node creation
// (lazyFile per entry) makes a MEMFS node for every file in the tree at boot.
// Node contents are already lazy, but each NODE object costs about 1 KiB of the
// V8 JS heap, which x-wasm-mib (the PHP WASM heap only) does not measure yet
// counts against the 128 MiB isolate cap. A request touches about a quarter of
// the ~6800 files, so the other ~5000 nodes are ~5 MiB of V8 heap spent for
// nothing: the headroom approach A needs for its JS MySQL client. This mounts a
// directory INDEX onto a MEMFS dir and creates a child node only when the path
// is first looked up (or the directory is listed), adapted from HostlessWP
// (runtime/src/lazyfs.js at 739e8e7, GPL-2.0-or-later; docs/prior-art.md).
// Files inflate and evict through attachLazyContents, exactly as lazyFile.
function buildZipIndex(zip) {
	const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
	let eocd = zip.length - 22;
	while (eocd >= 0 && dv.getUint32(eocd, true) !== 0x06054b50) eocd--;
	if (eocd < 0) throw new Error('lazy: zip end-of-central-directory not found');
	const total = dv.getUint16(eocd + 10, true);
	const dec = new TextDecoder();
	const root = { files: new Map(), dirs: new Map() };
	let p = dv.getUint32(eocd + 16, true);
	for (let n = 0; n < total; n++) {
		if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('lazy: bad central directory entry');
		const nlen = dv.getUint16(p + 28, true);
		const xlen = dv.getUint16(p + 30, true);
		const clen = dv.getUint16(p + 32, true);
		const segs = dec.decode(zip.subarray(p + 46, p + 46 + nlen)).split('/');
		const file = segs.pop();
		let idx = root;
		for (const s of segs) {
			if (!s) continue;
			let sub = idx.dirs.get(s);
			if (!sub) idx.dirs.set(s, (sub = { files: new Map(), dirs: new Map() }));
			idx = sub;
		}
		if (file) idx.files.set(file, p); // just the central-directory offset: a number, not a node
		p += 46 + nlen + xlen + clen;
	}
	return { root, zip, dv };
}
// The file bytes for one central-directory offset, inflated on demand (same as zipEntries.data()).
function lazyEntryData(zip, dv, p, out) {
	const method = dv.getUint16(p + 10, true);
	const csize = dv.getUint32(p + 20, true);
	const size = dv.getUint32(p + 24, true);
	const local = dv.getUint32(p + 42, true);
	const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
	const raw = zip.subarray(start, start + csize);
	return method === 0 ? raw : inflateSync(raw, { out: (out && out(size)) || new Uint8Array(size) });
}
function lazyEntrySize(dv, p) {
	return dv.getUint32(p + 24, true);
}
const lazyOpsCache = new WeakMap();
const isLazyOps = new WeakSet();
function lazyOpsFor(base, FS, store) {
	let ops = lazyOpsCache.get(base);
	if (ops) return ops;
	// Materialise one child node from the index on first lookup. INVARIANT: the
	// name is deleted from the index BEFORE base.mknod, so a name is in the index
	// XOR a real MEMFS child, never both; that is what keeps a later lazy lookup
	// from shadowing a file PHP has since written (its setter marks it written).
	const child = (parent, name) => {
		const idx = parent.lazyIndex;
		if (!idx) return null;
		const sub = idx.dirs.get(name);
		if (sub) {
			idx.dirs.delete(name);
			const node = base.mknod(parent, name, 0o40755, 0);
			makeLazyDir(FS, node, sub, store);
			lazyStats.nodes++;
			return node;
		}
		const p = idx.files.get(name);
		if (p === undefined) return null;
		idx.files.delete(name);
		const node = base.mknod(parent, name, 0o100644, 0);
		attachLazyContents(node, lazyEntrySize(store.dv, p), (out) => lazyEntryData(store.zip, store.dv, p, out));
		lazyStats.nodes++;
		return node;
	};
	const all = (node) => {
		const idx = node.lazyIndex;
		if (!idx) return;
		for (const name of [...idx.dirs.keys(), ...idx.files.keys()]) child(node, name);
	};
	ops = {
		...base,
		lookup(parent, name) {
			return child(parent, name) || base.lookup(parent, name);
		},
		readdir(node) {
			all(node);
			return base.readdir(node);
		},
		rmdir(parent, name) {
			all(FS.lookupNode(parent, name));
			return base.rmdir(parent, name);
		},
		rename(oldNode, newDir, newName) {
			try {
				all(FS.lookupNode(newDir, newName));
			} catch {}
			return base.rename(oldNode, newDir, newName);
		},
	};
	lazyOpsCache.set(base, ops);
	isLazyOps.add(ops);
	return ops;
}
const lazyStats = { nodes: 0 };
function makeLazyDir(FS, node, index, store) {
	node.lazyIndex = index;
	if (!isLazyOps.has(node.node_ops)) node.node_ops = lazyOpsFor(node.node_ops, FS, store);
}
// Mount a whole zip's tree lazily under a MEMFS directory (default root). The
// zip's own top-level directory (e.g. "wordpress") materialises on first lookup.
function mountLazyZip(FS, mountPath, zip) {
	const store = buildZipIndex(zip);
	makeLazyDir(FS, FS.lookupPath(mountPath).node, store.root, store);
}

// One message from PHP: a D1 statement, an R2 or Images operation, a cache
// purge, or a failure report. In the Worker it comes through php.onMessage; in
// the checkout Container, through the outbound handler for worker.internal.
// Async email (issue #185): PHP's wp_mail hands the message here (the isolate has no
// mail transport). Record it fast and return so checkout never waits on the send. The
// send leg (a Queue producer, or ctx.waitUntil to the Email REST API, pending the WfP
// queue-binding decision and a verified sender domain) lands next; a consumer then
// delivers via Cloudflare Email Service.
//
// In a cron tick (tickMail set, #362, email-handoff.mjs) the op hands the message to the durable path
// and waits for that before PHP goes on, so an isolate reset later in the tick cannot lose it. A
// request still collects the messages and sends them after the response.
function emailOp(email) {
	stats.email = (stats.email || 0) + 1;
	if (tickMail) return tickMail.op(email);
	pendingEmails.push(email);
	return { ok: true, queued: true };
}

// The mail side of the cron tick that is running PHP now, or null. Set and cleared by runCron
// inside its withPhp turn, so only that tick's PHP sees it.
let tickMail = null;
// The running cron leg's record writer (#471, cron-health.mjs), set by the alarm around runCron.
let cronRunSink = null;

// A tick's handoff: one message to the durable path (sendList), bounded like the alarm drain.
// Resolves to 'bounded' when the send was still in flight at SEND_TIMEOUT_MS. storage is the PHP
// object's durable storage: the dedupe markers of #370 live there (key -> the time it was sent).
// No storage, no dedupe (a mail is never held for want of it).
function tickMailFor(env, storage) {
	const base = resetFailTotal;
	const st = storage && typeof storage.get === 'function' ? storage : null;
	return createTickMail({
		seen: st ? async (key) => (await st.get(key)) !== undefined : null,
		mark: st ? (key) => st.put(key, Date.now()) : null,
		handoff: async (email) => {
			// #1088 B: the outcome, so a send that failed into the retry store is counted (sendFailed), not just handed off.
			const sp = sendListOutcome(env, [email]);
			if (!sp) return 0;
			const r = await boundedWait(sp, SEND_TIMEOUT_MS);
			if (r === TIMED_OUT) return 'bounded';
			const o = r;
			return { sent: o.sent, sendFailed: o.failed };
		},
		lostWrites: () => resetFailTotal - base,
		log: (o) => console.log(JSON.stringify(o)),
	});
}

// Send a wp_mail message through the send_email binding (issue #185). Transactional
// mail. The From address is this site's MAIL_FROM, or wordpress@<its host> when
// that host can send (mail-from.mjs). It is not a shared WooCommerce address.
// A From the message asked for, when it is a different real address, becomes
// the Reply-To. Returns [] when the site has no sender or no binding.
function sendEmail(env, email) {
	// A demo site sends no mail (site-lock.mjs).
	if (demoLocked(env)) return [];
	const from = sender(env);
	if (!from || !env || !env.EMAIL) return [];
	const { deliverable, dropped } = deliverableRecipients(email.to);
	if (dropped) {
		stats.emailDropped = (stats.emailDropped || 0) + dropped;
		console.log('email send: ' + dropped + ' undeliverable recipient(s) dropped');
	}
	if (!deliverable.length) return [];
	const body = String(email.message || '');
	const looksHtml = /<[a-z!\/]/i.test(body) || /text\/html/i.test(String(email.headers || ''));
	const esc = (t) => t.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
	const html = looksHtml ? body : '<pre>' + esc(body) + '</pre>';
	const text = looksHtml ? body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : body;
	const subject = String(email.subject || '(no subject)');
	const msg = { to: null, from: bindingAddress(from), subject, html, text }; // #1096: the shape the binding accepts
	const rt = replyTo(from.email, email.headers);
	if (rt) msg.replyTo = bindingAddress(rt); // #1096
	// Each promise carries its recipient (#1057): a rejected one is retried for that recipient only.
	return deliverable.map((to) => Object.assign(sendTimed(() => (emailFaultRejects(env) ? Promise.reject(new Error('EMAIL_FAULT: injected rejection (#1057, a measurement)')) : env.EMAIL.send({ ...msg, to }))), { to }));
}
// #1135: every env.EMAIL.send is timed (the lead's condition for a synchronous request-path send: its live p95). A
// success logs email-sent with ms; a refusal carries pfSendMs on the rejection, which email-send-failed logs.
function sendTimed(p) {
	const t0 = Date.now();
	let pr;
	try { pr = Promise.resolve(p()); } catch (e) { pr = Promise.reject(e); }
	return pr.then(
		(r) => ((stats.emailSent = (stats.emailSent || 0) + 1), console.log(JSON.stringify({ m: 'email-sent', n: stats.emailSent, ms: Date.now() - t0 })), r),
		(e) => {
			if (e && typeof e === 'object') e.pfSendMs = Date.now() - t0;
			throw e;
		},
	);
}

// #1057 (email-retry.mjs, the lead's ruling): the durable store for rejected sends. The PHP object whose alarm drains it:
// the site object (PHP in a Durable Object: b-dosql, b-do), or approach A's "cron" object during its own leg. Set by
// the object's fetch and alarm. Anywhere else (the approach A Worker, an overflow pool object) a failure is handed to
// the cron object (MAIL_RETRY_PATH), whose alarm drains it; with no cron object it is logged as before (unavailable).
let objStorage = null;
let inCronLeg = false;
const MAIL_RETRY_PATH = '/_mail-retry';
const MAIL_RETRY_HEADER = 'x-pf-mail-retry';
function mailStoreFor(env) {
	if (!objStorage) return null;
	if (env && env.PHP_IN_DO === 'on') return objStorage;
	return inCronLeg ? objStorage : null;
}
async function mailRetryArm(storage, next) {
	if (next === null || next === undefined) return;
	const now = Date.now();
	const at = Math.max(Number(next), now + 1000);
	const cur = await storage.getAlarm();
	if (cur === null || cur === undefined || Number(cur) > at) await setAlarmRecorded(storage, at, now, 'email-retry');
}
async function mailRetryStore(storage, records) {
	let next = null;
	for (const [k, rec] of records) {
		const had = await storage.get(k);
		if (had) continue; // already queued (one record per message and recipient)
		await storage.put(k, rec);
		if (next === null || rec.next < next) next = rec.next;
	}
	await mailRetryArm(storage, next);
}
async function mailRetryPut(env, failures) {
	const records = failureRecords(failures, Date.now());
	if (!records.length) return;
	try {
		const st = mailStoreFor(env);
		if (st) return await mailRetryStore(st, records);
		if (approachACronEnabled(env) && env.PHP_RUNTIME) {
			const stub = env.PHP_RUNTIME.get(env.PHP_RUNTIME.idFromName(CRON_OBJECT_NAME));
			const res = await stub.fetch(new Request('https://do.internal' + MAIL_RETRY_PATH, { method: 'POST', headers: { [MAIL_RETRY_HEADER]: '1', 'content-type': 'application/json' }, body: JSON.stringify(records) }));
			if (res.ok) return;
			throw new Error('cron object answered ' + res.status);
		}
		console.log(JSON.stringify({ m: 'email-retry', unavailable: records.length, why: 'no durable store here (approach A needs A_CRON)' }));
	} catch (e) {
		console.log(JSON.stringify({ m: 'email-retry', unstored: records.length, error: String((e && e.message) || e).slice(0, 160) }));
	}
}
// The drain, from the object's alarm: no PHP. A retry is one message to its one recipient through sendEmail.
async function mailRetryDrain(env, storage) {
	const out = await drainRetries({
		storage,
		now: Date.now(),
		send: async (email) => {
			const ps = sendEmail(env, email);
			if (!ps.length) throw new Error('not sendable (no sender, no binding, or no deliverable recipient)');
			await ps[0];
		},
		log: (o) => console.log(JSON.stringify(o)),
	});
	await mailRetryArm(storage, out.next);
	return out;
}
async function mailDeadForHealth(env) {
	try {
		const st = env && env.PHP_IN_DO === 'on' ? objStorage : null;
		if (st) return { ok: true, dead: await mailDeadCount(st) };
		if (approachACronEnabled(env) && env.PHP_RUNTIME) {
			const stub = env.PHP_RUNTIME.get(env.PHP_RUNTIME.idFromName(CRON_OBJECT_NAME));
			const r = await stub.fetch(new Request('https://do.internal' + MAIL_RETRY_PATH + '?count=1', { headers: { [MAIL_RETRY_HEADER]: '1' } }));
			if (r.ok) return { ok: true, dead: Number((await r.json()).dead) || 0 };
		}
		return { ok: false, why: 'no durable mail store' };
	} catch (e) {
		return { ok: false, why: String((e && e.message) || e).slice(0, 120) };
	}
}
async function mailDeadCount(storage) {
	// #1062 review: only dead letters inside their expiry count (the drain prunes the rest).
	const now = Date.now();
	let n = 0;
	for (const [, d] of await storage.list({ prefix: DEAD_PREFIX, limit: 1000 })) if (!(d && Number.isFinite(d.expiresAt)) || d.expiresAt > now) n++;
	return n;
}

// Drain the queued wp_mail messages (emailOp) and send them through the send_email binding.
// Both the request path and the DO alarm call this, so the deferred WC order emails are actually
// SENT even when no request follows on a low-traffic store (#185): emailOp only enqueues into the
// pendingEmails module global, so without a drain the queued mails were lost on the next isolate
// recycle. Returns a promise resolving to the count sent, or null when nothing is queued; the
// caller waitUntil's it (request/alarm, non-blocking) or awaits it (a manual /_runcron).
function sendPending(env) {
	if (!pendingEmails.length) return null;
	const toSend = pendingEmails;
	pendingEmails = [];
	return sendList(env, toSend);
}

// The domain of a recipient address, for a log line (never the whole address: #1062's privacy rule).
function domainOfAddress(to) {
	const s = String(to || '');
	const at = s.lastIndexOf('@');
	return at > 0 ? s.slice(at + 1).replace(/[>\s].*$/, '').toLowerCase().slice(0, 100) : null;
}
// Send a list of wp_mail messages: to the durable queue when it is on (#190), else straight
// through the send_email binding. Returns a promise of { sent, failed }, or null for an empty list.
function sendListOutcome(env, toSend) {
	if (!toSend.length) return null;
	if (!env || !env.EMAIL || !sender(env)) {
		console.log('email send: ' + toSend.length + ' dropped, MAIL_FROM or the send_email binding is not set');
		return Promise.resolve({ sent: 0, failed: 0 });
	}
	// Durable path (#190): hand the drain to the queue; the consumer delivers with retry.
	if (emailQueueEnabled(env)) return enqueueEmails(env, toSend).then((n) => ({ sent: n, failed: 0 }));
	const items = toSend.flatMap((e) => sendEmail(env, e).map((p) => ({ e, p })));
	return Promise.allSettled(items.map((x) => x.p)).then(async (rs) => {
		const failures = [];
		rs.forEach((x, i) => {
			if (x.status === 'rejected') failures.push({ email: items[i].e, to: items[i].p.to, error: String((x.reason && x.reason.message) || x.reason), ms: x.reason && Number.isFinite(x.reason.pfSendMs) ? x.reason.pfSendMs : null });
		});
		if (failures.length) {
			console.log('email send: ' + failures.length + ' of ' + rs.length + ' failed');
			// #1088 B (#104, #856): each refused send is logged loudly WITH its reason (addresses and URLs scrubbed) and the
			// recipient's domain only.
			for (const f of failures) console.log(JSON.stringify({ '@event': 'email-send-failed', m: 'email-send-failed', reason: scrub(f.error), domain: domainOfAddress(f.to), ms: f.ms, retry: 'queued' }));
			await mailRetryPut(env, failures); // #1057: retried with backoff, never dropped
		}
		return { sent: rs.length - failures.length, failed: failures.length };
	});
}
// The sent count only (the request path's flush).
function sendList(env, toSend) {
	const p = sendListOutcome(env, toSend);
	return p ? p.then((o) => o.sent) : null;
}

// Producer: hand the drained wp_mail messages to the durable queue (#190). The
// consumer (the queue() export) delivers them with retry + backoff + dead-letter.
// On a queue outage, fall back to a best-effort direct send so a transient Queues
// failure does not lose the mail; the fallback is the v1 path.
async function enqueueEmails(env, emails) {
	try {
		for (const chunk of chunkBatch(emails, 100)) {
			await env.EMAIL_QUEUE.sendBatch(chunk.map((body) => ({ body })));
		}
		stats.emailQueued = (stats.emailQueued || 0) + emails.length;
		return emails.length;
	} catch (e) {
		console.log('email queue: enqueue failed (' + String((e && e.message) || e).slice(0, 120) + '), direct send fallback');
		const rs = await Promise.allSettled(emails.flatMap((em) => sendEmail(env, em)));
		return rs.filter((x) => x.status === 'fulfilled').length;
	}
}

// Consumer: deliver one queued wp_mail message. Ack on success (or when there is
// nothing deliverable), retry with backoff on a send failure. After the consumer's
// max_retries the runtime routes the message to the dead-letter queue (#190). The
// ack/retry/backoff control flow is handleQueuedEmail (email-queue.mjs), unit-tested.
async function deliverQueuedEmail(msg, env) {
	return handleQueuedEmail(
		msg,
		async (email) => {
			if (!env || !env.EMAIL || !sender(env)) return { attempted: 0, failed: 0 };
			const results = sendEmail(env, email);
			if (!results.length) return { attempted: 0, failed: 0 };
			const rs = await Promise.allSettled(results);
			const failed = rs.filter((x) => x.status === 'rejected').length;
			if (failed) stats.emailQueueFailed = (stats.emailQueueFailed || 0) + 1;
			else stats.emailQueueSent = (stats.emailQueueSent || 0) + rs.length;
			return { attempted: rs.length, failed };
		},
		{ onRetry: (delaySeconds) => console.log(JSON.stringify({ m: 'email-queue-retry', attempts: msg.attempts, delaySeconds })) }
	);
}

// A dead-lettered message has exhausted its retries. Log and meter it for operator
// visibility, then ack so it does not loop.
function deadLetterEmail(msg) {
	stats.emailDead = (stats.emailDead || 0) + 1;
	const to = msg.body && msg.body.to;
	// A recipient count, never an address: Workers Logs is not a mail log.
	console.log(JSON.stringify({ m: 'email-dead-letter', recipients: (Array.isArray(to) ? to : [to]).filter(Boolean).length, subject: String((msg.body && msg.body.subject) || '').slice(0, 80) || null }));
	msg.ack();
}

// The queue() consumer. One handler serves both the email queue and its dead-letter
// queue (the "-dlq" suffix). b-dosql only; harmless when no consumer is configured,
// since the runtime never calls it then.
async function consumeEmailQueue(batch, env) {
	ENV = env;
	if (isDeadLetterQueue(batch && batch.queue)) {
		for (const msg of batch.messages) deadLetterEmail(msg);
		return;
	}
	for (const msg of batch.messages) await deliverQueuedEmail(msg, env);
}

// Caption an uploaded image for alt text (php/ai-alt-text.php). PHP sends the
// public URL and the R2 key of a rendition that has no alt text; the Worker asks
// the AI binding for a one-line description and returns it. Fail safe: any error
// or timeout returns ok:true with a degraded reason and no alt, so the upload is
// never blocked.
// Model: box-tested 2026-11-08 on a live b-dosql deploy. @cf/llava-hf/llava-1.5-7b-hf
// with the bytes+prompt input returns { description }; @cf/moondream/moondream3.1-9B-A2B
// returned {} for every input shape tried (URL, base64 caption, base64 prompt) and
// @cf/unum/uform-gen2-qwen-500m is 410-deprecated, so llava-hf is the only working
// image-to-text model on the account. NOTE: its model page shows a planned deprecation
// of 2026-11-20; when Cloudflare retires it, repoint AI_ALT_MODEL (the feature degrades
// safely to empty alt until then, never blocking an upload).
// Memory (issue #189): the op fires AFTER the attachment is stored (off the insert
// critical path) and reads only the small RENDITION the plugin chose, not the original,
// so the byte array is a few hundred KB on an isolate at ~mib 58 (media-write-trim
// wcskips WooCommerce on the upload request). Ample headroom.
// Billing: Workers AI runs on Unified Billing (the Cloudflare credit balance). An
// AI Gateway wrapper (caching, rate limits, analytics) could sit in front later;
// this uses the direct env.AI binding to start.
const AI_ALT_DEFAULT_MODEL = '@cf/llava-hf/llava-1.5-7b-hf';
function captionLength() {
	return ENV.AI_ALT_LENGTH === 'normal' || ENV.AI_ALT_LENGTH === 'long' ? ENV.AI_ALT_LENGTH : 'short';
}
// Tidy a model caption into alt text: one line, no wrapping quotes, no boilerplate
// opener ("This image shows ...", "A photo of ..."), capped at a sane length on a
// word boundary. WordPress sanitizes it again before it is stored.
function cleanAlt(text, cap) {
	let s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
	s = s.replace(/^["'“”]+|["'“”]+$/g, '').trim();
	s = s.replace(/^(the|this|an?)\s+(image|picture|photo|photograph)\s+(of|showing|shows|depicting|depicts|is of|is|featuring|features|containing|contains|portraying|portrays)\s+/i, '');
	s = s.replace(/^(image|picture|photo|photograph)\s+of\s+/i, '');
	s = s.replace(/^in\s+(this|the)\s+(image|picture|photo|photograph)\s*,?\s+/i, '');
	if (!s) return s;
	s = s.charAt(0).toUpperCase() + s.slice(1);
	if (s.length > cap) {
		s = s.slice(0, cap);
		const sp = s.lastIndexOf(' ');
		if (sp > cap * 0.6) s = s.slice(0, sp);
		s = s.replace(/[\s,;:.\-]+$/, '');
	}
	return s;
}
async function aiAltOp(op) {
	const t0 = Date.now();
	stats.ai = stats.ai || { n: 0, ms: 0, ok: 0, fail: 0 };
	stats.ai.n++;
	const done = (r) => {
		stats.ai.ms += Date.now() - t0;
		if (r && r.alt) stats.ai.ok++;
		else stats.ai.fail++;
		return r;
	};
	try {
		if (!ENV.AI) return done({ ok: true, degraded: 'no AI binding' });
		const model = typeof ENV.AI_ALT_MODEL === 'string' && ENV.AI_ALT_MODEL ? ENV.AI_ALT_MODEL : AI_ALT_DEFAULT_MODEL;
		const flavor = ENV.AI_ALT_INPUT === 'caption' ? 'caption' : 'prompt';
		const cap = Math.max(16, Math.min(300, Number(ENV.AI_ALT_MAX_CHARS || 160)));
		const timeoutMs = Math.max(1000, Math.min(60000, Number(ENV.AI_ALT_TIMEOUT_MS || 12000)));

		// Build the model input. prompt flavor (default; llava/llama): image is an array
		// of bytes from the rendition with a text prompt, returning { description } or
		// { response }. caption flavor (opt-in AI_ALT_INPUT=caption, for a caption model
		// that supports it): image is a public URL or base64 data URI with task "caption",
		// returning { caption }; the URL path reads no bytes into the isolate.
		let input;
		if (flavor === 'caption' && op.url) {
			input = { image: op.url, task: 'caption', caption_length: captionLength() };
		} else {
			if (!op.key || !ENV.MEDIA) return done({ ok: true, degraded: 'no image source' });
			const o = await ENV.MEDIA.get(op.key);
			if (!o) return done({ ok: true, degraded: 'image not found' });
			const bytes = new Uint8Array(await o.arrayBuffer());
			if (flavor === 'caption') {
				const mime = op.mime || (o.httpMetadata && o.httpMetadata.contentType) || 'image/jpeg';
				input = { image: 'data:' + mime + ';base64,' + b64encode(bytes), task: 'caption', caption_length: captionLength() };
			} else {
				const prompt = typeof ENV.AI_ALT_PROMPT === 'string' && ENV.AI_ALT_PROMPT ? ENV.AI_ALT_PROMPT : 'Describe this image in one short, factual sentence for use as alt text. Do not begin with "an image of" or "a picture of".';
				input = { image: [...bytes], prompt, max_tokens: 128 };
			}
		}

		const timeout = new Promise((resolve) => setTimeout(() => resolve({ __timeout: true }), timeoutMs));
		const r = await Promise.race([ENV.AI.run(model, input), timeout]);
		if (r && r.__timeout) return done({ ok: true, degraded: 'ai timeout' });
		const raw = r && (r.caption != null ? r.caption : r.description != null ? r.description : r.response != null ? r.response : r.text != null ? r.text : typeof r === 'string' ? r : '');
		const alt = cleanAlt(raw, cap);
		if (!alt) return done({ ok: true, degraded: 'empty caption' });
		return done({ ok: true, alt });
	} catch (e) {
		return done({ ok: true, degraded: String(e && e.message ? e.message : e).slice(0, 200) });
	}
}

async function purgeZoneOp(op) {
	const t0 = Date.now();
	stats.purgeZone = stats.purgeZone || { n: 0, ms: 0, ok: 0, fail: 0 };
	stats.purgeZone.n++;
	const done = (r) => {
		stats.purgeZone.ms += Date.now() - t0;
		if (r && r.purged) stats.purgeZone.ok++;
		else stats.purgeZone.fail++;
		return r;
	};
	try {
		// The token and zone stay in the Worker (like the AI binding): PHP sends
		// only the URLs. No binding means the gate should not have injected the
		// define, so this is belt and braces.
		if (!ENV.PURGE_TOKEN || !ENV.PURGE_ZONE) return done({ ok: true, degraded: 'no purge binding' });
		// A purge covers this site's own host only (purge-zone.mjs), never the zone.
		const body = purgeZoneBody(op, ownPurgeHost(ENV.SITE_ORIGIN));
		if (!body) return done({ ok: true, degraded: 'nothing to purge' });
		const timeoutMs = Math.max(1000, Math.min(30000, Number(ENV.PURGE_TIMEOUT_MS || 10000)));
		const timeout = new Promise((resolve) => setTimeout(() => resolve({ __timeout: true }), timeoutMs));
		const r = await Promise.race([
			fetch(cfPurgeEndpoint(ENV.PURGE_ZONE), {
				method: 'POST',
				headers: { authorization: `Bearer ${ENV.PURGE_TOKEN}`, 'content-type': 'application/json' },
				body: JSON.stringify(body),
			}),
			timeout,
		]);
		if (r && r.__timeout) return done({ ok: true, degraded: 'purge timeout' });
		let j = null;
		try { j = await r.json(); } catch (_) {}
		const purged = !!(r && r.ok && j && j.success);
		// One line per purge sent, so a run can count them (wrangler tail). The
		// token is never logged.
		console.log(JSON.stringify({ m: 'purge_zone', sent: 1, host: !!body.hosts, files: body.files ? body.files.length : 0, status: r ? r.status : 0, ok: purged, errors: (j && j.errors) || [] }));
		return done({ ok: true, purged, status: r ? r.status : 0, errors: (j && j.errors) || [] });
	} catch (e) {
		return done({ ok: true, degraded: String(e && e.message ? e.message : e).slice(0, 200) });
	}
}

// Render an order to a PDF invoice (issue #227). Build the HTML with renderOpPlan,
// render it with the Browser Rendering binding, store the PDF in the MEDIA bucket under
// a private invoices/ prefix, and return a signed, expiring download URL. The signing
// secret (INVOICE_TOKEN) stays in the Worker; PHP relays the URL and never sees it, as
// with the AI binding and the purge token. Fail safe: any failure returns
// { ok: true, degraded } and the order is untouched.
async function browserRenderOp(op) {
	const t0 = Date.now();
	stats.browserRender = stats.browserRender || { n: 0, ms: 0, ok: 0, fail: 0 };
	stats.browserRender.n++;
	const done = (r) => {
		stats.browserRender.ms += Date.now() - t0;
		if (r && r.url) stats.browserRender.ok++;
		else stats.browserRender.fail++;
		return r;
	};
	try {
		if (!ENV.BROWSER || !ENV.MEDIA) return done({ ok: true, degraded: 'no browser binding' });
		const plan = renderOpPlan(op);
		if (!plan.ok) return done({ ok: true, degraded: plan.error });
		const key = invoiceKey(plan.orderId, bytesToHex(crypto.getRandomValues(new Uint8Array(16))));
		const timeoutMs = Math.max(2000, Math.min(60000, Number(ENV.PDF_INVOICE_TIMEOUT_MS || 20000)));
		let bytes;
		try {
			// Dynamic import so index.js still loads where @cloudflare/puppeteer is not
			// installed (local dev, the pure-helper tests); the real render needs the Browser
			// Rendering binding on a Paid deploy.
			const puppeteer = (await import('@cloudflare/puppeteer')).default;
			const render = (async () => {
				const browser = await puppeteer.launch(ENV.BROWSER);
				try {
					const page = await browser.newPage();
					await page.setContent(plan.html, { waitUntil: 'load' });
					return await page.pdf({ format: 'A4', printBackground: true });
				} finally {
					await browser.close();
				}
			})();
			const timeout = new Promise((resolve) => setTimeout(() => resolve({ __timeout: true }), timeoutMs));
			const r = await Promise.race([render, timeout]);
			if (r && r.__timeout) return done({ ok: true, degraded: 'render timeout' });
			bytes = r instanceof Uint8Array ? r : new Uint8Array(r);
		} catch (e) {
			return done({ ok: true, degraded: 'render: ' + String(e && e.message ? e.message : e).slice(0, 160) });
		}
		await ENV.MEDIA.put(key, bytes, { httpMetadata: { contentType: plan.contentType } });
		// Signed, expiring download URL. Without INVOICE_TOKEN the PDF is stored but no link
		// is minted, so PHP surfaces nothing (fail safe).
		let downloadUrl = null;
		if (ENV.INVOICE_TOKEN) {
			const ttl = Math.max(300, Math.min(31536000, Number(ENV.INVOICE_URL_TTL || 604800)));
			const exp = Math.floor(Date.now() / 1000) + ttl;
			const sig = await signDownload(ENV.INVOICE_TOKEN, key, exp);
			downloadUrl = invoiceDownloadPath(key, exp, sig);
		}
		console.log(JSON.stringify({ m: 'browser_render', kind: 'invoice', bytes: bytes.length, stored: true, signed: !!downloadUrl }));
		return done({ ok: true, key, url: downloadUrl, bytes: bytes.length });
	} catch (e) {
		return done({ ok: true, degraded: String(e && e.message ? e.message : e).slice(0, 200) });
	}
}


// Verify a Turnstile token for a gated form (php/turnstile-forms.php, issue #250).
// PHP reads the token from the form POST (or the Store API extension) and sends it here; the
// secret (TURNSTILE_SECRET) stays in the Worker and PHP never sees it. The browser never calls
// siteverify.
//   - success:true  only when Cloudflare returned success:true for this token.
//   - success:false with error set means the verifier was unreachable (a timeout or a network
//     failure); PHP shows it as an outage, and a login or a checkout is still refused.
//   - success:false with no error is a missing, bad, spent or unverified token.
// In the object (PHP_IN_DO=on), the op never fetches and never waits (#351): the front Worker
// verified the request before it reached the object (preverifyTurnstile), and the op answers from
// that result (turnstileSlot), once, for the same token. A verify from inside the object waited
// at the output gate for the writes the request had made, and an isolate reset in that wait lost
// them. With PHP in the Worker there is no output gate, so the op verifies itself.
const turnstileSlot = new TurnstileSlot();
async function turnstileOp(op) {
	const t0 = Date.now();
	stats.turnstile = stats.turnstile || { n: 0, ms: 0, ok: 0, fail: 0 };
	stats.turnstile.n++;
	const done = (r) => {
		stats.turnstile.ms += Date.now() - t0;
		if (r && r.success) stats.turnstile.ok++;
		else stats.turnstile.fail++;
		return r;
	};
	try {
		// No secret means the gate should not have injected the define, so this is
		// belt and braces: fail closed (the form is rejected), never open.
		if (!ENV.TURNSTILE_SECRET) return done({ ok: true, success: false, error: 'no turnstile secret' });
		let res;
		if (ENV.PHP_IN_DO === 'on') {
			res = turnstileSlot.take(op && op.token);
		} else {
			res = await verifyToken(ENV.TURNSTILE_SECRET, op && op.token, op && op.remoteip, {
				timeoutMs: turnstileTimeoutMs(ENV),
				expect: { hostname: siteHost(ENV.SITE_ORIGIN), action: TURNSTILE_ACTION },
			});
		}
		// The token and the secret are never logged; only the outcome and the codes.
		console.log(JSON.stringify({ m: 'turnstile', where: ENV.PHP_IN_DO === 'on' ? 'object' : 'worker', success: res.success, codes: res.codes || [], error: res.error, tries: res.tries, ms: Date.now() - t0 }));
		return done({ ok: true, success: res.success, codes: res.codes || [], error: res.error });
	} catch (e) {
		return done({ ok: true, success: false, error: String(e && e.message ? e.message : e).slice(0, 200) });
	}
}

// Record one anonymized pageview (php/analytics-pageview.php, issue #201). PHP
// sends the request facts (host, path, status, country); the Worker holds the
// Analytics Engine dataset binding and does the writeDataPoint, so PHP never sees
// the binding, as with the AI binding and the purge token. Fire and forget:
// writeDataPoint returns void, so the op does not await it. Fail safe: no binding
// or any error returns { ok: true, degraded } and nothing is recorded; the
// pageview is never on the render critical path (PHP sends it on shutdown).
function analyticsOp(op) {
	const t0 = Date.now();
	stats.analytics = stats.analytics || { n: 0, ms: 0, ok: 0, fail: 0 };
	stats.analytics.n++;
	const done = (r) => {
		stats.analytics.ms += Date.now() - t0;
		if (r && r.recorded) stats.analytics.ok++;
		else stats.analytics.fail++;
		return r;
	};
	try {
		// No binding means the gate should not have injected the define, so this is
		// belt and braces: record nothing, never throw.
		if (!ENV.ANALYTICS) return done({ ok: true, degraded: 'no analytics binding' });
		recordPageview(ENV.ANALYTICS, op);
		return done({ ok: true, recorded: true });
	} catch (e) {
		return done({ ok: true, degraded: String(e && e.message ? e.message : e).slice(0, 200) });
	}
}

async function handleMessage(raw) {
	phpLock.progress(); // #1060: the running PHP run is working (slow is not stuck)
	// #452: a message that is not a JSON object is refused with an error PHP can read, never a throw.
	// Only its length is logged: the content may be anything PHP sent.
	const parsed = parseMessage(raw);
	if (!parsed.ok) {
		console.log(JSON.stringify({ m: 'message', refused: parsed.error, bytes: typeof raw === 'string' ? raw.length : null }));
		return JSON.stringify({ ok: false, error: parsed.error });
	}
	const m = parsed.m;
	if (m.http) return JSON.stringify(await httpOp(m.http));
	if (m.txn) return JSON.stringify(sqlDb ? txnOp(sqlDb, sqlStorage, m.txn) : { ok: false, error: 'no database in the object' });
	// #780: the whole database's size for SHOW TABLE STATUS (php/table-status-size.php). A Durable Object's SQLite
	// reports only that (no dbstat, no PRAGMA page_count). Without the object's database: no size.
	if (m.dbSize) return JSON.stringify(sqlDb ? { ok: true, bytes: sqlDb.databaseSize } : { ok: false, error: 'no database in the object' });
	if (m.oc) return JSON.stringify(await objectCacheOp(m.oc));
	if (m.mailDead) return JSON.stringify(await mailDeadForHealth(ENV)); // #1057: Site Health
	if (m.probeMem) return JSON.stringify({ wasm: lastBootedPhp ? lastBootedPhp[__private__dont__use].HEAPU8.length : null });
	if (m.memTrace) { lastMemTrace = m.memTrace; return '1'; }
	// #471: the job a cron leg is about to run (sent BEFORE it runs), and PHP's own fatal error. Logged
	// at once, so a leg the isolate kills still says what it was doing; also kept in the run record.
	if (m.cronMark) {
		const mk = cronMarkOf(m.cronMark);
		console.log(JSON.stringify({ m: 'cron', mark: 'start', ...mk }));
		if (cronRunSink) await cronRunSink({ lastMark: { t: Date.now(), ...mk } });
		return '1';
	}
	if (m.cronFatal) {
		const f = cronFatalOf(m.cronFatal);
		console.log(JSON.stringify({ m: 'cron', fatal: 'php', ...f }));
		if (cronRunSink) await cronRunSink({ lastFatal: { t: Date.now(), ...f } });
		return '1';
	}
	// One trace checkpoint as it happens (#434), so a request killed by an isolate reset still
	// leaves its marks in Workers Logs. Names and numbers only; mem-trace.php runs only for an
	// operator request.
	// #1120: the cron leg asks before each further Action Scheduler action: '1' runs it, 'budget' or 'heap' stops the leg.
	if (m.cronMore !== undefined) { const why = cronMoreGate ? cronMoreGate() : 'stop'; return why || '1'; }
	if (m.qtraceOn) return qtrace ? '1' : '0'; // #296 step 3: PHP asks once per request whether to send callers
	if (m.memMark) { console.log(JSON.stringify({ m: 'mem-mark', ...(typeof m.id === 'string' && MEM_ID_RE.test(m.id) ? { id: m.id } : {}), k: m.memMark })); return '1'; }
	if (m.r2) return JSON.stringify(await r2op(m.r2));
	if (m.email) return JSON.stringify(await emailOp(m.email));
	if (m.emailDue) { emailDueRequest = true; return '1'; }
	if (m.aiAlt) return JSON.stringify(await aiAltOp(m.aiAlt));
	if (m.aiEmbed) return JSON.stringify(await aiEmbedOp(ENV && ENV.AI, m.aiEmbed));
	if (m.vectorize) return JSON.stringify(await vectorizeOp(ENV && ENV.SEARCH_INDEX, m.vectorize));
	if (m.turnstile) return JSON.stringify(await turnstileOp(m.turnstile));
	if (m.analytics) return JSON.stringify(analyticsOp(m.analytics));
	if (m.purgeZone) return JSON.stringify(await purgeZoneOp(m.purgeZone));
	if (m.browserRender) return JSON.stringify(await browserRenderOp(m.browserRender));
	if (m.cache === 'purge') {
		purgeRequested = true;
		// #704: why edge-cache.php asked (a hook and a name only), once per distinct reason in a request.
		if (m.why) console.log(JSON.stringify({ m: 'purge-why', why: String(m.why).slice(0, 120) }));
		return '{}';
	}
	if (dbHandler && (m.mysql !== undefined || m.mysql_b64 !== undefined)) {
		const t = Date.now();
		stats.calls++;
		if (m.mysql !== undefined) countTable(String(m.mysql));
		const reply = await dbHandler.query(ENV, m);
		stats.ms += Date.now() - t;
		if (qtrace && m.mysql !== undefined) qtrace.add(String(m.mysql), Date.now() - t, typeof m.c === 'string' ? m.c : undefined);
		const sql = String(m.mysql !== undefined ? m.mysql : '(binary SQL)');
		if (reply.ok) stats.log.push('ok  ' + sql.slice(0, 160).replace(/\s+/g, ' '));
		else {
			noteFailure({ sql: sql.slice(0, 400), error: reply.error });
			stats.log.push('ERR ' + sql.slice(0, 160).replace(/\s+/g, ' ') + ' => ' + String(reply.error).slice(0, 120));
		}
		return JSON.stringify(reply);
	}
	if (m.report) {
		noteFailure({ sql: m.sql.slice(0, 400), error: m.error });
		stats.log.push('ERR ' + m.sql.slice(0, 160).replace(/\s+/g, ' ') + ' => ' + m.error.slice(0, 120));
		return '{}';
	}
	if (sqlDb) {
		const reply = sqlStatement(sqlDb, m);
		const out = JSON.stringify(reply);
		if (ledgerActive) {
			sqlMeter.add(out.length);
			// #394: the write that hits the isolate limit. One snapshot per request, before PHP goes on.
			if (reply && reply.ok === false && MEMORY_RESET.test(String(reply.error || '')) && !ledgerFailLogged) {
				ledgerFailLogged = true;
				ledgerLog('sql-memory-fail', { sql1: sqlShape(String(m.sql || '')) });
			}
		}
		return out;
	}
	// DB_IN_DO: the object's own SQLite is the only database; there is no D1 binding on a
	// b-dosql deploy. If a DB statement arrives with sqlDb unbound (null) we must NOT fall
	// through to ENV.DB below: ENV.DB is undefined there, so that path throws deep in the
	// driver and surfaces to the client as "Cannot escape data without an active database
	// connection" (issue #208). Fail loud and specific instead, so a future unbound path is
	// visible at once rather than masquerading as a connection fault.
	if ((m.sql !== undefined || m.mysql !== undefined || m.mysql_b64 !== undefined) && ENV && ENV.DB_IN_DO === 'on')
		return JSON.stringify({ ok: false, error: 'DB_IN_DO: object SQLite not bound (sqlDb is null) for this PHP execution' });
	const t = Date.now();
	stats.calls++;
	try {
		// A BLOB does not survive JSON. PHP sends a string that is not UTF-8 as
		// {"$b": base64}; bind it as bytes. D1 returns a BLOB as an array of
		// numbers or an ArrayBuffer; send it back to PHP as {"$b": base64}.
		// (Found 2026-11-05: Wordfence stores its settings in a BLOB column and
		// read them back as a PHP array, a fatal error on activation.)
		const params = (m.params || []).map((v) => (v && typeof v === 'object' && typeof v.$b === 'string' ? b64decode(v.$b).buffer : v));
		const stmt = ENV.DB.prepare(m.sql).bind(...params);
		const returnsRows = /^\s*(SELECT|PRAGMA|WITH|VALUES|EXPLAIN)\b/i.test(m.sql) || /\bRETURNING\b/i.test(m.sql);
		let reply;
		if (returnsRows) {
			const [columns, ...rows] = await stmt.raw({ columnNames: true });
			let blob = false;
			for (const row of rows)
				for (let i = 0; i < row.length; i++) {
					const v = row[i];
					if (v === null || typeof v !== 'object') continue;
					const bytes = v instanceof ArrayBuffer ? new Uint8Array(v) : ArrayBuffer.isView(v) ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : Uint8Array.from(v);
					row[i] = { $b: b64encode(bytes) };
					blob = true;
				}
			reply = { ok: true, columns: columns || [], rows, changes: 0, last_row_id: 0, blob };
		} else {
			const r = await stmt.run();
			reply = { ok: true, columns: [], rows: [], changes: r.meta.changes || 0, last_row_id: r.meta.last_row_id || 0 };
		}
		stats.ms += Date.now() - t;
		stats.log.push('ok  ' + m.sql.slice(0, 160).replace(/\s+/g, ' '));
		return JSON.stringify(reply);
	} catch (e) {
		stats.ms += Date.now() - t;
		const error = String((e && e.message) || e);
		noteFailure({ sql: m.sql.slice(0, 400), error });
		stats.log.push('ERR ' + m.sql.slice(0, 160).replace(/\s+/g, ' ') + ' => ' + error.slice(0, 120));
		return JSON.stringify({ ok: false, error });
	}
}

// #598 part 2 (BOOT_GATE=on, default off; boot-gate.mjs): a boot never starts beside retired memory that, with what
// this boot is expected to reach, passes the budget. It decides ONCE and never waits: the retired memory is not
// collected on any useful timescale (#598, 2026-11-15). A spare the boot will reuse is not retired memory, it is the
// new runtime's: it is the floor of the expected size instead. The ledger's WeakRefs read what is still alive; no
// runtime is current while a boot starts, so every live memory counts. A refusal throws BootRefused: the request
// path answers the known 503, a cron leg is deferred.
let gateDecisions = 0; // #705: each gate decision's serial, sent on a refusal (x-runtime-wait-decision)
const gateClock = createGateClock(); // #705 second review, finding 1: how long refusals have lasted
function bootGate() {
	const gate = gateSettings(ENV);
	if (!gate.on) return;
	const r = ledger.runtimes(-1, heapOf);
	const d = { ...decide(Math.max(0, r.retiredMemMiB - spare.mib), gate, spare.mib, gateClock.refusingForMs()), decision: ++gateDecisions };
	if (d.boot) gateClock.booted();
	else gateClock.refused();
	console.log(JSON.stringify({ m: d.boot ? 'boot-gate' : 'boot-refused', ...d, spareMiB: spare.mib, ...(gate.refused.length ? { settingsRefused: gate.refused } : {}) }));
	if (!d.boot) throw new BootRefused(d);
}
// #724 review, finding 4: a superseded boot's callers get the current boot of THEIR origin: never a runtime booted for
// another origin (a request for another origin drops and boots, as handle() does).
function handOff(origin) {
	if (bootPromise && bootOrigin !== origin) dropRuntimeIdle();
	return (bootPromise ??= boot(origin));
}
let instantiating = null; // #724 review, finding 4: the boot between its spare take and the end of instantiation
async function boot(origin) {
	// #603 (B): this boot's generation and origin are captured SYNCHRONOUSLY, before any await: a request that
	// arrives during the waits below sees this origin (no second runtime for a stale one), and a drop during them
	// is seen by the check after them.
	const gen = bootGen; // #566: a drop during this boot makes it superseded (before instantiation) or an orphan (after)
	bootOrigin = origin;
	// #724 review, finding 3: the waits below exist only for reuse and the gate; with both off, boot() runs as main
	// (no added await).
	if (reuseActive() || gateSettings(ENV).on) {
		// One turn, so the caller's bootPromise ??= boot() holds THIS promise when the gate decides (#705 finding 3).
		await null;
		// #724 review, finding 4: a boot still instantiating (it may hold the spare) finishes first; if a drop
		// superseded it, its memory comes back as the offer, which this boot then takes.
		while (instantiating) await instantiating;
		// A spare still being offered (its runtime's exit handlers settle in a microtask): wait for it, bounded. If
		// it is late, this boot goes without it, and the late offer is refused (a newer runtime then exists).
		await spare.waitPending(PENDING_OFFER_MS);
		// #603 (B) test seam: BOOT_TEST_DELAY_MS lengthens the wait, so a drop can land in it (boot-race-e2e.sh)
		if (bootTestDelayMs(ENV) && bootTestDelayAt(ENV) === 'wait') await new Promise((ok) => setTimeout(ok, bootTestDelayMs(ENV)));
		// #603 (B): a drop during the waits superseded this boot. It instantiates nothing and hands off to the
		// current boot of ITS origin, so a superseded boot never runs beside a newer runtime.
		if (gen !== bootGen) {
			console.log(JSON.stringify({ m: 'boot-superseded', at: 'wait' }));
			return handOff(origin);
		}
	}
	// From the check above to here nothing awaits, so bootPromise is still THIS boot's promise: a refusal drops it.
	try {
		bootGate();
	} catch (e) {
		dropRuntime();
		throw e;
	}
	// #598 / #603: the retired runtime's memory, zeroed, when one was kept (PHP_MEMORY_REUSE=on); else null and the
	// loader imports a new memory of the module's own limits.
	const reuse = reuseActive() ? spare.take() : null;
	if (reuse) console.log(JSON.stringify({ m: 'mem-reuse', taken: LEDGER_MIB(reuse.buffer.byteLength) }));
	// The origin is WP_HOME for this runtime: log it, so a wrong one is visible.
	console.log(JSON.stringify({ m: 'boot', origin }));
	runtimeSerial++;
	const serial = runtimeSerial; // this runtime's serial (the drop serial if a drop supersedes it, finding 4)
	runtimeServed = 0;
	runtimeBootAt = Date.now();
	// #724 review, finding 4: from the take to the end of instantiation, a later boot waits for this one
	let instDone;
	const inst0 = reuseActive() ? new Promise((ok) => { instDone = ok; }) : null;
	if (inst0) instantiating = inst0;
	const instEnd = () => { if (inst0) { if (instantiating === inst0) instantiating = null; instDone(); } };
	// #724 review, finding 4, test seam: BOOT_TEST_DELAY_AT=instantiate waits here, after the spare was taken
	if (bootTestDelayMs(ENV) && bootTestDelayAt(ENV) === 'instantiate') await new Promise((ok) => setTimeout(ok, bootTestDelayMs(ENV)));
	const t0 = Date.now();
	let instMemory = null; // #724 review, finding 5: this boot's memory, a local (instantiateWasm sets it)
	const id = await loadPHPRuntime(loader, {
		// PHP_ENV (JSON) sets process environment for PHP, e.g. USE_ZEND_ALLOC.
		ENV: JSON.parse(ENV.PHP_ENV || '{"USE_ZEND_ALLOC":"0"}'),
		instantiateWasm(imports, done) {
			const inst = new WebAssembly.Instance(wasmModule, imports);
			instMemory = inst.exports.memory || null; // #394: the ledger tracks this runtime's real memory (a local, finding 5)
			done(inst, wasmModule);
			return inst.exports;
		},
		// #452: PHP's raw sockets (fsockopen, stream_socket_client) are refused: SOCKFS would turn them
		// into an outbound WebSocket that php-wasm cannot poll in workerd, and the documented contract
		// is that outbound traffic goes through the WordPress HTTP API and its host allowlist.
		websocket: { decorator: refuseSocketsDecorator((info) => console.log(JSON.stringify({ m: 'socket', refused: info }))) },
		// #563: only on an OPCACHE_REMOTE build. Without it the loader does not wrap open() at all.
		...(remoteOn() || SITE_REMOTE ? { pagefeatherOpen: remoteOpenHook } : {}),
		// #569: only on a SITE_REMOTE build. Without it no read path is wrapped at all.
		...(SITE_REMOTE ? { pagefeatherRead: remoteReadHook } : {}),
		// #598 / #603: prepare.sh makes the engine import its memory; the loader takes this one when set.
		...(reuse ? { pagefeatherMemory: reuse } : {}),
		// #603: the loader installs its reuse guards (the in-flight count, the retired refusals) only for a reuse
		// runtime; every other runtime runs the upstream wrappers.
		...(reuseActive() ? { pagefeatherReuse: true } : {}),
	});
	const php = new PHP(id);
	// #761: php-wasm copies Authorization onto HTTP_AUTHORIZATION only. Apache with
	// mod_php also sets PHP_AUTH_USER and PHP_AUTH_PW. One install covers the object
	// and approach A's Worker: both run this runtime.
	installPhpBasicAuth(php);
	lastBootedPhp = php;
	runtimeBootBytes = php[__private__dont__use].HEAPU8.length; // #603 (A): what this runtime starts from
	if (instMemory) memOf.set(php, instMemory); // #598: the memory the spare keeps at release
	ledger.register(php, serial, instMemory); // #394: retired runtimes stay countable while alive, with their real memory
	// php.ini overrides. PHP_INI (a JSON object) lets a deploy or a test change them.
	// A deploy (WP_SALT is set) never prints PHP errors, even for a script that
	// does not load wp-config.php (measured 2026-11-04: /wp-content/db.php did).
	const deployIni = ENV.WP_SALT ? { display_errors: '0', display_startup_errors: '0' } : {};
	// OPcache. Measured 2026-11-04: it cached nothing until these were set.
	// - file_update_protection=0: OPcache skips a file changed in the last 2 s.
	//   Files are written at boot and the Worker clock barely moves, so every
	//   file looked new.
	// - validate_timestamps=0: scripts never change within a deploy, and the
	//   shipped file cache is older than the files unzipped at boot.
	// - shared memory for warm requests, the file cache (shipped by opcache.sh)
	//   for a cold isolate. Warm page locally: 220 ms -> 100 ms.
	// - memory_consumption 48 (#394), was 32. At 32 the shared memory was FULL on
	//   a WooCommerce store (2,584 bytes free, 776 scripts), so every warm request
	//   reloaded about 700 scripts from the file cache (21.3 MiB inflated). On the
	//   2,609-product sample store (pf394a, 2026-11-13, one run each, same build):
	//   32: 69 of 75 front GETs booted a new isolate, WASM 99 MiB, p50 about 4.4 s;
	//   48: 11 of 75, WASM 92 MiB, home and product p50 0.85 to 1.5 s;
	//   52: 42 of 75, WASM 98 MiB. WASM grows in steps, so the size is not a dial:
	//   locally 44 and 56 both landed at 104 MiB, over the recycle line (then RECYCLE_WASM_BYTES, now RECYCLE_WASM_MIB). Change
	//   it only with measure394.py on the sample store; PHP_INI overrides it per site.
	// - blacklist /internal/eval.php (#294): php.run({ code }) writes its code to that ONE
	//   path on every call, so it is the one script that DOES change within a deploy. With
	//   validate_timestamps=0 OPcache kept the first compiled copy, and every later php.run
	//   ran it instead of its own code. opcache.sh then shipped it in opcache.zip, so on a
	//   deployed site every php.run (the install, the cron, an activation, /_mem) ran the
	//   priming run's last script: measured 2026-11-11, /_install answered an empty out and
	//   the shipped internal/eval.php.bin was runCron's code. This is also the cause of
	//   #185's "a reused runtime returns runCron's output in place of the activation".
	php.mkdir('/internal/shared');
	php.writeFile(OPCACHE_BLACKLIST, '/internal/eval.php\n');
	const opcacheIni = {
		'opcache.blacklist_filename': OPCACHE_BLACKLIST,
		'opcache.file_update_protection': '0',
		'opcache.validate_timestamps': '0',
		'opcache.file_cache_only': '0',
		// #610: 64 MB for a store (OPCACHE_MC = "64", rendered by the deploy paths), 48 for every other site
		// (opcache-size.mjs). PHP_INI is spread last, so an explicit opcache.memory_consumption still wins.
		'opcache.memory_consumption': opcacheMemoryMib(ENV),
		'opcache.interned_strings_buffer': '4',
		'opcache.max_accelerated_files': '4000',
	};
	await setPhpIniEntries(php, { ...INI_DEFAULTS, ...opcacheIni, ...deployIni, ...JSON.parse(ENV.PHP_INI || '{}') });
	const tWasm = Date.now() - t0;
	const mem = () => php[__private__dont__use].HEAPU8.length;
	const memAt = { start: mem() };

	// Files, without copying at boot (measured 2026-11-04: unzip and write cost
	// about 300 ms of a cold start locally, more on Cloudflare).
	// - site.zip (deflated): each PHP file is inflated on its first read only.
	//   A page reads about a quarter of them.
	// - opcache.zip: the same, or a view of the bundled bytes if stored.
	const FS = php[__private__dont__use].FS;
	const made = new Set();
	const mkdirp = (dir) => {
		if (made.has(dir)) return;
		php.mkdir(dir);
		made.add(dir);
	};
	let count = 0;
	let fileBytes = 0;
	if (ENV.LAZY_CACHE_MB) {
		const mb = Number(ENV.LAZY_CACHE_MB);
		if (Number.isFinite(mb)) LAZY_CACHE_BYTES = Math.max(1, mb) * 1024 * 1024; // a non-numeric value keeps the default, not NaN.
	}
	// #569: the request budget, shared by the OPcache and the site packs.
	const intEnv = (v, lo, hi, dflt) => { const n = Number(v); return Number.isInteger(n) && n >= lo && n <= hi ? n : dflt; };
	const softCap = intEnv(ENV.REMOTE_FETCH_CAP, 0, 1000, REMOTE_FETCH_CAP);
	const hardCap = Math.max(softCap, intEnv(ENV.SITE_FETCH_CAP, 0, 1000, SITE_FETCH_CAP));
	fetchBudget = createFetchBudget({ soft: softCap, hard: hardCap });
	sitePacks = null;
	siteState = SITE_REMOTE ? 'none' : 'none:not-built';
	if (SITE_REMOTE) {
		// site.zip is EMPTY on this build: every site file is a remote node. Without the binding the
		// site cannot be served at all, so the boot fails, loudly (never a site with no files).
		if (!ENV.ASSETS) {
			siteState = 'fail:no-assets-binding';
			console.error(JSON.stringify({ m: 'site-remote', fail: 'no ASSETS binding: a SITE_REMOTE build cannot serve its files' }));
			throw siteRefusal('no-assets', 'a SITE_REMOTE build without an ASSETS binding cannot serve its files');
		}
		// The lead's ruling on #570: OPcache OFF with remote sources cannot fit the fetch budget (every
		// script compiles, so every source is read: woo.py's checkout passed the hard cap of 96). Refused,
		// loudly, never a thrash.
		if (!OPCACHE_REMOTE || ENV.OPCACHE_REMOTE === 'off') {
			siteState = 'fail:opcache-off';
			console.error(JSON.stringify({ m: 'site-remote', fail: 'OPCACHE_REMOTE is off: a SITE_REMOTE build needs the remote OPcache' }));
			throw siteRefusal('opcache-off', 'a SITE_REMOTE build with OPcache off cannot fit the fetch budget');
		}
		const siteHold = intEnv(ENV.SITE_HOLD_KIB, 0, 65536, SITE_HOLD_BYTES / 1024) * 1024;
		siteHooks = null;
		sitePacks = createRemotePacks({
			index: SITE_REMOTE, fetchPack: fetchRemotePack, parse: zipEntries, stats, prefix: 'rs', budget: fetchBudget, limit: 'hard',
			holdBytes: siteHold, retries: 1, retryDelayMs: intEnv(ENV.SITE_RETRY_MS, 0, 5000, 50), log: (o) => console.error(JSON.stringify(o)),
		});
		siteHooks = createSiteHooks(sitePacks);
		for (const d of SITE_REMOTE.dirs) mkdirp('/' + d);
		for (const [name, [, size]] of Object.entries(SITE_REMOTE.files)) {
			const full = '/' + name;
			remoteSiteFile(FS, full, name, size);
			count++;
			fileBytes += size;
		}
		siteState = `packs ${SITE_REMOTE.packs.length} hotKiB ${SITE_REMOTE.hot ? Math.round(SITE_REMOTE.hot.bytes / 1024) : 0} files ${count} cap ${hardCap} holdKiB ${Math.round(siteHold / 1024)}`;
	} else if (ENV.LAZY_NODES === 'on') {
		// Lazy MEMFS nodes (#218): mount the site tree by index; nodes are created
		// only when PHP first looks a path up, not ~6800 at boot. b-dosql default
		// off (the eager path below is unchanged) until this is proven for A.
		mountLazyZip(FS, '/', new Uint8Array(siteZip));
	} else {
		for (const e of zipEntries(new Uint8Array(siteZip))) {
			const full = '/' + e.name;
			if (e.name.endsWith('/')) {
				mkdirp(full.slice(0, -1));
				continue;
			}
			mkdirp(full.slice(0, full.lastIndexOf('/')));
			lazyFile(FS, full, e, 'site');
			count++;
			fileBytes += e.size;
		}
	}
	const tSite = Date.now() - t0 - tWasm;
	let opcacheFiles = 0;
	// #394 L1: the BOOT files of a split build, for this boot request only (dropped after it).
	bootPackPaths = null;
	l1State = OPCACHE_BOOT ? (ENV.OPCACHE_SPLIT === 'off' ? 'none:split-off' : 'none') : 'none:unsplit';
	if (OPCACHE_BOOT && ENV.OPCACHE_SPLIT !== 'off') {
		bootPackPaths = [];
		for (const pack of await loadBootPacks()) {
			for (const e of zipEntries(pack)) {
				if (e.name.endsWith('/')) continue;
				const full = OPCACHE_DIR + '/' + e.name;
				mkdirp(full.slice(0, full.lastIndexOf('/')));
				lazyFile(FS, full, e, 'opcache');
				bootPackPaths.push(full);
			}
		}
	}
	for (const e of zipEntries(new Uint8Array(opcacheZip))) {
		if (e.name.endsWith('/')) continue;
		const full = OPCACHE_DIR + '/' + e.name;
		mkdirp(full.slice(0, full.lastIndexOf('/')));
		if (e.method === 0) FS.writeFile(full, e.data(), { canOwn: true });
		else lazyFile(FS, full, e, 'opcache');
		opcacheFiles++;
	}
	// #563: every OPcache file of an OPCACHE_REMOTE build, as remote nodes (opcache.zip is empty then).
	remotePacks = null;
	remoteState = OPCACHE_REMOTE ? 'none' : 'none:not-built';
	if (OPCACHE_REMOTE && ENV.OPCACHE_REMOTE === 'off') remoteState = 'off';
	else if (OPCACHE_REMOTE && !ENV.ASSETS) {
		// No pack can be fetched: the warm scripts compile from source (OPcache's normal path). Said loudly.
		remoteState = 'fallback:no-assets-binding';
		console.error(JSON.stringify({ m: 'remote', fallback: 'compile', why: 'no ASSETS binding' }));
	} else if (OPCACHE_REMOTE) {
		const cap = softCap;
		const holdBytes = intEnv(ENV.REMOTE_HOLD_KIB, 0, 65536, REMOTE_HOLD_BYTES / 1024) * 1024;
		// #569: the shared budget; OPcache opens stop at the soft cap (a compile), site opens go on.
		remotePacks = createRemotePacks({ index: OPCACHE_REMOTE, fetchPack: fetchRemotePack, parse: zipEntries, stats, budget: fetchBudget, limit: 'soft', holdBytes, log: (o) => console.error(JSON.stringify(o)) });
		let n = 0;
		for (const [name, [, size]] of Object.entries(OPCACHE_REMOTE.files)) {
			const full = OPCACHE_DIR + '/' + name;
			mkdirp(full.slice(0, full.lastIndexOf('/')));
			remoteFile(FS, full, name, size);
			n++;
		}
		remoteState = `packs ${OPCACHE_REMOTE.packs.length} files ${n} cap ${cap} holdKiB ${Math.round(holdBytes / 1024)}`;
	}
	const tFiles = Date.now() - t0 - tWasm;
	memAt.afterFiles = mem();

	// Keys from the WP_SALT secret, so a deployed site never uses the local ones.
	const lines = ['<?php'];
	if (ENV.WP_SALT) {
		for (const k of ['AUTH_KEY', 'SECURE_AUTH_KEY', 'LOGGED_IN_KEY', 'NONCE_KEY', 'AUTH_SALT', 'SECURE_AUTH_SALT', 'LOGGED_IN_SALT', 'NONCE_SALT']) {
			const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ENV.WP_SALT + ':' + k));
			const hex = [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
			lines.push(`define('${k}', '${hex}');`);
		}
	}
	lines.push(`define('WP_HOME', ${JSON.stringify(origin)});`);
	// The R2 Uploads mu-plugin turns on when the MEDIA binding exists.
	if (ENV.MEDIA) lines.push(`define('R2_UPLOADS', true);`);
	// Image sizes come from the Images binding (php/cf-images-editor.php).
	if (ENV.MEDIA && ENV.IMAGES) lines.push(`define('CF_IMAGES', true);`);
	// A deploy (WP_SALT is set) shows no PHP errors or database errors to visitors.
	if (ENV.WP_SALT) lines.push(`define('WP_DEBUG', false);`);
	// A demo site or a one-click site cannot install, update or edit plugin or theme code (site-lock.mjs).
	lines.push(...lockDefines(ENV));
	// Outbound HTTP through fetch() (php/http-bridge.php, #26). HTTP_BRIDGE=off: no
	// bridge, and WordPress blocks external requests, as before the bridge.
	if (ENV.HTTP_BRIDGE === 'off') lines.push(`define('SKYPHUSION_HTTP_BRIDGE_OFF', true);`, `define('WP_HTTP_BLOCK_EXTERNAL', true);`);
	// Variant a on a strict MySQL (PlanetScale): the sql_mode each statement
	// carries (php/hyperdrive-sql-mode.php). Mode names and commas only.
	if (typeof ENV.HYPERDRIVE_SQL_MODE === 'string' && /^[A-Za-z_,]*$/.test(ENV.HYPERDRIVE_SQL_MODE))
		lines.push(`define('HYPERDRIVE_SQL_MODE', ${JSON.stringify(ENV.HYPERDRIVE_SQL_MODE)});`);
	// The object cache across requests (php/object-cache.php): only where one
	// object is the only writer. OBJECT_CACHE=off turns it off (to measure).
	if (ENV.PHP_IN_DO === 'on' && ENV.DB_IN_DO === 'on' && ENV.OBJECT_CACHE !== 'off') lines.push(`define('JS_OBJECT_CACHE', true);`);
	// Approach A (external MySQL through Hyperdrive; dbHandler is set): the object
	// cache across requests lives in the Worker ISOLATE Map, and there are many
	// isolates each writing the shared MySQL, so a write in one isolate never purges
	// another isolate Map. OFF by default (OBJECT_CACHE=on turns it on, to measure),
	// and only an allowlist of cross-isolate-safe groups persists; everything else,
	// above all the WooCommerce correctness groups, stays per request. See issue #218
	// and docs/approach-a-objectcache.md.
	if (dbHandler && ENV.DB_IN_DO !== 'on' && ENV.OBJECT_CACHE === 'on') {
		lines.push("define('JS_OBJECT_CACHE', true);");
		// #491: options never persist on A (php/object-cache-js.php drops them even when named here). #494: terms is out of the default (a stale cross-isolate term).
		const ocPersist = (typeof ENV.OBJECT_CACHE_GROUPS === 'string' && ENV.OBJECT_CACHE_GROUPS) ? ENV.OBJECT_CACHE_GROUPS.replace(/[^A-Za-z0-9_,-]/g, '') : 'theme_json';
		lines.push("define('JS_OBJECT_CACHE_PERSIST_GROUPS', " + JSON.stringify(ocPersist) + ");");
		const ocTtl = Math.max(0, Math.min(3600, parseInt(ENV.OBJECT_CACHE_TTL, 10) || 10));
		lines.push("define('JS_OBJECT_CACHE_TTL', " + ocTtl + ");");
		// #296 (2): with OBJECT_CACHE_VERSIONS=on, options persist across isolates under their exact version
		// from <prefix>skyph_cache_versions (one read per request; AFTER triggers on wp_options bump it, and
		// skip transients). Without the table (not installed, or no triggers) the #491 posture holds.
		if (ENV.OBJECT_CACHE_VERSIONS === 'on') lines.push("define('JS_OBJECT_CACHE_VERSIONED', 'options');");
		if (ENV.THEME_JSON_CACHE !== 'off') lines.push("define('JS_THEME_JSON_CACHE', true);");
	}
	// Real SQL transactions (php/real-transactions.php, #60): the database in the
	// object only. REAL_TRANSACTIONS=off turns them off (to measure).
	if (ENV.PHP_IN_DO === 'on' && ENV.DB_IN_DO === 'on' && ENV.REAL_TRANSACTIONS !== 'off') lines.push(`define('JS_REAL_TRANSACTIONS', true);`);
	// The editor's theme REST routes kept across requests (php/rest-route-cache.php, #53).
	// Needs the object cache. ROUTE_CACHE=off turns it off (to measure).
	if (ENV.PHP_IN_DO === 'on' && ENV.DB_IN_DO === 'on' && ENV.OBJECT_CACHE !== 'off' && ENV.ROUTE_CACHE !== 'off') lines.push(`define('JS_ROUTE_CACHE', true);`);
	// theme.json data kept across requests (php/theme-json-cache.php, #49). Needs the
	// object cache. THEME_JSON_CACHE=off turns it off (to measure).
	if (ENV.PHP_IN_DO === 'on' && ENV.DB_IN_DO === 'on' && ENV.OBJECT_CACHE !== 'off' && ENV.THEME_JSON_CACHE !== 'off') lines.push(`define('JS_THEME_JSON_CACHE', true);`);
	// Async email mu-plugin (issue #185, #856): wp_mail hands messages to the Worker.
	{ const l = asyncEmailDefine(ENV, Boolean(dbHandler)); if (l) lines.push(l); }
	// Bootstrap trim mu-plugin (perf): skip pure-background wc-admin features (remote-inbox,
	// marketing) that re-init every request. The trim is pure-background wc-admin and touches
	// no database engine specifics, so it is safe for approach A (external MySQL) too: with PHP
	// in a Durable Object there (dbHandler set, DB_IN_DO off), it reclaims the WASM-heap that a
	// Woo-warmed isolate otherwise spends re-initialising each request, headroom approach A needs
	// because its DB client sits in the same isolate as PHP (#218). BOOTSTRAP_TRIM=off turns it off.
	if (((ENV.PHP_IN_DO === 'on' && ENV.DB_IN_DO === 'on') || dbHandler) && ENV.BOOTSTRAP_TRIM !== 'off') lines.push(`define('SKYPHUSION_BOOTSTRAP_TRIM', true);`);
	// Core application-password REST calls do not load WooCommerce (php/app-password-headroom.php).
	// A warmed isolate is already near the 128 MiB cap. WooCommerce's route table on that write
	// resets the isolate (cf759a, 2026-11-19, x-write-loss: 1). APP_PASSWORD_HEADROOM=off keeps WooCommerce.
	if (ENV.PHP_IN_DO === 'on' && ENV.DB_IN_DO === 'on' && ENV.APP_PASSWORD_HEADROOM !== 'off') lines.push(`define('SKYPHUSION_APP_PASSWORD_HEADROOM', true);`);
	// Product admin writes return allocator caches and cap the object cache
	// (php/product-save-headroom.php, #963). A suite-hot runtime is already
	// near 117 MiB. post.php and admin-ajax.php then reset the isolate.
	// PRODUCT_HEADROOM=off does not define the gate.
	if (ENV.PHP_IN_DO === 'on' && ENV.DB_IN_DO === 'on' && ENV.PRODUCT_HEADROOM !== 'off') lines.push(`define('SKYPHUSION_PRODUCT_HEADROOM', true);`);
	// Comment REST calls return allocator caches and cap the object cache
	// (php/comment-rest-headroom.php, #989). post-new.php ends near 112 MiB.
	// The recycle line keeps that runtime. The next note save then resets
	// the isolate (cf759a, 2026-11-19, x-write-loss: 1).
	// COMMENT_HEADROOM=off does not define the gate.
	if (ENV.PHP_IN_DO === 'on' && ENV.DB_IN_DO === 'on' && ENV.COMMENT_HEADROOM !== 'off') lines.push(`define('SKYPHUSION_COMMENT_HEADROOM', true);`);
	// Navigation REST writes free allocator caches and cap the object cache
	// (php/navigation-rest-headroom.php, #993).
	// A suite-hot runtime already sits near 101 to 114 MiB.
	// POST /wp/v2/navigation, a force delete, and /batch/v1 then fail.
	// NAV_HEADROOM=off does not define the gate.
	if (ENV.PHP_IN_DO === 'on' && ENV.DB_IN_DO === 'on' && ENV.NAV_HEADROOM !== 'off') lines.push(`define('SKYPHUSION_NAV_HEADROOM', true);`);
	// WOO_EXTRAS=off (#667): php/woo-extras.php forces order attribution, usage tracking,
	// marketplace suggestions and remote logging off. Unset defines nothing, so WooCommerce's
	// own defaults stay. Analytics is not one of the four options.
	if (ENV.WOO_EXTRAS === 'off') lines.push(`define('SKYPHUSION_WOO_EXTRAS', 'off');`);
	// WOO_HPOS_CACHE=on (#697): approach A only (the Hyperdrive dbHandler), php/woo-hpos-cache.php. Unset: nothing.
	{ const l = hposCacheDefine(ENV, Boolean(dbHandler)); if (l) lines.push(l); }
	// Media write trim mu-plugin (issue #189): free isolate memory on the rare admin
	// media-upload request so the attachment insert fits under the 128 MiB cap on a
	// WooCommerce-warmed b-dosql isolate. b-dosql + MEDIA only, and only the async-upload /
	// media-REST write path (php/media-write-trim.php). MEDIA_TRIM is the lever list;
	// MEDIA_TRIM=off turns it off. The value is sanitized to [a-z,] before it becomes a define.
	if (ENV.PHP_IN_DO === 'on' && ENV.DB_IN_DO === 'on' && ENV.MEDIA && ENV.MEDIA_TRIM !== 'off') {
		const mediaTrimModes = (typeof ENV.MEDIA_TRIM === 'string' && ENV.MEDIA_TRIM ? ENV.MEDIA_TRIM : 'wcskip,cacheflush,gc').replace(/[^a-z,]/g, '');
		if (mediaTrimModes) lines.push(`define('SKYPHUSION_MEDIA_WRITE_TRIM', ${JSON.stringify(mediaTrimModes)});`);
	}
	// AI alt text mu-plugin (php/ai-alt-text.php): caption an uploaded image that
	// has no alt text with the Workers AI binding. b-dosql + MEDIA + the AI binding
	// only; AI_ALT=off turns it off. The model is AI_ALT_MODEL (default llava-hf).
	if (ENV.PHP_IN_DO === 'on' && ENV.DB_IN_DO === 'on' && ENV.MEDIA && ENV.AI && ENV.AI_ALT !== 'off') lines.push(`define('SKYPHUSION_AI_ALT', true);`);
	// skyphusion-ai embeddings and Vectorize (issue #330). Both bindings, or
	// neither. The plugin reads SKYPHUSION_AI_CF_BRIDGE the way it reads
	// SKYPHUSION_AI_ALT. No gate var and no token: binding presence is the switch.
	if (cfBridgeEnabled(ENV)) lines.push(`define('SKYPHUSION_AI_CF_BRIDGE', true);`);
	// Zone cache purge-on-publish mu-plugin (php/zone-cache-purge.php, issue #205):
	// purge the Cloudflare ZONE edge cache (deploy/zone/) by URL when content
	// changes, through the scoped PURGE_TOKEN on the PURGE_ZONE zone. On only on the
	// DO profile with both bindings present; CACHE_PURGE=off turns it off. The token
	// stays in the Worker: PHP sends a purgeZone op and never sees it, as the AI
	// binding does for alt text.
	if (cachePurgeEnabled(ENV)) lines.push(`define('SKYPHUSION_CACHE_PURGE', true);`);
	// Browser Rendering PDF invoices mu-plugin (php/pdf-invoice.php, issue #227):
	// render a WooCommerce order to a PDF with the Browser Rendering binding, store it
	// in R2 and hand back a signed download URL. b-dosql + MEDIA + the BROWSER binding
	// only; PDF_INVOICE=off turns it off. The signing secret stays in the Worker, as the
	// AI binding does for alt text.
	if (pdfInvoiceEnabled(ENV)) lines.push(`define('SKYPHUSION_PDF_INVOICE', true);`);
	// Turnstile bot challenge on wp-login, My Account login, registration, lost
	// password, comments and WooCommerce checkout (php/turnstile-forms.php, issue
	// #250, account forms #857). Binding based, so it needs no zone and works on a
	// workers.dev host. The site key is public (it ships in the page); the secret
	// (TURNSTILE_SECRET) stays in the Worker and PHP never sees it, as the AI binding
	// does for alt text. On only when both the secret and a valid public site key are
	// set; TURNSTILE=off is the master off switch, and TURNSTILE_LOGIN /
	// TURNSTILE_REGISTER / TURNSTILE_WOO_REGISTER / TURNSTILE_LOSTPASSWORD /
	// TURNSTILE_COMMENTS / TURNSTILE_WOO=off turn a single form off. TURNSTILE_LOGIN
	// covers both logins. The site key is sanitized to a safe charset before it
	// becomes a define.
	if (turnstileEnabled(ENV)) {
		const tsForms = turnstileForms(ENV);
		lines.push(`define('SKYPHUSION_TURNSTILE', true);`);
		lines.push(`define('SKYPHUSION_TURNSTILE_SITEKEY', ${JSON.stringify(sanitizeSiteKey(ENV.TURNSTILE_SITEKEY))});`);
		lines.push(`define('SKYPHUSION_TURNSTILE_LOGIN', ${tsForms.login ? 'true' : 'false'});`);
		lines.push(`define('SKYPHUSION_TURNSTILE_REGISTER', ${tsForms.register ? 'true' : 'false'});`);
		lines.push(`define('SKYPHUSION_TURNSTILE_WOO_REGISTER', ${tsForms.wooRegister ? 'true' : 'false'});`);
		lines.push(`define('SKYPHUSION_TURNSTILE_LOSTPASSWORD', ${tsForms.lostpassword ? 'true' : 'false'});`);
		lines.push(`define('SKYPHUSION_TURNSTILE_COMMENTS', ${tsForms.comments ? 'true' : 'false'});`);
		lines.push(`define('SKYPHUSION_TURNSTILE_WOO', ${tsForms.woo ? 'true' : 'false'});`);
	}
	// Privacy-friendly pageview analytics mu-plugin (php/analytics-pageview.php,
	// issue #201 Phase 2): record one anonymized pageview per front-end request to
	// the Analytics Engine dataset binding. Binding based, so it needs no zone.
	// OPT-IN (a privacy implication): on only when PHP_IN_DO and DB_IN_DO are on,
	// the ANALYTICS binding is present, and WP_ANALYTICS is 'on' (the
	// analytics-engine descriptor sets it when the operator opts in). The dataset
	// binding stays in the Worker: PHP sends an analytics op and never sees it, as
	// the AI binding does for alt text.
	if (analyticsEnabled(ENV)) lines.push(`define('SKYPHUSION_ANALYTICS', true);`);
	php.writeFile(DOCROOT + '/wp-runtime.php', lines.join('\n') + '\n');

	// #569: the BOOT SELF-CHECK. Gate 0b's red control read files as EMPTY, with no error: a SITE_REMOTE
	// build whose read path is broken would serve empty PHP. A known remote .php is read through PHP
	// here and must match its recorded size and SHA-256, or the boot fails, loudly.
	if (SITE_REMOTE) {
		try {
			if (!SITE_REMOTE.selfcheck) throw new Error('site self-check failed: the site index has no selfcheck entry (an old site-remote.py?)');
			const r = await php.run({ code: selfCheckCode(SITE_REMOTE.selfcheck) });
			checkSelfCheck(r.text, SITE_REMOTE.selfcheck);
			siteState += ' selfcheck ok';
		} catch (e) {
			siteState = 'fail:selfcheck';
			console.error(JSON.stringify({ m: 'site-remote', fail: String((e && e.message) || e).slice(0, 300) }));
			throw siteRefusal('selfcheck', 'the boot self-check failed: SITE_REMOTE reads are not working');
		}
	}

	php.onMessage(handleMessage);

	const handler = new PHPRequestHandler({
		php,
		documentRoot: DOCROOT,
		absoluteUrl: origin,
		cookieStore: false,
		getFileNotFoundAction: () => ({ type: 'internal-redirect', uri: '/index.php' }),
	});
	instEnd();
	if (gen !== bootGen) {
		if (reuseActive()) {
			// #724 review, finding 4: superseded after instantiation (it may hold the spare). It retires through the
			// normal path NOW (no caller has run on it: the handoff below gives them the current runtime), with its
			// own serial as its drop serial, so its memory comes back as the offer, and the boot that waited for it
			// (instantiating) takes it. Never orphaned beside a second memory.
			console.log(JSON.stringify({ m: 'boot-superseded', at: 'instantiated' }));
			if (!droppedAtSerial.has(php)) droppedAtSerial.set(php, serial);
			retirer.retire(php, true);
			retirer.releaseNow(php);
			return handOff(origin);
		}
		// #566: dropped while booting: nothing will reuse this runtime, but whoever awaited this boot may still use
		// it now, so it is only queued, and the end of the next PHP run releases it.
		retirer.retire(php, true);
	}
	return { php, handler, bootMs: { wasm: tWasm, site: tSite, files: tFiles, fileCount: count, fileBytes, opcacheFiles, memAt } };
}

let reserveTableReady = false;

// Source from R2, transforms by the Images binding, result to R2 (if dest).
async function imageJob(B, job) {
	const o = await B.get(job.src);
	if (!o) throw new Error('source not found: ' + job.src);
	let h = ENV.IMAGES.input(o.body);
	for (const t of job.ops || []) h = h.transform(t);
	const out = await h.output({ format: job.format, ...(job.quality ? { quality: job.quality } : {}) });
	const bytes = new Uint8Array(await out.response().arrayBuffer());
	if (job.dest) await B.put(job.dest, bytes, { httpMetadata: { contentType: job.format } });
	return bytes;
}
// Set by the Edge Cache mu-plugin when content changes. Read after the request.
let purgeRequested = false;
let pendingEmails = [];
let emailDueRequest = false;
let lastOrigin = null;
// Workers Cache purges always have Free-tier limits: 5 a minute, bursts of 25,
// per account (#699). The gateway purges at most once per PURGE_GAP_MS per isolate
// (purge-state.mjs). The object keeps a refused purge pending and retries it (#699).
// The object's purge state (issue #78, #699): purge-state.mjs, in its storage.
const PURGE_STATE_KEY = 'skyphusion-purge';
const ORIGIN_KEY = 'skyphusion-origin';
const CRON_SKIP_KEY = 'cron-skip';
const CRON_CLEAN_KEY = 'cron-cleaned-at';
// The start of the last cron leg (#470, cron-bound.mjs cronLegDue).
const CRON_LAST_KEY = 'cron-last-start';
// #1120: the end of a leg that made progress with Action Scheduler work still due (cron-bound.mjs cronBacklogNext); the next leg is due by it.
const CRON_BACKLOG_KEY = 'cron-backlog';
// #1120 review: { n, due }, the soon legs in a row without progress against as_due (cron-bound.mjs backlogStreak).
const CRON_BACKLOG_STREAK_KEY = 'cron-backlog-streak';
let lastPurge = 0;
// #510: dispose a JS RPC result once its fields are read. An RPC result can carry a disposer (and,
// over Cap'n Web, every object result does); left to the garbage collector it logs "An RPC result
// was not disposed properly" (wp-a-lean: 4 and 8 warns in the two load windows, 2026-11-14).
// A plain object with no disposer is left as it is. Never throws.
function disposeRpc(r) {
	try {
		if (r && typeof r[Symbol.dispose] === 'function') r[Symbol.dispose]();
	} catch {
		// a failed dispose never fails the purge
	}
}
function schedulePurge(ctx) {
	// A purge already scheduled for later covers this change too.
	const wait = Math.max(0, lastPurge + PURGE_GAP_MS - Date.now());
	const send = lastPurge <= Date.now();
	// One line per change and one per purge sent, so a run can count both (wrangler tail).
	console.log(JSON.stringify({ m: 'purge', asked: 1, coalesced: send ? 0 : 1, waitMs: send ? wait : 0 }));
	if (send) {
		lastPurge = Date.now() + wait;
		ctx.waitUntil(
			new Promise((ok) => setTimeout(ok, wait))
				.then(() => ctx.exports.Pages.purge(['wp-pages']))
				// A refused purge (Free limits: 5 a minute per account) is reported, not dropped.
				.then((r) => {
					console.log(JSON.stringify({ m: 'purge', sent: 1, ok: !!(r && r.ok), errors: (r && r.errors) || [] }));
					disposeRpc(r); // #510: after its fields are read
				})
				.catch((e) => console.log(JSON.stringify({ m: 'purge', sent: 1, ok: false, error: String(e).slice(0, 200) }))),
		);
	}
}

// Page cache (Workers Cache, issue #63). Only the Pages entrypoint is cached.
// The default entrypoint (the gateway, not cached) sends it a GET or HEAD that
// has no WordPress cookie (WP_COOKIE, by name) and is not an admin, login,
// cron or spike path, WITHOUT the Cookie header. So the cache key is the path
// and the query alone, and a cookie that is not WordPress's (analytics _ga,
// WooCommerce order attribution sbjs_*) does not split it. Before #63 the
// default entrypoint was cached with Vary: Cookie, keyed on the whole Cookie
// header: every visitor with any such cookie was a separate variant (measured
// on wp-perf-dosql, docs/approach-b.md 8c).
const WP_COOKIE = /(^|;\s*)(wordpress_logged_in_|wordpress_sec_|wp-postpass_|comment_author_|wp-settings-|woocommerce_|wp_woocommerce_session_)/;
const PAGE_CACHE_NO_PATH = /^\/(wp-admin|wp-login\.php|wp-json|wp-cron\.php|wp-comments-post\.php|cart|checkout|my-account|wc-api|skyphusion-invoice|_)/;
const PAGE_CACHE_NO_PARAM = ['rest_route', 'wc-ajax', 'add-to-cart', 'preview', 'nocache', 'customize_changeset_uuid', 'wc-api'];
function pageCacheRoute(req, url, env) {
	return (
		Number(env.PAGE_CACHE_TTL || 120) > 0 &&
		(req.method === 'GET' || req.method === 'HEAD') &&
		!WP_COOKIE.test(req.headers.get('cookie') || '') &&
		!req.headers.get('upgrade') &&
		!PAGE_CACHE_NO_PATH.test(url.pathname) &&
		!PAGE_CACHE_NO_PARAM.some((k) => url.searchParams.has(k)) &&
		!req.headers.has('authorization') &&
		// An operator request never goes to the cached entrypoint (perf-headers.mjs).
		!isOperatorRequest(req)
	);
}
function pageCacheHeaders(req, url, r, out, env, failed = 0) {
	const ttl = Number(env.PAGE_CACHE_TTL || 120);
	const wpCc = String([].concat(r.headers['cache-control'] || []).join(','));
	const cacheable =
		ttl > 0 &&
		failed === 0 && // #766: an answer made while a statement failed (a read that came back empty) is never stored
		(req.method === 'GET' || req.method === 'HEAD') &&
		[200, 301, 404].includes(r.httpStatusCode) &&
		!WP_COOKIE.test(req.headers.get('cookie') || '') &&
		!r.headers['set-cookie'] &&
		!/no-cache|no-store|private/i.test(wpCc) &&
		!PAGE_CACHE_NO_PATH.test(url.pathname) &&
		!PAGE_CACHE_NO_PARAM.some((k) => url.searchParams.has(k)) &&
		!req.headers.has('authorization');
	// #628 C2: edge-cache.php marks product, shop and category pages for the Worker only. The mark
	// never leaves, cached or not (page-cache-ttl.mjs).
	out.delete(PRODUCT_PAGE_HEADER);
	if (cacheable) {
		// The edge keeps it (cloudflare-cdn-cache-control, consumed by Cloudflare and
		// not sent on). The browser must ask again (no-cache): there is no Vary: Cookie
		// now, so a browser that kept the page would show the logged-out copy after a login.
		// PAGE_CACHE_PRODUCT_TTL (#628 C2, off by default) gives product pages a shorter TTL.
		out.set('cloudflare-cdn-cache-control', edgeCacheControl(ttl, productTtl(env), isProductPage(r.headers)));
		out.set('cache-control', 'no-cache');
		out.set('cache-tag', 'wp-pages');
	} else {
		// Not stored at the edge, also when WordPress sent its own no-cache (which the
		// cache would store as stale).
		out.set('cloudflare-cdn-cache-control', 'no-store');
		// #759: WordPress sends no-cache, private on logged-in and 404 pages. The browser
		// must not keep them without no-store (wordpress-develop cache-control-headers-directives).
		const cc = String(out.get('cache-control') || wpCc || '');
		if (!cc) out.set('cache-control', 'private, no-store');
		else if (!/no-store/i.test(cc)) out.set('cache-control', cc + ', no-store');
	}
}

// One R2 operation for the R2 Uploads mu-plugin (php/r2-uploads.php).
// Bodies cross the PHP to JS bridge as base64.
async function r2op(op) {
	const t0 = Date.now();
	try {
		return await r2opInner(op);
	} finally {
		// Wall time advances during I/O, so these numbers are real.
		const ms = Date.now() - t0;
		stats.r2[op.op] = stats.r2[op.op] || { n: 0, ms: 0 };
		stats.r2[op.op].n++;
		stats.r2[op.op].ms += ms;
	}
}

async function r2opInner(op) {
	try {
		const B = ENV.MEDIA;
		if (op.op === 'get') {
			const o = await B.get(op.key, op.length ? { range: { offset: op.offset || 0, length: op.length } } : undefined);
			if (!o) return { ok: true, found: false };
			const bytes = new Uint8Array(await o.arrayBuffer());
			return { ok: true, found: true, body: b64encode(bytes), size: o.size, mtime: Math.floor(o.uploaded.getTime() / 1000) };
		}
		if (op.op === 'head') {
			const o = await B.head(op.key);
			return o ? { ok: true, found: true, size: o.size, mtime: Math.floor(o.uploaded.getTime() / 1000) } : { ok: true, found: false };
		}
		if (op.op === 'put') {
			// #352: a put may become an orphan if the request rolls back (its attachment rows go). Logged for the sweep.
			if (undoLog && undoLog.frameOpen()) console.log(JSON.stringify({ m: 'frame-r2-put', key: String(op.key).slice(0, 200) }));
			// #1039: a key this request CREATES is recorded before the put, so a proven rollback deletes it. An overwrite is
			// never recorded: the old bytes are gone either way, and a kept row may point at the key.
			await uploadIntentMark(B, op.key); // #1039, approach A: an upload's created file is marked first
			await r2RecordIfNew(B, op.key);
			await B.put(op.key, b64decode(op.body), { httpMetadata: { contentType: op.type || 'application/octet-stream' } });
			return { ok: true };
		}
		if (op.op === 'copy') {
			// Copy inside R2 (rename, staged uploads). The bytes never go to PHP.
			if (undoLog && undoLog.frameOpen() && sqlDb) undoLog.commitPoint(sqlDb, 'r2-copy'); // #352: may replace bytes
			const o = await B.get(op.from);
			if (!o) return { ok: true, found: false };
			await uploadIntentMark(B, op.to); // #1039: as a put
			await r2RecordIfNew(B, op.to); // #1039: as a put
			await B.put(op.to, o.body, { httpMetadata: { contentType: op.type || o.httpMetadata?.contentType || 'application/octet-stream' } });
			if (op.move) {
				await releaseReservedKey(op.from);
				await B.delete(op.from);
			}
			return { ok: true, found: true };
		}
		if (op.op === 'delete') {
			if (undoLog && undoLog.frameOpen() && sqlDb) undoLog.commitPoint(sqlDb, 'r2-delete'); // #352: the bytes are gone
			await releaseReservedKey(op.key);
			await B.delete(op.key);
			return { ok: true };
		}
		if (op.op === 'info') {
			const o = await B.get(op.key);
			if (!o) return { ok: true, found: false };
			const i = await ENV.IMAGES.info(o.body); // .info() is not billed
			return { ok: true, found: true, format: i.format, width: i.width, height: i.height, size: i.fileSize };
		}
		if (op.op === 'image') {
			const bytes = await imageJob(B, op);
			return { ok: true, size: bytes.length, ...(op.body ? { body: b64encode(bytes) } : {}) };
		}
		if (op.op === 'images') {
			// Several Images jobs in parallel (sub-sizes of one upload).
			const results = await Promise.allSettled((op.jobs || []).map((j) => imageJob(B, j)));
			const failed = results.filter((x) => x.status === 'rejected').map((x) => String(x.reason));
			return { ok: true, failed };
		}
		if (op.op === 'reserve' && sqlDb) {
			// #946: one insert owns the name. releaseReservedKey drops that row when the file goes.
			// #952: a row whose object is already gone is taken again. One PHP request runs at a time.
			return { ok: true, reserved: tryReserveName(sqlDb, op.key, !!(await B.head(op.key)), Date.now(), sqlChanges) };
		}
		if (op.op === 'reserve') {
			// Approach A has no D1: r2-uploads.php falls back to core's unique names.
			if (!ENV.DB) return { ok: false, error: 'unknown r2 op reserve' };
			// One atomic insert decides who gets a file name.
			if (!reserveTableReady) {
				await ENV.DB.prepare(RESERVE_DDL).run();
				reserveTableReady = true;
			}
			if (await B.head(op.key)) return { ok: true, reserved: false };
			// Do not drop a leftover row here. Two isolates can reserve one name at once.
			const r = await ENV.DB.prepare(RESERVE_INSERT).bind(op.key, Date.now()).run();
			return { ok: true, reserved: r.meta.changes === 1 };
		}
		if (op.op === 'list') {
			const l = await B.list({ prefix: op.prefix, delimiter: '/', limit: op.limit || 1000 });
			return { ok: true, keys: l.objects.map((o) => o.key), prefixes: l.delimitedPrefixes };
		}
		return { ok: false, error: 'unknown r2 op' };
	} catch (e) {
		return { ok: false, error: String((e && e.message) || e) };
	}
}

// #1039: record an R2 key the armed request is about to CREATE (undo-log.mjs r2Created). head() only when recording is on.
async function r2RecordIfNew(B, key) {
	if (!undoLog || !sqlDb || !undoLog.r2Tracking()) return;
	try {
		if (!(await B.head(key))) undoLog.r2Created(sqlDb, key);
	} catch (e) {
		console.log(JSON.stringify({ m: 'frame-r2-record-failed', error: String((e && e.message) || e).slice(0, 160) }));
	}
}
// #1039: delete the R2 keys a rolled-back request created, and their name reservations (#946). True when every key went
// (then the record is forgotten); false keeps the record, and the caller must not claim that nothing was saved.
async function deleteFrameR2(req, keys) {
	if (!keys || !keys.length) return true;
	let failed = 0;
	for (const k of keys) {
		try {
			await releaseReservedKey(k);
			await ENV.MEDIA.delete(k);
		} catch {
			failed++;
		}
	}
	console.log(JSON.stringify({ m: 'frame-r2-deleted', req, n: keys.length - failed, failed }));
	if (!failed && undoLog && sqlDb) undoLog.r2Forget(sqlDb, req);
	return failed === 0;
}
// #1039, approach A (upload-intent.mjs, the lead's ruling): the media upload PHP run now running, or null. One PHP run
// at a time (withPhp), so one slot. Holds the R2 keys this upload CREATED, each marked before its put.
let uploadRun = null;
async function uploadIntentMark(B, key) {
	if (!uploadRun) return;
	try {
		if (await B.head(key)) return; // an overwrite is never marked, so never swept
		await B.put(markerKey(key), JSON.stringify({ kind: 'upload', t: Date.now() }), { customMetadata: { kind: 'upload' } });
		uploadRun.push(String(key));
	} catch (e) {
		console.log(JSON.stringify({ m: 'upload-intent-mark-failed', error: String((e && e.message) || e).slice(0, 160) }));
	}
}
// PHP answered 2xx: this upload's files are its own. Its markers go (off the answer's path).
async function uploadIntentClear(keys) {
	for (const k of keys) {
		try { await ENV.MEDIA.delete(markerKey(k)); } catch { /* a stale marker is swept by its reference check */ }
	}
}
// The sweep at the start of a media upload, at most once per 10 minutes per site (OC_KV when bound; else per isolate).
let uploadSweepAt = 0;
async function uploadSweepThrottled(env) {
	if (!env.MEDIA || !dbHandler || typeof dbHandler.oneShot !== 'function') return;
	const KEY = 'pf:upload-sweep';
	try {
		if (env.OC_KV) {
			if (await env.OC_KV.get(KEY)) return;
			await env.OC_KV.put(KEY, '1', { expirationTtl: 600 });
		} else {
			if (Date.now() - uploadSweepAt < 600000) return;
			uploadSweepAt = Date.now();
		}
		const r = await sweepUploadOrphans({
			bucket: env.MEDIA,
			query: (sql) => dbHandler.oneShot(env, sql),
			prefix: tablePrefix(env),
			log: (e) => console.log(JSON.stringify(e)),
			release: (k) => releaseReservedKey(k),
		});
		if (r.markers) console.log(JSON.stringify({ m: 'upload-sweep', ...r }));
	} catch (e) {
		console.log(JSON.stringify({ m: 'upload-sweep-failed', error: String((e && e.message) || e).slice(0, 160) }));
	}
}

async function releaseReservedKey(key) {
	// #946: free the name before the object goes. A concurrent upload still sees the object and refuses the name.
	if (sqlDb) {
		releaseReservedName(sqlDb, key);
		return;
	}
	if (ENV && ENV.DB) await releaseReservedD1(ENV.DB, key);
}

function b64encode(bytes) {
	let s = '';
	for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
	return btoa(s);
}

function b64decode(str) {
	const s = atob(str);
	const out = new Uint8Array(s.length);
	for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
	return out;
}

// GET and HEAD /wp-content/uploads/<path> come from R2, not PHP, with Range
// support (video seeking needs it). No PHP lock.
async function serveUpload(req, env, url) {
	let key;
	try {
		key = 'uploads/' + decodeURIComponent(url.pathname.slice('/wp-content/uploads/'.length));
	} catch {
		return new Response('bad path', { status: 400 });
	}
	// R2 keys are at most 1,024 bytes. A longer path cannot exist.
	if (new TextEncoder().encode(key).length > 1024) return new Response('not found', { status: 404 });
	let o;
	try {
		o = await env.MEDIA.get(key, { onlyIf: req.headers, range: req.headers });
	} catch {
		return new Response('bad range', { status: 416 });
	}
	if (o === null) return new Response('not found', { status: 404 });
	const h = new Headers();
	o.writeHttpMetadata(h);
	h.set('etag', o.httpEtag);
	// private: browsers keep it a day, the edge cache does not. A deleted upload
	// is then gone at once, with no purge. Purges are rate limited (5 a minute).
	h.set('cache-control', 'private, max-age=86400');
	h.set('accept-ranges', 'bytes');
	h.set('x-content-type-options', 'nosniff');
	if (!('body' in o) || !o.body) return new Response(null, { status: 304, headers: h });
	let status = 200;
	let length = o.size;
	if (o.range && req.headers.has('range')) {
		const offset = o.range.offset ?? (o.range.suffix !== undefined ? o.size - o.range.suffix : 0);
		length = o.range.length ?? (o.range.suffix !== undefined ? o.range.suffix : o.size - offset);
		h.set('content-range', `bytes ${offset}-${offset + length - 1}/${o.size}`);
		status = 206;
	}
	h.set('content-length', String(length));
	return new Response(req.method === 'HEAD' ? null : o.body, { status, headers: h });
}

// GET/HEAD /skyphusion-invoice?k=&e=&s= : a signed, expiring link to an order's invoice
// PDF (issue #227). verifyDownload checks the HMAC, the expiry and that the key is a
// well-formed invoices/ key, so a link cannot be edited to read another object or used
// after it expires. The secret never leaves the Worker.
async function serveInvoice(req, env, url) {
	const { key, exp, sig } = parseDownloadQuery(url.searchParams);
	const ok = await verifyDownload(env.INVOICE_TOKEN, key, exp, sig, Math.floor(Date.now() / 1000));
	if (!ok) return new Response('invalid or expired link', { status: 403 });
	let o;
	try {
		o = await env.MEDIA.get(key);
	} catch {
		return new Response('not found', { status: 404 });
	}
	if (!o) return new Response('not found', { status: 404 });
	const h = new Headers();
	o.writeHttpMetadata(h);
	if (!h.has('content-type')) h.set('content-type', 'application/pdf');
	h.set('etag', o.httpEtag);
	h.set('content-length', String(o.size));
	// An invoice is per customer: never let the edge cache keep it.
	h.set('cache-control', 'private, no-store');
	h.set('x-content-type-options', 'nosniff');
	h.set('content-disposition', 'inline; filename="invoice.pdf"');
	return new Response(req.method === 'HEAD' ? null : o.body, { status: 200, headers: h });
}


// Checkout Container (issue #20). WooCommerce needs 256 MB of PHP memory; an
// isolate has 128 MB for everything, and checkout passed it on Paid. The store
// and the cart stay in the Worker. The first item in the cart starts this
// container, so it is warm by the time the shopper checks out. It sleeps when
// idle. Its PHP reaches D1, R2 and Images through worker.internal, below.
export { ContainerProxy };
export class WooCheckout extends Container {
	defaultPort = 80;
	sleepAfter = '5m';
	enableInternet = false;
	// The health check. The default ("ping") requested "/", so every check was a
	// full WordPress page render with D1 calls; the checks filled the PHP workers
	// and the container never passed its start check (measured 2026-11-04: 524).
	// /ping is a static file.
	pingEndpoint = 'localhost/ping';
	constructor(ctx, env) {
		super(ctx, env);
		this.envVars = {
			WP_SALT: env.WP_SALT || '',
			R2_UPLOADS: env.MEDIA ? '1' : '',
			CF_IMAGES: env.MEDIA && env.IMAGES ? '1' : '',
		};
	}
}
WooCheckout.outboundByHost = {
	'worker.internal': async (request, env) => {
		ENV = env;
		const raw = await request.text();
		if (env.CONTAINER_TRACE) console.log('c>', raw.slice(0, 140));
		const reply = await handleMessage(raw);
		return new Response(reply, { headers: { 'content-type': 'application/json' } });
	},
};

const CHECKOUT_ROUTE = /^\/wc\/store(\/v1)?\/checkout\/?$/;
const ADD_TO_CART_ROUTE = /^\/wc\/store(\/v1)?\/cart\/add-item\/?$/;
function restRoute(url) {
	return url.searchParams.get('rest_route') || (url.pathname.startsWith('/wp-json/') ? url.pathname.slice(8) : '');
}
function isCheckout(url) {
	return CHECKOUT_ROUTE.test(restRoute(url)) || /^\/checkout\/?$/.test(url.pathname) || url.searchParams.get('pagename') === 'checkout';
}
// The instance name. Change CHECKOUT_INSTANCE to start a new instance on the
// current image (a running instance keeps its image).
function checkoutContainer(env) {
	return getContainer(env.WOO_CHECKOUT, env.CHECKOUT_INSTANCE || 'checkout');
}

// Spike: time N sequential D1 statements from where this code runs.
async function d1ping(req, env, url, ctx) {
	// #1087: on approach A the reads run under the PHP lock, on a connection of their own (withPhp's withDbRun).
	return dbHandler ? withPhp(() => d1pingRun(req, env, url, ctx)) : d1pingRun(req, env, url, ctx);
}
async function d1pingRun(req, env, url, ctx) {
	const n = Math.min(50, Number(url.searchParams.get('n') || 20));
	const ms = [];
	// Approach A: the same 20 reads through Hyperdrive (the first one opens the connection).
	let connectMs = null;
	for (let i = 0; i < n; i++) {
		const t = Date.now();
		if (dbHandler) {
			const r = await dbHandler.query(env, { mysql: "SELECT option_value FROM wp_options WHERE option_name = 'siteurl'" });
			if (!r.ok) return Response.json({ error: r.error }, { status: 500 });
		} else await env.DB.prepare('SELECT option_value FROM wp_options WHERE option_name = ?').bind('siteurl').first();
		if (i === 0 && dbHandler) connectMs = Date.now() - t;
		else ms.push(Date.now() - t);
	}
	const n2 = ms.length;
	ms.sort((a, b) => a - b);
	return Response.json({ n: n2, first: connectMs, min: ms[0], median: ms[n2 >> 1], max: ms[n2 - 1], colo: req.cf && req.cf.colo });
}

// Outbound HTTP for PHP (php/http-bridge.php, issue #26). WordPress's wp_remote_*()
// requests come here and go out with fetch(). The design is WordPress
// Playground's; HostlessWP does the same (runtime/src/http.js).
// - timeout: one AbortSignal for the whole request, redirects included.
// - redirection: redirects are followed here, up to WordPress's count, so each
//   hop is checked like the first (loopback, allowlist). 303, and 301 or 302 on
//   a POST, become a GET without a body, as browsers do.
// - limit: the body is read up to WordPress's limit_response_size, and never
//   past HTTP_MAX_BYTES (default 8 MB): the answer crosses the bridge as base64.
// - HTTP_ALLOW_HOSTS (comma list; a host or ".suffix"): unset uses the default
//   (.wordpress.org, .woocommerce.com, .gravatar.com). Empty denies every host.
//   "*" allows every http(s) host.
// - A request to the site's own host is refused at once. The PHP object runs one
//   request at a time, so a request to itself waits behind itself (a timeout, or
//   "Durable Object is overloaded"). WordPress treats the error like any failed
//   request (Site Health's loopback check, the plugin editor's fatal check).
const HTTP_MAX_BYTES = 8 * 1024 * 1024;
function httpRefusal(url) {
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'only http and https';
	if (bootOrigin && url.hostname === new URL(bootOrigin).hostname) return 'a request to this site itself is refused: the PHP object runs one request at a time, so it would wait on itself';
	const raw = ENV && ENV.HTTP_ALLOW_HOSTS !== undefined ? ENV.HTTP_ALLOW_HOSTS : undefined;
	if (!httpHostAllowed(url.hostname, resolveHttpAllowHosts(raw))) return 'host not in HTTP_ALLOW_HOSTS: ' + url.hostname;
	return null;
}
async function httpOp(op) {
	stats.httpCalls++;
	// #352: an outbound call that is not a read is seen by others: a commit point (keep what came before).
	if (undoLog && undoLog.frameOpen() && sqlDb && !/^(GET|HEAD|OPTIONS)$/i.test(String(op.method || 'GET'))) undoLog.commitPoint(sqlDb, 'http');
	const t0 = Date.now();
	let url;
	let out;
	try {
		url = new URL(op.url);
		const max = Number(ENV.HTTP_MAX_BYTES || HTTP_MAX_BYTES);
		const limit = op.limit > 0 ? Math.min(op.limit, max) : max;
		const timeoutMs = Math.max(1, Number(op.timeout) || 5) * 1000;
		const signal = AbortSignal.timeout(timeoutMs);
		let method = op.method || 'GET';
		let body = op.body ? b64decode(op.body) : undefined;
		const headers = new Headers(op.headers || {});
		let redirects = 0;
		let res;
		for (;;) {
			const why = httpRefusal(url);
			if (why) {
				out = { error: why };
				return out;
			}
			res = await fetch(url, { method, headers, body, redirect: 'manual', signal });
			const loc = res.headers.get('location');
			if ([301, 302, 303, 307, 308].includes(res.status) && loc && (op.redirection || 0) > 0) {
				// As Requests does: redirection 0 returns the redirect itself; past the count is an error.
				if (redirects >= op.redirection) {
					await res.body?.cancel().catch(() => {}); // discarding a body must not fail the request (it threw in the object)
					out = { error: 'Too many redirects' };
					return out;
				}
				await res.body?.cancel().catch(() => {}); // discarding a body must not fail the request (it threw in the object)
				url = new URL(loc, url);
				redirects++;
				if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
					method = 'GET';
					body = undefined;
					headers.delete('content-type');
					headers.delete('content-length');
				}
				continue;
			}
			break;
		}
		const chunks = [];
		let size = 0;
		let truncated = false;
		if (res.body && method !== 'HEAD') {
			const reader = res.body.getReader();
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				const room = limit - size;
				if (value.length > room) {
					chunks.push(value.subarray(0, room));
					size += room;
					truncated = true;
					await reader.cancel().catch(() => {});
					break;
				}
				chunks.push(value);
				size += value.length;
			}
		}
		const bytes = new Uint8Array(size);
		let at = 0;
		for (const c of chunks) {
			bytes.set(c, at);
			at += c.length;
		}
		const hdrs = [];
		for (const [k, v] of res.headers) if (k !== 'set-cookie') hdrs.push([k, v]);
		for (const c of res.headers.getSetCookie ? res.headers.getSetCookie() : []) hdrs.push(['set-cookie', c]);
		out = { status: res.status, statusText: res.statusText, headers: hdrs, body: b64encode(bytes), redirects, url: url.href, truncated };
		return out;
	} catch (e) {
		const name = e && e.name;
		out = { error: name === 'TimeoutError' || name === 'AbortError' ? `Operation timed out after ${Math.round(Number(op.timeout) * 1000) || 5000} milliseconds` : String((e && e.message) || e) };
		return out;
	} finally {
		stats.httpMs += Date.now() - t0;
		console.log(JSON.stringify({ m: 'http', host: url ? url.hostname : null, status: out && out.status, error: out && out.error ? String(out.error).slice(0, 120) : undefined, ms: Date.now() - t0 }));
	}
}

// Real SQL transactions for PHP with the database in the object (#60) and the REQUEST FRAME on the
// same undo log (#352, REQUEST_FRAMES=on): undo-log.mjs, where the design and the tests live
// (tests/undo-log.test.mjs). One instance per isolate: recover() runs once, in the PhpRuntime
// constructor, before anything reads the database.
let undoLog = null;
let undoFailOn = false; // #809's seam (fault-inject.mjs undoFailSet): throwaway and local sites only
async function dropOptionsGroup() {
	// #954: the options group holds alloptions, which carries active_plugins. Drop the Map now.
	// Drop L2 too, so a new isolate does not read a list a commit point already published.
	for (const k of [...objectCache.keys()]) if (ocGroupOf(k) === 'options') objectCacheDrop(k);
	if (!ocL2On()) return;
	const prefix = 'oc:' + encodeURIComponent('options\u0000');
	let cursor;
	try {
		do {
			const page = await ENV.OC_KV.list({ prefix, cursor });
			for (const k of page.keys || []) {
				try { await ocL2Writer().del(k.name); } catch { /* the next restore lists again */ }
			}
			cursor = page.list_complete ? undefined : page.cursor;
		} while (cursor);
	} catch (e) {
		console.log(JSON.stringify({ m: 'options-cache-drop-failed', error: String((e && e.message) || e).slice(0, 160) }));
	}
}
function undo(env = ENV) {
	// frames is asked at each arm, from the env of the call or ENV: the first undo() of a deployed object is
	// the constructor's recovery, before any fetch has set ENV (pf352f, 2026-11-14: no frame ever armed).
	if (!undoLog) undoLog = createUndoLog({ stats, objectCacheDrop, log: (o) => console.log(JSON.stringify(o)), frames: () => !!((env || ENV) && (env || ENV).REQUEST_FRAMES === 'on'), undoFault: () => (undoFailOn ? UNDO_FAIL_MESSAGE : null), dropOptionsCache: () => dropOptionsGroup() });
	return undoLog;
}
function txnOp(db, storage, op) {
	return undo().txnOp(db, storage, op);
}
async function txnRecover(db, storage) {
	try {
		const r = undo().recover(db, storage);
		await undo().finishCacheDrops();
		if (r && r.r2 && r.r2.length) await deleteFrameR2(r.req, r.r2); // #1039: the dead request's files go with its rows
		return r;
	} catch (e) {
		try { await undo().finishCacheDrops(); } catch { /* the row is already back; a cache miss reads it */ }
		console.error(JSON.stringify({ m: 'txn', recoverFailed: String((e && e.message) || e).slice(0, 200) }));
		return null;
	}
}
// After a PHP run: a PHP transaction still open is rolled back (MySQL on connection close), and a frame is
// KEPT. A run that saw an isolate reset cannot write any more: the frame stays open in storage, and the
// next isolate rolls it back (that is the point), so a failure here is logged, never thrown.
function txnEnd(db, storage) {
	try {
		undo().end(db, storage);
	} catch (e) {
		console.error(JSON.stringify({ m: 'txn', endFailed: String((e && e.message) || e).slice(0, 200) }));
	}
}

// Spike: time N statements on the object's SQLite (db=object) or on D1 (db=d1),
// from inside the object. A Worker's clock does not move during CPU work, so on
// Cloudflare the object numbers may read 0: read CPU time in wrangler tail.
async function dbping(env, url, sql) {
	const db = url.searchParams.get('db') || (sql ? 'object' : 'd1');
	const n = Math.min(5000, Number(url.searchParams.get('n') || 20));
	const q = "SELECT option_value FROM wp_options WHERE option_name = 'siteurl'";
	const t0 = Date.now();
	if (db === 'object') {
		if (!sql) return new Response('DB_IN_DO is off', { status: 409 });
		for (let i = 0; i < n; i++) sql.exec(q).toArray();
	} else {
		if (!env.DB) return new Response('no DB binding', { status: 409 });
		for (let i = 0; i < n; i++) await env.DB.prepare(q).first();
	}
	const ms = Date.now() - t0;
	return Response.json({ db, n, totalMs: ms, perStatementMs: ms / n, databaseBytes: sql ? sql.databaseSize : null });
}

// PHP in a Durable Object (issue #28). The design is from HostlessWP
// (github.com/hostlesswp/hostlesswp, GPL-2.0-or-later, runtime/src/index.js,
// PhpRuntime and render()). On Workers Free a Worker request stops at about 2 s
// of CPU, less than a cold WordPress start. A Durable Object request may use
// 30 s. With PHP_IN_DO=on the Worker keeps static assets, R2 uploads and the
// page cache, and sends every request that needs PHP to this object. The object
// runs the same code as the Worker (handle, withPhp, handleMessage), with its
// own bindings (DB, MEDIA, IMAGES) from the same wrangler env.
// One statement on the object's SQLite, in the reply form of the D1 path
// (handleMessage). exec() is synchronous and returns a cursor. Differences from
// D1 handled here:
// - changes and last_row_id: D1 returns them in meta. Here they come from
//   changes() and last_insert_rowid(), read in the same synchronous turn.
//   total_changes() before and after tells if this statement changed rows, so
//   a statement that changes nothing reports 0, as D1 does.
// - A BLOB comes back as an ArrayBuffer; it goes to PHP as {"$b": base64}, and
//   {"$b"} parameters are bound as bytes, as on the D1 path.
// - Booleans are bound as 1 and 0.
// BEGIN, COMMIT and SAVEPOINT never reach here: d1-pdo.php answers them in PHP,
// as for D1 (sql.exec() refuses them).
function sqlChanges(db, run) {
	const before = db.exec('SELECT total_changes()').raw().next().value[0];
	run();
	const after = db.exec('SELECT total_changes()').raw().next().value[0];
	return after === before ? 0 : db.exec('SELECT changes()').raw().next().value[0];
}
function sqlParams(params) {
	return (params || []).map((v) => (v && typeof v === 'object' && typeof v.$b === 'string' ? b64decode(v.$b).buffer : typeof v === 'boolean' ? (v ? 1 : 0) : v));
}
function sqlRow(row) {
	let blob = false;
	for (let i = 0; i < row.length; i++) {
		const v = row[i];
		if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) {
			const bytes = v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
			row[i] = { $b: b64encode(bytes) };
			blob = true;
		}
	}
	return blob;
}
function sqlStatement(db, m) {
	const t = Date.now();
	stats.calls++;
	try {
		// #766: the injected statement failure (a measurement; fault-inject.mjs). It throws before the statement runs,
		// so nothing of it reaches the storage, and the catch below records it as the platform's reset would be.
		if (sqlFailAt && String(m.sql).includes(sqlFailAt)) {
			sqlFailAt = null;
			console.log(JSON.stringify({ m: 'fault-inject', at: 'sql-fail', sql: String(m.sql).slice(0, 160) }));
			throw new Error(sqlFailMsg);
		}
		const params = sqlParams(m.params);
		// #352: the statement runs through the undo log. The request frame opens with the first statement that
		// changes a row, in one storage transaction with it; a statement that changes nothing takes the open
		// back (a DDL is a commit point). The bound params go too, so a plugin status write can be held (#938).
		const run = () => sqlRun(db, m, params);
		const { reply } = undoLog ? undoLog.statement(db, sqlStorage, m.sql, run, params) : run();
		// #730: the statement, and the frame's opening transaction with it, has returned. The request's INSERT into
		// wp_posts is the point to kill, so every injected kill is post-write. The kill is a memory reset by the platform.
		if (faultPending && isFaultTarget(m.sql, reply)) {
			faultPending = false;
			console.log(JSON.stringify({ m: 'fault-inject', at: 'after-insert', req: faultReq }));
			const r = exhaustMemory({ held: faultHeld });
			console.log(JSON.stringify({ m: 'fault-not-killed', ...r }));
		}
		stats.ms += Date.now() - t;
		stats.log.push('ok  ' + m.sql.slice(0, 160).replace(/\s+/g, ' '));
		return reply;
	} catch (e) {
		stats.ms += Date.now() - t;
		const error = String((e && e.message) || e);
		noteFailure({ sql: m.sql.slice(0, 400), error });
		stats.log.push('ERR ' + m.sql.slice(0, 160).replace(/\s+/g, ' ') + ' => ' + error.slice(0, 120));
		return { ok: false, error };
	}
}
// One statement and its reply; rowsWritten is what the storage counted, for the undo log's no-op check.
function sqlRun(db, m, params) {
	const returnsRows = /^\s*(SELECT|PRAGMA|WITH|VALUES|EXPLAIN)\b/i.test(m.sql) || /\bRETURNING\b/i.test(m.sql);
	let reply;
	let rowsWritten = 0;
	if (returnsRows) {
		const cur = db.exec(m.sql, ...params);
		const rows = [...cur.raw()];
		// Billed units (Durable Objects pricing): rows read and written.
		stats.rowsRead += cur.rowsRead;
		stats.rowsWritten += cur.rowsWritten;
		rowsWritten = cur.rowsWritten;
		if (undoLog) undoLog.afterStatement(db, m.sql, cur.rowsWritten);
		let blob = false;
		for (const row of rows) blob = sqlRow(row) || blob;
		reply = { ok: true, columns: cur.columnNames || [], rows, changes: 0, last_row_id: 0, blob };
	} else {
		let changes = 0;
		changes = sqlChanges(db, () => {
			const cur = db.exec(m.sql, ...params);
			cur.toArray();
			stats.rowsRead += cur.rowsRead;
			stats.rowsWritten += cur.rowsWritten;
			rowsWritten = cur.rowsWritten;
			if (undoLog) undoLog.afterStatement(db, m.sql, cur.rowsWritten);
		});
		const insert = changes > 0 && /^\s*(INSERT|REPLACE)\b/i.test(m.sql);
		reply = { ok: true, columns: [], rows: [], changes, last_row_id: insert ? db.exec('SELECT last_insert_rowid()').raw().next().value[0] : 0 };
	}
	return { reply, rowsWritten };
}

// Move a site in or out (DB_IN_DO). The dump is JSON lines: {"sql"} for each
// table, then {"sql","params"} for each row, then {"sql"} for each index,
// trigger and view, then {"end":true,"rows":N}. A dump without the end line is
// incomplete. Tables of SQLite and of Cloudflare (sqlite_*, _cf_*) are left out.
// Source: the object's SQLite, or ?from=d1 for the DB binding (moving a B site
// from D1). It runs under the PHP lock, so no PHP request writes meanwhile.
const DUMP_PAGE = 500;
function quoteId(name) {
	return '"' + String(name).replace(/"/g, '""') + '"';
}
function dumpSource(env, from) {
	if (from === 'd1') {
		if (!env.DB) throw new Error('no DB binding');
		return async (sql, params = []) => {
			const [columns, ...rows] = await env.DB.prepare(sql).bind(...params).raw({ columnNames: true });
			for (const row of rows)
				for (let i = 0; i < row.length; i++) {
					const v = row[i];
					if (v !== null && typeof v === 'object') row[i] = v instanceof ArrayBuffer ? v : ArrayBuffer.isView(v) ? v : Uint8Array.from(v).buffer;
				}
			return { columns: columns || [], rows };
		};
	}
	return async (sql, params = []) => {
		const cur = sqlDb.exec(sql, ...params);
		const rows = [...cur.raw()];
		return { columns: cur.columnNames, rows };
	};
}
async function dumpTo(writer, env, from) {
	const enc = new TextEncoder();
	const line = (o) => writer.write(enc.encode(JSON.stringify(o) + '\n'));
	try {
		const q = dumpSource(env, from);
		// The undo log of real transactions (_wp_undo*: its tables and triggers) is not data:
		// the target makes its own on the first BEGIN (8l), so it is not in the dump.
		const master = await q("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE '\\_wp\\_undo%' ESCAPE '\\' AND sql IS NOT NULL ORDER BY rowid");
		const tables = master.rows.filter((r) => r[0] === 'table');
		for (const [, , sql] of tables) await line({ sql });
		let total = 0;
		for (const [, name] of tables) {
			for (let off = 0; ; off += DUMP_PAGE) {
				const page = await q(`SELECT * FROM ${quoteId(name)} LIMIT ? OFFSET ?`, [DUMP_PAGE, off]);
				const insert = `INSERT INTO ${quoteId(name)} (${page.columns.map(quoteId).join(', ')}) VALUES (${page.columns.map(() => '?').join(', ')})`;
				for (const row of page.rows) {
					sqlRow(row);
					await line({ sql: insert, params: row });
				}
				total += page.rows.length;
				if (page.rows.length < DUMP_PAGE) break;
			}
		}
		for (const [, , sql] of master.rows.filter((r) => r[0] !== 'table')) await line({ sql });
		await line({ end: true, rows: total });
	} catch (e) {
		await line({ error: String((e && e.message) || e) }).catch(() => {});
	}
	await writer.close().catch(() => {});
}
// Import a dump, or part of one, into the object's SQLite: all lines of one
// request in one transaction. A failing line rolls the request back.
// The object must hold no tables, unless replace is set: then every table,
// index, trigger and view (not sqlite_* or _cf_*) is dropped first, in the same
// transaction. Any PHP request to an empty object makes the SQLite driver
// create its own _wp_sqlite_* tables, so "empty" rarely stays true.
// append is for the second and later parts of one dump (dbmove.py): the tables
// of the first part exist, so the check and the drop are skipped. replace and
// append together are refused.
const USER_OBJECTS = "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND sql IS NOT NULL";
function importInto(db, storage, text, replace, append) {
	if (replace && append) throw new Error('replace=1 and append=1 together: replace is for the first part, append for the others');
	let n = 0;
	let end = null;
	storage.transactionSync(() => {
		const existing = append ? [] : [...db.exec(USER_OBJECTS).raw()];
		if (existing.length && !replace) throw new Error(existing.length + ' tables or indexes exist; import with replace=1 to drop them first');
		if (replace) for (const [type, name] of existing) if (type === 'table' || type === 'view') db.exec(`DROP ${type.toUpperCase()} IF EXISTS ${quoteId(name)}`);
		for (const raw of text.split('\n')) {
			if (!raw.trim()) continue;
			const o = JSON.parse(raw);
			if (o.error) throw new Error('the dump has an error line: ' + o.error);
			if (o.end) {
				end = o;
				continue;
			}
			db.exec(o.sql, ...sqlParams(o.params)).toArray();
			n++;
		}
	});
	return { ok: true, statements: n, end };
}

// OPcache statistics of the runtime (php.run, not a WordPress request).
// opHits subtracts 1: this script's own compile counts as a hit or a miss.
async function opcacheStats(php) {
	try {
		const r = await php.run({ code: '<?php $s = function_exists("opcache_get_status") ? opcache_get_status(false) : false; echo json_encode($s ? array("hits" => $s["opcache_statistics"]["hits"], "misses" => $s["opcache_statistics"]["misses"], "cached" => $s["opcache_statistics"]["num_cached_scripts"], "full" => $s["cache_full"]) : null);' });
		return JSON.parse(r.text) || null;
	} catch {
		return null;
	}
}

// When the Worker sent the request (Date.now()). The object's inbox wait is its
// own Date.now() at the start of fetch minus this. With the database in the
// object, PHP never yields to the event loop (no I/O), so a second request
// cannot start until the first ends: that wait is before fetch, where no
// counter in the object can see it. On Cloudflare the two clocks are on two
// machines (skew of a few ms).
const SENT_HEADER = 'x-perf-sent';
// The visitor's origin, from the Worker. On Cloudflare the object got the URL
// as http://<host>:443/..., so WP_HOME was wrong and every logged-out page
// answered 301 to that URL (measured 2026-11-05, wp-do-free). The Worker
// always sets this header (a visitor's value is replaced), and only the
// Worker can reach the object, so the object can trust it.
const ORIGIN_HEADER = 'x-wp-public-origin';
// #296 (3): set by the front Worker on a request it moved to an overflow pool object (overflow.mjs). Only
// the Worker sets it; a client copy is always dropped. The object then does not arm its cron alarm: N pool
// objects must not become N WordPress cron runners.
const OVERFLOW_HEADER = 'x-pf-overflow';
// #296 (3)(c): set by the front Worker when it can retry this request elsewhere (not Turnstile-gated). The object then
// answers busy (503, x-php-busy) instead of queueing, before it runs anything. Only the Worker sets it.
const OVERFLOW_BUSY_OK_HEADER = 'x-pf-busy-ok';
// A request whose declared body is over this stays in the Worker, which stages large bodies in R2 (#296 (3)).
const OVERFLOW_MAX_BODY = 1024 * 1024;
// One picker per isolate, per pool size (the in-flight counts are what this isolate sent).
let ovPicker = null;
function ovPickerFor(pool) {
	if (!ovPicker || ovPicker.pool !== pool) ovPicker = { pool, p: createPicker(pool) };
	return ovPicker.p;
}
export class PhpRuntime extends DurableObject {
	// #352: an isolate that died with a frame or a transaction open is rolled back FIRST, before any request,
	// alarm, /_dbexport or snapshot reads the database (blockConcurrencyWhile holds them all).
	constructor(ctx, env) {
		super(ctx, env);
		ENV = env;
		if (env.DB_IN_DO === 'on' && env.REAL_TRANSACTIONS !== 'off') ctx.blockConcurrencyWhile(async () => { await txnRecover(ctx.storage.sql, ctx.storage); });
	}
	// Page cache purges for the whole site (issue #78). PHP runs in this one
	// object (PHP_DO_POOL=1), so every change of content passes here. The
	// Worker's PURGE_GAP_MS was per isolate: a burst of parallel writes reached
	// several isolates and each purged (measured on wp-perf-dosql: 20 purges in
	// 32 s). Here one alarm sends one purge for everything asked since the last
	// purge, at most one per PURGE_GAP_MS, as c1 does in its Store object. The
	// state is stored, so a purge asked for survives an evicted object. A
	// refused purge stays pending and is retried with a back-off until no cached
	// copy can still be served (#699, purge-state.mjs). With a pool of more than
	// one object, each object coalesces on its own.
	async requestPurge() {
		const now = Date.now();
		// #699: the rules are purge-state.mjs onAsk. A purge already pending (or waiting out a refusal) covers this change.
		const a = onAsk(await this.ctx.storage.get(PURGE_STATE_KEY), now);
		await this.ctx.storage.put(PURGE_STATE_KEY, a.st);
		if (a.alarmAt != null) await setAlarmRecorded(this.ctx.storage, a.alarmAt, now, 'purge-request');
		console.log(JSON.stringify({ m: 'purge', asked: 1, t: now, coalesced: a.coalesced ? 1 : 0, waitMs: a.alarmAt != null ? a.alarmAt - now : 0, where: 'object' }));
		return a.coalesced ? 'coalesced' : 'scheduled';
	}

	async alarm() {
		// The next tick is armed FIRST (#291, alarm-arm.mjs armBeforeRun): a run killed below (an
		// isolate reset) still leaves a future alarm. A purge retry sets a sooner one, which replaces it.
		this.tickAt = await armBeforeRun(this.ctx.storage, Date.now(), Number((this.env && this.env.CRON_INTERVAL_MS) || 60000));
		// No error leaves alarm() (#291): a throw spends the platform retry budget, and an object that
		// used it up got no alarm at all afterwards. The error is stored for /_purgestate instead.
		try {
			// #1057: this object's durable mail store (email-retry.mjs): its due retries go first, with no PHP, bounded
			// like the cron drain; a cron leg below that fails a send stores it here too (inCronLeg).
			objStorage = this.ctx.storage;
			inCronLeg = true;
			const drained = await boundedWait(mailRetryDrain(this.env, this.ctx.storage).catch((e) => console.log(JSON.stringify({ m: 'email-retry', drainError: String((e && e.message) || e).slice(0, 160) }))), SEND_TIMEOUT_MS);
			// #1059: the next mail retry, so the idle back-off below never passes it (mailRetryArm only pulls sooner).
			this.mailNext = drained && drained !== TIMED_OUT ? drained.next : null;
			await this.alarmRun();
		} catch (e) {
			const rec = await recordAlarmFatal(this.ctx.storage, e, Date.now());
			console.log(JSON.stringify({ m: 'alarm', fatal: rec.error, count: rec.count }));
		} finally {
			inCronLeg = false;
		}
	}

	async alarmRun() {
		// Phase 2 (#185): run due background work (Action Scheduler + WP-Cron) off the request
		// path, so deferred WC order emails fire with no traffic. DISABLE_WP_CRON stays on; this
		// alarm is the only cron driver. One alarm also coalesces purges, below.
		try {
			// A hibernated DO wakes into a fresh isolate: the request-captured module globals
			// (lastOrigin, ENV) are gone and only ctx.storage survives, so an idle low-traffic site
			// would skip cron forever and its deferred WC order emails would never fire (#191). Use
			// this.env (always present on the DO) and SITE_ORIGIN (deploy.sh always emits it), with
			// the persisted origin as a fallback, and gate on the resolved values, not the globals.
			ENV = this.env;
			// A test seam (CRON_SIMULATE_COLD=1): a real Cloudflare alarm wakes a hibernated DO into a
			// fresh isolate where the module globals are gone, which no single persistent local isolate
			// reproduces. Nulling them here makes the local alarm take the same cold path, so the bind
			// below (issue #208) is exercised by tests/cron-cold.py. Off by default; prod never sets it.
			if (this.env.CRON_SIMULATE_COLD === '1') { sqlDb = null; sqlStorage = null; dropRuntime(); }
			const cronOrigin = lastOrigin || this.env.SITE_ORIGIN || (await this.ctx.storage.get(ORIGIN_KEY));
			// A database import in progress holds the cron off (import-hold.mjs): a cron run between two
			// import parts boots WordPress on a half-loaded database, in the same isolate, and the next
			// part ran out of memory (fdprobe1112a, 2026-11-12).
			const importHeld = cronHeld(await this.ctx.storage.get(IMPORT_HOLD_KEY), Date.now());
			if (importHeld) console.log(JSON.stringify({ m: 'cron', held: 'import' }));
			// A store move holds the cron for its copy (#479, move-hold.mjs).
			const moveHeld = cronHeld(await this.ctx.storage.get(MOVE_HOLD_KEY), Date.now());
			if (moveHeld) console.log(JSON.stringify({ m: 'cron', held: 'move' }));
			// A purge alarm (every PURGE_GAP_MS under writes) runs the cron leg only when the last one
			// started at least CRON_INTERVAL_MS ago (#470): the purge still goes out below either way.
			const lastCron = await this.ctx.storage.get(CRON_LAST_KEY);
			const legDue = cronLegDue(lastCron, Date.now(), Number(this.env.CRON_INTERVAL_MS || 60000)) || cronBacklogDue(await this.ctx.storage.get(CRON_BACKLOG_KEY), Date.now(), cronBacklogGapMs(this.env));
			// #969: a request that just queued a Woo email pulls this leg forward. The conformance
			// poll is 30s. The default interval is 60s, and a busy poll used to skip the leg.
			const emailDueAt = Number(await this.ctx.storage.get(EMAIL_DUE_KEY) || 0);
			const emailRush = emailRushDue(emailDueAt, Date.now());
			// A leg that keeps dying waits before it tries again (#471, cron-health.mjs): 2, 4, 8 ... min.
			const prevRun = await this.ctx.storage.get(CRON_RUN_KEY);
			const bo = cronBackoff(prevRun, Date.now());
			// #390: the idle gate, from the site's own state and BEFORE any PHP boot (cron-idle.mjs). Nothing due in WP-Cron
			// or Action Scheduler: no leg, and the alarm backs off. Unreadable state runs the leg. CRON_IDLE_GATE=off: as before.
			const idle = legDue && !emailRush && this.env.CRON_IDLE_GATE !== 'off' ? await this.cronIdle(Date.now()) : null;
			if (idle && idle.idle) {
				// #1059 review: only the tick this alarm armed is extended; a purge retry, a budget wait or deferred mail keeps its time.
				const backedOff = await extendIfOurs(this.ctx.storage, this.tickAt, idle.alarmAt, Date.now(), 'idle');
				await this.ctx.storage.put(IDLE_KEY, { n: idle.streak + 1, t: Date.now() });
				console.log(JSON.stringify({ m: 'cron', skipped: 'idle', streak: idle.streak + 1, nextInMs: idle.alarmAt - Date.now(), backedOff, wpNext: idle.wp && idle.wp.next, asNext: idle.as && idle.as.next }));
			}
			const cronGo = (legDue || emailRush) && !bo.waitMs && !importHeld && !moveHeld && phpPending === 0 && Date.now() - lastSpikeEndAt > SPIKE_CRON_GRACE_MS && cronOrigin && this.env && !(idle && idle.idle);
			// Why a tick skipped the cron, for /_purgestate cronSkip (#291: a skip was invisible).
			if (!cronGo) await this.ctx.storage.put(CRON_SKIP_KEY, { t: Date.now(), notDue: !legDue, sinceLastMs: lastCron ? Date.now() - Number(lastCron) : null, backoff: bo.waitMs ? { deaths: bo.deaths, waitMs: bo.waitMs } : null, importHeld, moveHeld, phpPending, sinceSpikeMs: Date.now() - lastSpikeEndAt, origin: !!cronOrigin });
			if (!legDue && !emailRush) console.log(JSON.stringify({ m: 'cron', skipped: 'not-due', sinceLastMs: Date.now() - Number(lastCron) }));
			else if (bo.waitMs) console.log(JSON.stringify({ m: 'cron', skipped: 'backoff', deaths: bo.deaths, waitMs: bo.waitMs, lastMark: (prevRun && prevRun.lastMark) || null, lastFatal: (prevRun && prevRun.lastFatal) || null }));
			// The poll holds the PHP lock. Try again in a moment instead of waiting out the full interval (#969).
			if (!cronGo && emailRush && phpPending > 0 && !importHeld && !moveHeld && !bo.waitMs) {
				await setAlarmRecorded(this.ctx.storage, Date.now() + EMAIL_RETRY_MS, Date.now(), 'email-due');
			}
			if (cronGo) {
				if (emailRush) await this.ctx.storage.delete(EMAIL_DUE_KEY);
				if (idle && idle.streak) await this.ctx.storage.delete(IDLE_KEY); // #390: work again, the back-off starts over
				// Stored BEFORE the run (#470): a run an isolate reset kills still counts as the last one.
				await this.ctx.storage.put(CRON_LAST_KEY, Date.now());
				await this.ctx.storage.delete(CRON_BACKLOG_KEY); // #1120: consumed by this leg; a leg that dies leaves no mark behind
				// The run record (#471), synced before PHP runs, so a leg the isolate kills is counted.
				const runStart = cronRunStart(prevRun, Date.now());
				if (runStart.died) console.log(JSON.stringify({ m: 'cron', died: runStart.rec.deaths, lastMark: runStart.rec.prevMark, lastFatal: runStart.rec.prevFatal }));
				await this.ctx.storage.put(CRON_RUN_KEY, runStart.rec);
				if (typeof this.ctx.storage.sync === 'function') await this.ctx.storage.sync();
				// #394: the ledger at the start of a cron leg, when MEM_LEDGER=on (a cron leg has no operator header).
				ledgerActive = this.env.MEM_LEDGER === 'on'; ledgerId = null; ledgerFailLogged = false; sqlMeter.reset();
				ledgerInfl0 = { n: stats.inflates, b: stats.inflateBytes, r: stats.reinflates, ae: inflateArena ? inflateArena.counts.evicts : 0 };
				if (ledgerActive) ledgerLog('cron-start');
				const runStorage = this.ctx.storage;
				cronRunSink = async (patch) => {
					const cur = (await runStorage.get(CRON_RUN_KEY)) || {};
					await runStorage.put(CRON_RUN_KEY, { ...cur, ...patch });
				};
				// DB_IN_DO: bind the object's own SQLite as WordPress's database before the cron runtime
				// loads WP. The fetch path sets this per request (sqlDb = sql); the alarm runs on a woken
				// isolate where the module globals are gone, so without this sqlDb is null and every cron
				// DB query misses the object store. A b-dosql deploy has NO D1 binding, so handleMessage
				// then falls through to an undefined ENV.DB and the driver connect fatals with "Cannot
				// escape data without an active database connection" (the exact wrangler tail error). The
				// alarm/fetch race on wake is why it is intermittent, not constant (issue #208).
				const sql = this.env.DB_IN_DO === 'on' ? this.ctx.storage.sql : null;
				sqlDb = sql;
				sqlStorage = sql ? this.ctx.storage : null;
				const realTxn = sql && this.env.REAL_TRANSACTIONS !== 'off';
				if (realTxn) await txnRecover(sql, this.ctx.storage);
				let cr;
				let mail = null;
				try {
					const cleanDue = cronCleanDue(await this.ctx.storage.get(CRON_CLEAN_KEY), Date.now());
					mail = tickMailFor(this.env, this.ctx.storage);
					try {
						// #809: no cron write under a stranded frame (it would be erased at the recovery). The leg is
						// deferred, as a refused boot is; the next tick is already armed (armBeforeRun) and recovers first.
						if (realTxn && undo().stranded()) {
							console.log(JSON.stringify({ m: 'cron', deferred: 'frame-stranded' }));
							cr = { deferred: 'frame-stranded' };
						} else cr = await runCron(() => (bootPromise ??= boot(cronOrigin)), cleanDue, mail);
					} catch (e) {
						if (!(e && e.bootRefused)) throw e;
						// #598 part 2: the leg is deferred, not a death: it ran nothing, the run record closes as done
						// below, and the next leg comes at the usual interval (CRON_LAST_KEY was stored before it).
						// boot() has already dropped the refused promise.
						console.log(JSON.stringify({ m: 'cron', deferred: 'boot-refused', ...e.bootRefused }));
						cr = { deferred: 'boot-refused' };
					}
					if (cr && cr.cleaned) await this.ctx.storage.put(CRON_CLEAN_KEY, Date.now());
					// Finished (#471): the death count resets. A throw above leaves it unfinished, so it counts. A
					// deferred leg ran nothing: closed, the deaths kept, the deferral recorded (#705 second review, 7).
					cronRunSink = null;
					const runRec = await this.ctx.storage.get(CRON_RUN_KEY);
					await this.ctx.storage.put(CRON_RUN_KEY, cr && cr.deferred ? cronRunDeferred(runRec, Date.now(), cr.deferred) : cronRunDone(runRec, Date.now()));
				} finally {
					cronRunSink = null;
					// A cron run that left a transaction open is rolled back, as a request is (MySQL rolls
					// back on connection close); a throw is re-raised to the outer catch after this.
					if (realTxn && undo().phpTxnOpen()) txnEnd(sql, this.ctx.storage);
				}
				// Send what runCron just enqueued (the deferred WC order mails). The request path drains
				// pendingEmails at the end of a request; the alarm is the ONLY drain when no request
				// follows (a low-traffic store), so without this the queued order emails sit in the
				// module global and are lost on the next isolate recycle (#185). AWAIT the sends, NOT
				// this.ctx.waitUntil: DurableObjectState.waitUntil does not keep work alive past the alarm
				// returning (CF docs: it exists mainly for API compatibility), so a send handed to it was
				// abandoned and never delivered on the real DO (box: drained but sent:0). Awaiting makes the
				// send part of the promise alarm() returns, which the runtime is guaranteed to wait on. The
				// wait is BOUNDED (SEND_TIMEOUT_MS): a stuck or throttled env.EMAIL.send must not hold the
				// alarm until the DO wall-clock kills it, which drops the whole cron record (#194); a send
				// still in flight at the bound finishes during the rest of the alarm, or the DO alarm retry
				// is the backstop.
				const drained = pendingEmails.length;
				const sp = sendPending(this.env);
				if (sp) await boundedWait(sp, SEND_TIMEOUT_MS);
				const cst = (await this.ctx.storage.get(PURGE_STATE_KEY)) || {};
				// queued = cumulative wp_mail messages enqueued; sent = cumulative actually delivered (now
				// current, since the alarm awaits the sends); drained = handed off this tick. The old single
				// 'emails' field counted ENQUEUES and read as delivery, which it was not (#185).
				// handedOff/held/lostWrites (#362): this tick's mail, handed off from inside the op, and the
				// writes it lost to a reset. A tick the reset kills writes no record; its email-handoff lines
				// in Workers Logs are the count.
				if (cr && cr.deferred) {
					// #705 second review, finding 7: no cron work ran; the summary and the log say so, and keep the last
					// leg that did run (lastRan) instead of claiming a completed tick.
					cst.cron = { t: Date.now(), deferred: cr.deferred, lastRan: cst.cron && cst.cron.lastRan, drained, queued: (stats.email || 0), sent: (stats.emailSent || 0) };
				} else {
				cst.cron = { t: Date.now(), ...cr, lastRan: cr.ran, drained, queued: (stats.email || 0), sent: (stats.emailSent || 0), ...mail.counts, lostWrites: mail.lostWritesSeen() };
				// One line per completed tick (#335): the backlog it left and the WP-Cron event it ran, so
				// the drain rate and WP-Cron starvation can be read from Workers Logs (/_purgestate keeps
				// only the last tick).
				console.log(JSON.stringify({ m: 'cron', done: 1, as_actions: cr.as_actions, as_stop: cr.as_stop, as_pass: cr.as_pass, as_dates: cr.as_dates, as_hooks: cr.as_hooks, as_pending: cr.as_pending, as_due: cr.as_due, legMs: cr.legMs, wasmMib: cr.wasmMib, wp_cron_hooks: cr.wp_cron_hooks, wp_cron_skipped: cr.wp_cron_skipped, wp_cron_due: cr.wp_cron_due, mail: mail.counts, lostWrites: mail.lostWritesSeen() }));
				// #1120: a leg that made progress with work still due brings the next one in CRON_BACKLOG_GAP_MS, not the interval. The soon
				// alarm only moves an alarm EARLIER (a sooner purge or mail alarm keeps its time); every gate above still applies.
				const streak = backlogStreak(await this.ctx.storage.get(CRON_BACKLOG_STREAK_KEY), cr.as_due);
				const backlogArgs = { approachA: approachACronEnabled(this.env), asDue: cr.as_due, asStop: cr.as_stop, asActions: cr.as_actions, gapMs: cronBacklogGapMs(this.env) };
				const backlogIn = cronBacklogNext({ ...backlogArgs, streak: streak.n });
				if (backlogIn) {
					await this.ctx.storage.put(CRON_BACKLOG_KEY, Date.now());
					await this.ctx.storage.put(CRON_BACKLOG_STREAK_KEY, streak);
					const at = Date.now() + backlogIn;
					const cur = await this.ctx.storage.getAlarm();
					if (cur === null || cur === undefined || Number(cur) > at) await setAlarmRecorded(this.ctx.storage, at, Date.now(), 'as-backlog');
					console.log(JSON.stringify({ m: 'cron', backlog: cr.as_due, nextInMs: backlogIn, stop: cr.as_stop || 'none', noProgress: streak.n }));
				} else {
					await this.ctx.storage.delete(CRON_BACKLOG_KEY);
					// Capped (work due and actions ran, but as_due has not fallen for BACKLOG_MAX_LEGS legs): keep the record, so the
					// interval holds until as_due falls (which resets it).
					if (cronBacklogNext({ ...backlogArgs, streak: 0 })) { await this.ctx.storage.put(CRON_BACKLOG_STREAK_KEY, streak); console.log(JSON.stringify({ m: 'cron', backlogCapped: streak.n, backlog: cr.as_due })); }
					else await this.ctx.storage.delete(CRON_BACKLOG_STREAK_KEY);
				}
				}
				await this.ctx.storage.put(PURGE_STATE_KEY, cst);
				// The #370 dedupe markers expire after DEDUPE_TTL_MS (14 days by default: past any Action
				// Scheduler retry). Bounded: at most 128 a tick (the storage delete limit), so a big backlog cannot hold the alarm.
				await pruneDedupe(this.ctx.storage, Date.now(), Number(this.env.DEDUPE_TTL_MS || 14 * 86400000));
			}
		} catch (e) {
			// A thrown runCron (a transient boot failure, a runtime recycle, a 1101) leaves bootPromise
			// pointing at a failed boot; without this reset the next tick's `bootPromise ??=` reuses the
			// failure and every later tick throws too, so a low-traffic store's deferred order emails
			// never drain until a request reboots the runtime (#191). Reset so the next tick reboots fresh.
			dropRuntime();
			cronRunSink = null; // #471: no cron leg is running any more
			// #348: the thrown message starts with WordPress's HTML error page, so the
			// first 200 characters never reach the fatal. Log the fatal from stderr.
			const detail = cronFailureLine(e);
			console.log(JSON.stringify({ m: 'cron', error: detail.error, errMsg: detail.errMsg, errFile: detail.errFile, errLine: detail.errLine, stderrHead: detail.stderrHead }));
			// Visible in /_purgestate too (#291): wrangler tail shows nothing for a dispatch script's alarm.
			const cst = (await this.ctx.storage.get(PURGE_STATE_KEY)) || {};
			cst.cron = { t: Date.now(), error: detail.error, errMsg: detail.errMsg, errFile: detail.errFile, errLine: detail.errLine, stderrHead: detail.stderrHead, stack: detail.stack };
			await this.ctx.storage.put(PURGE_STATE_KEY, cst);
		}
		// #699: purge-state.mjs. A refused purge stays pending and is retried with a back-off (12, 24, 48 s) until no
		// cached copy can still be served (PAGE_CACHE_TTL + stale-while-revalidate, purgeWindowMs); then it expires.
		const due = onDue(await this.ctx.storage.get(PURGE_STATE_KEY), Date.now(), purgeWindowMs(this.env));
		// #699 part B: before a send, ask the account's purge budget (pf-purge-budget) for a token. Fail-open: with no
		// binding, or a budget that cannot answer, the send goes ahead as part A (purge-budget-client.mjs).
		const budgetSite = due.action === 'send' ? siteHost(this.env.SITE_ORIGIN) : '';
		const gate = due.action === 'send' ? await budgetAcquire(this.env, budgetSite) : null;
		if (gate && gate.via === 'budget' && !gate.grant) {
			// Not now: the stored state is untouched (still pending, no attempt counted); come back when the budget says.
			const now = Date.now();
			await setAlarmRecorded(this.ctx.storage, gate.retryAt, now, 'purge-budget');
			console.log(JSON.stringify({ m: 'purge-budget', grant: false, waitMs: gate.retryAt - now, where: 'object' }));
		} else if (due.action === 'expire') {
			await this.ctx.storage.put(PURGE_STATE_KEY, due.st);
			// Not an m: purge line: doctor's guard counts every m: purge line as asked or sent (#688).
			console.log(JSON.stringify({ m: 'purge-expired', expired: due.st.expired, where: 'object' }));
		} else if (due.action === 'send') {
			// Cleared before the purge: a change during the purge asks for the next one.
			await this.ctx.storage.put(PURGE_STATE_KEY, due.st);
			let r;
			try {
				r = await this.ctx.exports.Pages.purge(['wp-pages']);
			} catch (e) {
				r = { ok: false, errors: [String((e && e.message) || e).slice(0, 200)] };
			}
			const ok = !!(r && r.ok);
			const errors = (r && r.errors) || [];
			const error = (r && r.error) || null;
			disposeRpc(r); // #510: its fields are copied above
			const now = Date.now();
			// A change during the purge may have asked again: onResult reads the current state.
			const res = onResult(await this.ctx.storage.get(PURGE_STATE_KEY), now, { ok, errors, error }, due.covered);
			const sent = { t: due.st.lastSent, ok, errors, error, attempt: due.covered.attempts + 1, ageMs: due.st.lastSent - due.covered.firstAsked, outcome: res.outcome, retryMs: res.alarmAt != null ? res.alarmAt - now : 0, budget: gate ? gate.via : null };
			console.log(JSON.stringify({ m: 'purge', sent: 1, ...sent, where: 'object' }));
			// The last 20 sends, for /_purgestate: wrangler tail does not show alarm runs.
			res.st.sends = [...(res.st.sends || []), sent].slice(-20);
			await this.ctx.storage.put(PURGE_STATE_KEY, res.st);
			if (res.alarmAt != null) await setAlarmRecorded(this.ctx.storage, res.alarmAt, now, 'purge-retry');
			// Refused although the budget granted it: another user spent the account bucket. The budget empties itself.
			if (res.outcome === 'refused' && gate && gate.via === 'budget') await budgetRefused(this.env, budgetSite);
		}
		// Keep the cron cadence unless the purge logic set a sooner retry alarm.
		await rearm(this.ctx.storage, Date.now(), Number((ENV && ENV.CRON_INTERVAL_MS) || 60000));
	}

	// #390: is the cron leg idle? Reads the cron option and Action Scheduler's next pending action from this object's
	// database (the object's SQLite, Hyperdrive MySQL, or D1), with no PHP. Returns idleDecision plus what it read.
	async cronIdle(now) {
		const env = this.env;
		const st = (await this.ctx.storage.get(IDLE_KEY)) || { n: 0 };
		const p = tablePrefix(env);
		const q = async (sql) => {
			if (env.DB_IN_DO === 'on') return [...this.ctx.storage.sql.exec(sql).raw()];
			if (dbHandler && typeof dbHandler.oneShot === 'function') {
				const r = await dbHandler.oneShot(env, sql);
				if (!r || !r.ok) throw new Error(String((r && r.error) || 'no answer'));
				return r.rows || [];
			}
			if (env.DB) return (await env.DB.prepare(sql).raw()) || [];
			throw new Error('no database');
		};
		let wp = null;
		let as = { known: false };
		try {
			const r = await q(`SELECT option_value FROM ${p}options WHERE option_name = 'cron'`);
			wp = r.length ? wpCronState(String(r[0][0]), Math.floor(now / 1000)) : { due: false, next: null };
		} catch {
			wp = null;
		}
		try {
			const r = await q(`SELECT MIN(scheduled_date_gmt) FROM ${p}actionscheduler_actions WHERE status = 'pending'`);
			as = { known: true, next: r.length ? parseGmt(r[0][0]) : null };
		} catch (e) {
			// No Action Scheduler table (no WooCommerce): nothing pending. Any other error: unknown, so the leg runs.
			as = /no such table|doesn't exist|1146/i.test(String((e && e.message) || e)) ? { known: true, next: null } : { known: false };
		}
		const d = idleDecision({ now, intervalMs: Number(env.CRON_INTERVAL_MS || 60000), streak: Number(st.n) || 0, emailRush: false, wp, as, mailNext: this.mailNext });
		return { ...d, streak: Number(st.n) || 0, wp, as };
	}

	async fetch(raw) {
		objStorage = this.ctx.storage; // #1057: this object's durable mail store (mailStoreFor decides whether it is the one)
		const env = this.env;
		ENV = env;
		const objectUrl = new URL(raw.url);
		// #352: the outcome of a request's frame, for the front Worker's write-loss answer (never a client: the
		// Worker answers a client's /_frame itself). It needs no public origin, so it is answered before the
		// origin guard below (pf352f at ebb62f5: every probe got 500 "missing x-wp-public-origin").
		if (objectUrl.pathname === '/_frame') {
			const db = env.DB_IN_DO === 'on' ? this.ctx.storage.sql : null;
			if (!db || env.REAL_TRANSACTIONS === 'off') return Response.json({ frame: null, reason: 'no undo log' });
			await txnRecover(db, this.ctx.storage);
			return Response.json({ frame: undo(env).status(db, objectUrl.searchParams.get('id') || '') });
		}
		// #1057: a rejected send handed over by the approach A Worker (mailRetryPut). Stored here; this object's alarm
		// drains it. GET ?count=1 is the dead-letter count for Site Health. Internal only (the Worker 404s the path).
		if (objectUrl.pathname === MAIL_RETRY_PATH) {
			if (raw.headers.get(MAIL_RETRY_HEADER) !== '1' || !approachACronEnabled(env)) return new Response('forbidden', { status: 403 });
			if (raw.method === 'GET') return Response.json({ dead: await mailDeadCount(this.ctx.storage) });
			if (raw.method !== 'POST') return new Response('method', { status: 405 });
			let records = [];
			try { records = await raw.json(); } catch { return new Response('bad json', { status: 400 }); }
			if (!Array.isArray(records)) return new Response('bad records', { status: 400 });
			await mailRetryStore(this.ctx.storage, records.filter((r) => Array.isArray(r) && typeof r[0] === 'string' && r[0].startsWith('email-retry:') && r[1]));
			return Response.json({ ok: true, stored: records.length });
		}
		// #855: the Workers Cron tick from the site Worker (POST + x-pf-cron-tick). A WATCHDOG for this object's cron alarm:
		// the alarm runs the leg (alarm(), armBeforeRun keeps the chain, the b-dosql hardened path); the tick only re-arms
		// an alarm that is missing or stale (snapshotRearm, as #841's daily re-arm). Running alarm() here too ran the cron
		// leg about twice a minute (each tick, plus the alarm it had just re-armed).
		if (objectUrl.pathname === CRON_TICK_PATH) {
			if (raw.method !== 'POST' || raw.headers.get(CRON_TICK_HEADER) !== '1' || !approachACronEnabled(env)) {
				return new Response('forbidden', { status: 403 });
			}
			const tickOrigin = raw.headers.get(ORIGIN_HEADER);
			if (!tickOrigin) return new Response('missing ' + ORIGIN_HEADER, { status: 500 });
			lastOrigin = tickOrigin;
			await this.ctx.storage.put(ORIGIN_KEY, tickOrigin);
			const watch = await snapshotRearm(this.ctx.storage, Date.now(), Number(env.CRON_INTERVAL_MS || 60000));
			if (watch.state !== 'ok') console.log(JSON.stringify({ m: 'alarm', rearmedBy: 'a-cron-tick', was: watch.state }));
			const pulled = await pullIn(this.ctx.storage, Date.now(), Number(env.CRON_INTERVAL_MS || 60000), 'a-cron-tick');
			// #1059: on A a page request runs in the Worker, so this tick is what pulls a backed-off (#390) alarm back in.
			if (pulled.pulled) console.log(JSON.stringify({ m: 'alarm', pulledBy: 'a-cron-tick', wasInMs: pulled.was - Date.now() }));
			return Response.json({ ok: true, tick: 'cron', alarm: watch.state, at: watch.at, ...(pulled.pulled ? { pulled: true } : {}) }, { headers: { 'cache-control': 'no-store' } });
		}
		const origin = raw.headers.get(ORIGIN_HEADER);
		// Without it, the object does not guess an origin: a wrong one redirects every page.
		if (!origin) return new Response('missing ' + ORIGIN_HEADER, { status: 500 });
		const url = new URL(objectUrl.pathname + objectUrl.search, origin);
		// Only a real request arms/feeds the cron alarm. The deploy-time spike endpoints
		// (/_install, /_activate) run a long direct php.run that bypasses withPhp; arming the
		// alarm there let it fire runCron mid-activation and its php.run output replaced the
		// activation's (WooCommerce did not activate, #185). A real visitor (a page, an order)
		// arms it instead, which is when the deferred work actually needs to run.
		// An overflowed request (#296 (3)) never arms the cron alarm: the pool objects only absorb a queue.
		const overflowed = raw.headers.get(OVERFLOW_HEADER) === '1';
		// #296 (3)(c): this object already runs or holds PHP, and the Worker can send the request elsewhere: answer busy
		// now, before anything runs (no cron arm, no PHP, no write), so the queue never moves into the pool.
		if (overflowed && raw.headers.get(OVERFLOW_BUSY_OK_HEADER) === '1' && objectBusy({ running: phpLock.running, waiting: phpLock.waiting })) {
			return new Response(null, { status: 503, headers: { 'x-php-busy': '1', 'cache-control': 'no-store', 'retry-after': '1' } });
		}
		// #708: the Worker's start-by and correlation id (the Worker sends none on a control path, review2 6).
		const startByHeader = raw.headers.get(START_BY_HEADER);
		const callId = raw.headers.get(CALL_HEADER);
		// #715 review2 5: a real request writes its origin and arms cron INSIDE its PHP run (below), so a request refused
		// or shed before it runs has written nothing, and x-write-loss: none is exact.
		const armsCron = !url.pathname.startsWith('/_') && !overflowed;
		const inboxMs = raw.headers.get(SENT_HEADER) ? Date.now() - Number(raw.headers.get(SENT_HEADER)) : null;
		// #708: PHP never sees the Worker's start-by or correlation id.
		const req = new Request(raw);
		req.headers.delete(START_BY_HEADER);
		req.headers.delete(CALL_HEADER);
		req.headers.delete(OVERFLOW_HEADER);
		req.headers.delete(CRON_TICK_HEADER);
		req.headers.delete(ORIGIN_HEADER);
		req.headers.delete(SENT_HEADER);
		// The front Worker's Turnstile answer (#351): kept for this request's PHP run, never shown to PHP.
		const turnstileHeader = takeResultHeader(req.headers);
		// #1087: no connection reset here (outside the PHP lock); withPhp's withDbRun owns the connection's life.
		// The Worker checked the spike token already. Checked again: the object
		// trusts nothing it did not check itself.
		// #394 L1: the OPcache boot packs live under /_pf/ in the static assets. They hold compiled PHP of
		// the site's code, so no request may read them; only the object fetches them, through the binding.
		if (url.pathname.startsWith('/_pf/')) return new Response('Not Found', { status: 404 });
		// The scheduled snapshot (#533, db-snapshot.mjs): its own key, SNAPSHOT_TOKEN, never SPIKE_TOKEN.
		// Checked here again, like the spike token: the object trusts nothing it did not check itself.
		if (url.pathname === SNAPSHOT_PATH) {
			const gate = snapshotGate(req, env);
			if (gate !== 'ok') return gateResponse(gate);
			// #841: re-arm the cron alarm FIRST (only a re-arm; no cron runs here). This call reaches every object daily,
			// even a fully edge-cached site's, where no request re-arms a deleted alarm. Its state goes in the snapshot.
			const snapAlarm = await snapshotRearm(this.ctx.storage, Date.now(), Number(env.CRON_INTERVAL_MS || 60000));
			if (snapAlarm.state !== 'ok') console.log(JSON.stringify({ m: 'alarm', rearmedBy: 'snapshot', was: snapAlarm.state }));
			const sql = env.DB_IN_DO === 'on' ? this.ctx.storage.sql : null;
			if (!sql || !env.MEDIA) return Response.json({ ok: false, error: 'no-db-or-bucket' }, { status: 409 });
			const held = cronHeld(await this.ctx.storage.get(IMPORT_HOLD_KEY), Date.now());
			const r = await takeSnapshot({ dump: (w) => withPhp(() => ((sqlDb = sql), dumpTo(w, env, 'object'))), media: env.MEDIA, build: BUILD_ID, held, alarm: snapAlarm });
			console.log('@event snapshot ' + JSON.stringify(r.body));
			return Response.json(r.body, { status: r.status, headers: { 'cache-control': 'private, no-store' } });
		}
		const spikeOk = Boolean(env.SPIKE_TOKEN) && req.headers.get('x-spike-token') === env.SPIKE_TOKEN;
		if (url.pathname.startsWith('/_') && !spikeOk) return new Response('forbidden', { status: 403 });
		// MySQL import (#31, #551). The front Worker forwards here when PHP_IN_DO=on,
		// because this isolate holds the MySQL client (index-a-lean.js). No client
		// (b-dosql, SQLite in the object): sqlImport answers 404, as before. The token
		// was checked above; sqlImport checks it again. The prefix rule is unchanged.
		if (url.pathname === '/_sqlimport') return sqlImport(req, env, url, dbHandler);
		// Spike: the URL the object got, and the origin it uses.
		if (url.pathname === '/_origin') return Response.json({ objectUrl: raw.url, publicOrigin: origin, used: url.href });
		// The purge state of this object (issue #78): pending, last sent, the last 20 sends, the next alarm.
		if (url.pathname === '/_purgestate') return Response.json({ ...((await this.ctx.storage.get(PURGE_STATE_KEY)) || {}), alarm: await this.ctx.storage.getAlarm(), alarmSet: (await this.ctx.storage.get(ALARM_SET_KEY)) || null, alarmFatal: (await this.ctx.storage.get(ALARM_FATAL_KEY)) || null, cronSkip: (await this.ctx.storage.get(CRON_SKIP_KEY)) || null, cronRun: (await this.ctx.storage.get(CRON_RUN_KEY)) || null, now: Date.now() });
		// The build this OBJECT is running (issue #35 slice 5). After a re-upload a
		// warm object keeps the old code until it is evicted, so this reports the
		// object's version, which can lag the Worker's until /_evict or a sleep.
		if (url.pathname === '/_build') return Response.json({ build: BUILD_ID, engine: PHP_ENGINE, recycleMiB: recycleLine(env, ENGINE_RECYCLE_MIB).mib }); // #771: engine and line
		// #394 headroom probe (HEADROOM_PROBE=on, off by default; a MEASUREMENT that ends this isolate, so
		// only on a throwaway). After a real request, this same isolate allocates held 1 MiB ArrayBuffers
		// until it dies, streaming the count (headroom.mjs). The first line is the ledger at that moment, so
		// 255 (a bare isolate, #394 floor probes) minus the reach minus its wasmMiB is what the runtime holds
		// outside the wasm heap. No PHP lock: it never runs PHP. gc reports whether a forced GC exists.
		if (url.pathname === '/_headroom') {
			if (env.HEADROOM_PROBE !== 'on') return new Response('Not Found', { status: 404 });
			const snap = ledgerSnapshot('headroom');
			const gcAvailable = typeof globalThis.gc === 'function';
			if (gcAvailable && url.searchParams.get('gc') === '1') globalThis.gc();
			// #394: counted as a PHP-pending holder while it runs, so the alarm's cron gate (cronGo needs
			// phpPending === 0) does not boot PHP in this isolate in the middle of the measurement.
			phpPending++;
			const { response, job } = headroomStream({ first: JSON.stringify({ m: 'headroom', build: BUILD_ID, gc: gcAvailable, ...snap }), max: url.searchParams.get('max') || 1024, every: 16, probe: () => headroomLedger() });
			this.ctx.waitUntil(job.finally(() => { phpPending--; }));
			return response;
		}
		// Reset this object so the next request boots the new code (issue #35
		// slice 5). ctx.abort() may not exist on an older compat date: then 501,
		// and the caller falls back to waiting for the idle sleep.
		if (url.pathname === '/_evict') {
			if (typeof this.ctx.abort !== 'function') return Response.json({ evicted: false, reason: 'ctx.abort is not available on this compatibility date', build: BUILD_ID }, { status: 501 });
			// Drop the PHP runtime too (#279). It lives in module scope (bootPromise), and abort()
			// resets the object, not the isolate: on fdprobe1112e (2026-11-12) the next request ran on
			// the same isolate and the same runtime (x-perf rt 1, rtServed counting on), so
			// plugin-memory.py never read a fresh runtime. Like /_activate, this is a restart on
			// purpose and is not counted in runtimeDrops. #566: released once the PHP queue settles.
			dropRuntime();
			this.ctx.waitUntil(Promise.resolve().then(() => this.ctx.abort('evict for a new build (issue #35)')));
			return Response.json({ evicting: true, build: BUILD_ID });
		}
		const maxBody = env.MEDIA && isMediaUpload(req, url) ? Number(env.MAX_UPLOAD_BYTES || MAX_UPLOAD_BYTES) : Number(env.MAX_BODY_BYTES || MAX_BODY_BYTES);
		// An overflowed request (#296 (3)) hands its purge back to the front Worker: the object's purge alarm is
		// also its cron driver (a pool object must never run cron), and an object cannot purge the Worker's page
		// cache anyway (measured locally: "no cache API").
		const ctx = { inObject: true, storage: this.ctx.storage, waitUntil: (p) => this.ctx.waitUntil(p), requestPurge: overflowed ? async () => 'front' : () => this.requestPurge() };
		ctx.callId = callId; // #708 review 2: per request, so overlapping runs (after a stale takeover) keep their own id
		if (url.pathname === '/_d1ping') return d1ping(req, env, url, ctx);
		// DB_IN_DO=on: WordPress's database is this object's SQLite (8j).
		const sql = env.DB_IN_DO === 'on' ? this.ctx.storage.sql : null;
		if (url.pathname === '/_dbping') return dbping(env, url, sql);
		if (url.pathname === '/_dbexport' && req.method === 'GET') {
			const from = url.searchParams.get('from') === 'd1' ? 'd1' : 'object';
			if (from === 'object' && !sql) return new Response('DB_IN_DO is off', { status: 409 });
			const { readable, writable } = new TransformStream();
			this.ctx.waitUntil(withPhp(() => ((sqlDb = sql), dumpTo(writable.getWriter(), env, from))));
			return new Response(readable, { headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'private, no-store' } });
		}
		if (url.pathname === '/_hold') return moveHoldRequest(this.ctx.storage, req.method, url);
		if (url.pathname === '/_mysqlexport' && req.method === 'GET') {
			// #479: a rows-only, paged export of one table (mysql-export.mjs). Raw sql.exec, no PHP
			// boot, read only; the caller proves it complete against ?stats=1 (COUNT and MAX(rowid)).
			if (!sql) return new Response('DB_IN_DO is off', { status: 409 });
			return exportRequest((q, ...b) => { const c = sql.exec(q, ...b); return { columns: c.columnNames, rows: [...c.raw()] }; }, url);
		}
		if (url.pathname === '/_dbcounts' && req.method === 'GET') {
			// Per-table row counts for the import self-verify (issue #165): bounded
			// (one COUNT(*) per table), so it completes for a large object where a
			// full /_dbexport does not. Raw sql.exec (no PHP boot), read before any
			// page view, so no undo-log tables are made; same data tables as dumpTo.
			if (!sql) return new Response('DB_IN_DO is off', { status: 409 });
			const all = [...sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").raw()].map((r) => r[0]);
			const names = all.filter((n) => !n.startsWith('sqlite_') && !n.startsWith('_cf_') && !n.startsWith('_wp_undo'));
			const rows = {};
			for (const name of names) rows[name] = Number(sql.exec(`SELECT COUNT(*) FROM ${quoteId(name)}`).raw().next().value[0]);
			return Response.json({ rows, databaseBytes: sql.databaseSize });
		}
		if (url.pathname === '/_dbimport' && req.method === 'POST') {
			if (!sql) return new Response('DB_IN_DO is off', { status: 409 });
			// Hold the cron off for the whole import (each part refreshes it; import-hold.mjs).
			await this.ctx.storage.put(IMPORT_HOLD_KEY, Date.now() + IMPORT_HOLD_MS);
			const text = await req.text();
			return withPhp(async () => {
				objectCacheClear(); // the database changes outside WordPress's cache
				try {
					const done = importInto(sql, this.ctx.storage, text, url.searchParams.get('replace') === '1', url.searchParams.get('append') === '1');
					// The pages in the page cache show the old database: the object purges them (issue #78).
					return Response.json({ ...done, databaseBytes: sql.databaseSize }, { headers: { 'x-cache-purge': await this.requestPurge() } });
				} catch (e) {
					return Response.json({ ok: false, error: String((e && e.message) || e) }, { status: 400 });
				}
			});
		}
		// Queue: requests ahead of this one in the PHP lock (a count), and the
		// wait for the lock (the clock moves at the I/O that ends each request).
		const tArrive = Date.now();
		// #708: a request whose start-by has passed never queues and never runs: its caller has given up. Otherwise the
		// remainder is this run's shed bound (the tighter of it and PHP_QUEUE_SHED_MS), and a shed never runs PHP.
		const plan = objectShedPlan(startByHeader, tArrive, phpShedMs(env, true));
		let lateByClock = false;
		// #721: a caller already gone (request.signal, with enable_request_signal) is refused here too: one refusal, before
		// this object writes anything.
		const callerSignal = disconnectSignal(env, raw.signal); // null with OBJECT_DISCONNECT_SHED=off
		const gone = !!(callerSignal && callerSignal.aborted);
		if (plan.refuseNow || gone) {
			console.log(JSON.stringify({ m: 'php-lock', iso: ISOLATE_ID, event: 'shed', at: 'arrive', why: gone ? 'disconnect' : 'start-by', ...(callId ? { call: callId } : {}) }));
			return startByResponse();
		}
		// #715 review3 2: a real request writes its origin and arms cron after the refusal (review2 5: a refused request
		// writes nothing) and OUTSIDE the PHP lock, so this storage I/O never delays a grant. A request shed later in the
		// queue has written only these two: the origin key and the alarm, never site data (x-write-loss is about the site).
		if (armsCron) {
			lastOrigin = origin;
			await this.ctx.storage.put(ORIGIN_KEY, origin);
			// A STALE alarm (long past, its run never completed) counts as none (#291): otherwise it
			// blocks every later arm and the cron stops for good. alarm-arm.mjs.
			// A stale one is deleted, then set (rearm): a re-set alone was not delivered on ggc-test.
			const ra = await rearm(this.ctx.storage, Date.now(), Number((ENV && ENV.CRON_INTERVAL_MS) || 60000));
			if (ra.stale) console.log(JSON.stringify({ m: 'alarm', unstuck: true, was: ra.was }));
			// #390: a request pulls an idle-backed-off alarm back to the normal interval (its work may be due soon).
			if (!ra.armed) {
				const pl = await pullIn(this.ctx.storage, Date.now(), Number((ENV && ENV.CRON_INTERVAL_MS) || 60000));
				if (pl.pulled) await this.ctx.storage.delete(IDLE_KEY);
			}
		}
		const ahead = phpPending;
		const isSpikeLongOp = url.pathname === '/_install' || url.pathname === '/_activate';
		// #603 (B) test seam (BOOT_TEST_DELAY_MS set, a spike request only): drop the runtime OUTSIDE the PHP lock,
		// as /_evict and a stale lock do, so the drop can land in the middle of another request's boot.
		if (bootTestDelayMs(env) && spikeOk && req.headers.get('x-pf-test-drop') === '1') dropRuntime();
		// #962: an idle lookup waits one beat so the templates list can take the lock first.
		const lookupYield = templateLookupYield(req.method, url, phpLock);
		if (lookupYield) await new Promise((resolve) => setTimeout(resolve, lookupYield));
		phpPending++;
		// #296: shed only with PHP_QUEUE_SHED_MS set (the default is never, on every path).
		const objectRun = await withPhp(async () => {
			const waitMs = Date.now() - tArrive;
			sqlDb = sql;
			sqlStorage = sql ? this.ctx.storage : null;
			const realTxn = sql && env.REAL_TRANSACTIONS !== 'off';
			// #809's seam, read BEFORE the recovery: the request that turns it off is the one whose recovery succeeds.
			const uf = undoFailSet(env, spikeOk, req.headers);
			if (uf !== null) { undoFailOn = uf; console.log(JSON.stringify({ m: 'fault-undo', on: uf })); }
			if (realTxn) await txnRecover(sql, this.ctx.storage);
			// #352: arm the request frame (REQUEST_FRAMES=on); it opens at the first write. The Worker sends the id.
			if (realTxn) undo(env).arm(sql, req.headers.get('x-pf-req') || 'obj-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
			// #730: the post-INSERT fault, a measurement for throwaway sites only (fault-inject.mjs).
			faultPending = faultArmed(env, spikeOk, req.headers);
			faultReq = faultPending ? req.headers.get('x-pf-req') : null;
			sqlFailAt = sqlFailNeedle(env, spikeOk, req.headers); // #766
			sqlFailMsg = sqlFailMessage(req.headers);
			// One PHP run at a time (withPhp), so one slot holds this run's answer.
			turnstileSlot.set(turnstileHeader);
			try {
				// #809: a stranded frame (its rollback and the recovery above both failed) is still stored open. Nothing
				// may write under it, so no PHP runs: the answer is the retryable platform failure, until a recovery
				// succeeds (txnRecover above, on the next request). undo-log.mjs refuses its writes as well.
				if (realTxn && undo(env).stranded()) {
					const sf = statementFailureResponse(1, wantsJson(url.pathname, url.search, req.headers.get('accept')), false);
					console.log(JSON.stringify({ '@event': 'frame-stranded-refused', m: 'frame-stranded-refused', method: req.method, path: url.pathname, answered: sf.status }));
					return new Response(sf.body, { status: sf.status, headers: sf.headers });
				}
				const res = await handle(req, env, url, spikeOk, maxBody, ctx);
				if (realTxn) txnEnd(sql, this.ctx.storage);
				try {
					// inMs: from the start of fetch to the response (object clock). The
					// Worker's object time minus inbox minus inMs is the wait to send the
					// response back, which the next request's PHP can block the same way.
					res.headers.set('x-perf-queue', JSON.stringify({ inboxMs, ahead, waitMs, inMs: Date.now() - tArrive }));
				} catch {}
				return res;
			} finally {
				turnstileSlot.clear();
				faultPending = false; // #730: never carried to the next request
				sqlFailAt = null; // #766: nor this
				// A request that threw also ends its transaction (rolled back), and keeps its frame. Idempotent.
				if (realTxn) txnEnd(sql, this.ctx.storage);
				phpPending--;
				// Hold cron off briefly so an externally-armed alarm cannot run runCron in the
				// /_install -> /_activate gap, where /_activate would reuse the cron runtime (#185).
				if (isSpikeLongOp) lastSpikeEndAt = Date.now();
			}
		}, {
			shedMs: plan.shedMs,
			tag: callId ? { call: callId } : null,
			shedWhy: plan.byStartBy ? 'start-by' : 'queue-shed',
			// #715 review2 4, review3 4 and 5: the lock rechecks the start-by at a contended grant, on a clock read again.
			signal: callerSignal, // #721: a queued waiter sheds when its caller disconnects (why: disconnect), unless off
			// #752, #754: the tick is a real subrequest to this site's own TICK_PATH, never to this object.
			recheck: plan.startBy > 0 ? async () => { const rc = await recheckStartBy(plan.startBy, { tick: () => tickFetch(origin), signal: callerSignal }); lateByClock = rc.late; return rc; } : null,
			priority: templateQueuePriority(req.method, url), // #962
			staleAction: 'shed', // #1060: a stuck head sheds this waiter (503), never a second runtime beside it
		});
		if (objectRun !== PHP_SHED) return objectRun;
		phpPending--; // a shed run never ran its finally
		// A start-by shed says so: queued, never ran, safe to retry. The operator's PHP_QUEUE_SHED_MS keeps its own answer.
		return plan.byStartBy || lateByClock ? startByResponse() : phpShedResponse();
	}
}

// Which object serves a request. PHP_DO_POOL objects (default 1) share the
// load; each boots its own PHP. Spike endpoints (/_install, /_opcache-dump,
// /_last, /_mem) always go to php-0, so they see the runtime the tests used.
function phpObjectName(env, url) {
	// DB_IN_DO: the object IS the database, so there is one object.
	const pool = env.DB_IN_DO === 'on' ? 1 : Math.max(1, Math.floor(Number(env.PHP_DO_POOL || 1)));
	if (pool === 1 || url.pathname.startsWith('/_')) return 'php-0';
	return 'php-' + Math.floor(Math.random() * pool);
}

// Seconds a client waits after an overload 503. One object serves about 5
// uncached pages a second (docs/perf-dosql.md), so a full queue drains in
// seconds, not minutes.
const OVERLOAD_RETRY_AFTER_S = '5';

// Delete expired #370 dedupe markers, at most limit per call. Errors are logged, never thrown.
async function pruneDedupe(storage, now, ttlMs, limit = 128) {
	try {
		const old = [];
		for (const [k, t] of await storage.list({ prefix: DEDUPE_PREFIX, limit })) if (!(Number(t) > now - ttlMs)) old.push(k);
		if (old.length) await storage.delete(old);
		return old.length;
	} catch (e) {
		console.log(JSON.stringify({ m: 'email-dedupe', prune: 'failed', error: String((e && e.message) || e).slice(0, 120) }));
		return 0;
	}
}

// runCron(getBooted): getBooted() resolves the runtime INSIDE the PHP lock (#603 B), so no cron boot starts outside
// it, and a runtime a request released while this leg waited for the lock is never the one it runs on. held (#720):
// the caller already holds the lock (/_runcron), so runCron's withPhp reuses it instead of waiting for itself.
async function runCron(getBooted, cleanDue = false, mail = null, { held = false } = {}) {
		// A bounded tick (cron-bound.mjs, #291): our own claim/process loop, not the queue runner,
		// which grew the runtime past the 128 MiB isolate on a big store even for one action.
		const { actions, wpEvents } = cronBounds(ENV, { approachA: approachACronEnabled(ENV) });
		const asBudgetMs = cronAsBudgetMs(ENV);
		return withPhp(async () => {
		const legT0 = Date.now(); // #1120: the leg's wall time and its PHP heap, on the cron line
		const { php } = await getBooted();
		// The tick's mail handoff (#362) is live only for this PHP run.
		tickMail = mail;
		let asN = 0;
		const lineMib = recycleLine(ENV, ENGINE_RECYCLE_MIB).mib;
		const heapNow = () => { try { return php[__private__dont__use].HEAPU8.length / 1048576; } catch { return undefined; } };
		const startHeapMib = heapNow(); // #1120: the stop fires only on growth in THIS leg (the heap is a high-water mark)
		cronMoreGate = () => cronMore({ n: ++asN, startedAt: legT0, now: Date.now(), budgetMs: asBudgetMs, heapMib: heapNow(), startHeapMib, lineMib });
		let r;
		try {
		r = await php.run({ code: `<?php
			// #471: PHP's own fatal error, sent from a shutdown function (it runs after a fatal), and a
			// mark BEFORE each job, so a leg that dies says which job it was running.
			register_shutdown_function( function () {
				$e = error_get_last();
				if ( $e && in_array( $e['type'], array( E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR, E_USER_ERROR, E_RECOVERABLE_ERROR ), true ) && function_exists( 'post_message_to_js' ) ) {
					post_message_to_js( json_encode( array( 'cronFatal' => array( 'type' => (int) $e['type'], 'msg' => substr( (string) $e['message'], 0, 300 ), 'file' => substr( (string) $e['file'], 0, 160 ), 'line' => (int) $e['line'] ) ) ) );
				}
			} );
			$skyphusion_cron_mark = function ( $k, $hook, $id = 0 ) {
				if ( function_exists( 'post_message_to_js' ) ) { post_message_to_js( json_encode( array( 'cronMark' => array( 'k' => $k, 'hook' => substr( (string) $hook, 0, 120 ), 'id' => (int) $id ) ) ) ); }
			};
			require '/wordpress/wp-load.php';
			$ran = array(); $released = 0; $as_n = 0; $as_hooks = array(); $as_dates = array(); $cleaned = 0; $as_stop = null;
			if ( class_exists( 'ActionScheduler' ) || function_exists( 'as_next_scheduled_action' ) ) {
				// Stale-claim recovery (the DO memory-recycle class). This alarm is the only Action
				// Scheduler runner and runs serialized (withPhp + the phpPending gate), so any claim on
				// a PENDING action at the start of a run is an orphan: the run that staked it recycled
				// mid-batch (the 128 MB isolate recycle) after claiming a batch and running only part,
				// leaving the rest claimed-but-unrun so no later claim re-picks them (a lost order
				// email on a quiet store). A never-started pending action is safe to unclaim (attempts
				// 0, it never ran, no duplicate send); native reset only recovers after a 300s timeout.
				global $wpdb;
				$as_t = $wpdb->prefix . 'actionscheduler_actions';
				$as_c = $wpdb->prefix . 'actionscheduler_claims';
				$released = (int) $wpdb->query( "UPDATE {$as_t} SET claim_id = 0 WHERE claim_id != 0 AND status = 'pending'" );
				$wpdb->query( "DELETE FROM {$as_c} WHERE claim_id NOT IN ( SELECT DISTINCT claim_id FROM {$as_t} WHERE claim_id != 0 )" );
				$as_store = ActionScheduler::store(); $as_runner = ActionScheduler::runner();
				// Pass 1 (#357): the woocommerce-emails group (WooCommerce's deferred order emails), NEWEST
				// first. The claim is oldest first by scheduled date, and a store's backlog (2609 attribute
				// lookups and 900 old emails on the sample store) put a new order email about 3492 actions
				// back, about 85 h at the measured 41 actions an hour (fdprobe1112j, 2026-11-12). Newest first
				// so an imported store's old emails cannot block a new one either. The order filter is for
				// this one claim only. stake_claim throws when the group does not exist yet (no email ever
				// queued): that is an empty pass 1.
				$as_pass = 'emails'; $claim = null;
				$as_ids = array();
				$as_newest = function ( $order_by ) { return 'ORDER BY priority ASC, scheduled_date_gmt DESC, action_id DESC'; };
				add_filter( 'action_scheduler_claim_actions_order_by', $as_newest, 10, 1 );
				try { $claim = $as_store->stake_claim( ${actions}, null, array(), 'woocommerce-emails' ); } catch ( Throwable $as_e ) { $claim = null; }
				remove_filter( 'action_scheduler_claim_actions_order_by', $as_newest, 10 );
				// stake_claim STORES the group it was given (ActionScheduler_DBStore::claim_actions,
				// set_claim_filter) and a later claim with no group reuses it: pass 2 then claimed only
				// emails, so a tick with no email due ran nothing (fdprobe1112j, 19:43:57Z, 2613 due).
				if ( method_exists( $as_store, 'set_claim_filter' ) ) { $as_store->set_claim_filter( 'group', '' ); }
				// #969: on cf759a (measured 2026-11-19) stake_claim of woocommerce-emails took nothing
				// while 59 due email actions sat pending, and the tick drained older lookups instead.
				// A direct read is the same rows the list table shows. It runs those before pass 2.
				if ( $claim && count( $claim->get_actions() ) ) {
					$as_ids = $claim->get_actions();
					// #1143: the claim TOOK the newest emails (the order_by above), but Action Scheduler hands the claimed
					// ids back oldest first (find_actions_by_claim_id), and a leg stops at its time budget (#1126). So a
					// leg ran the oldest of the newest batch and walked backwards through a backlog, never reaching a new
					// customer's email (strummer, cf759hx: 75 min). Run them newest first: one query, ids only.
					if ( count( $as_ids ) > 1 ) {
						$as_in     = implode( ',', array_map( 'intval', $as_ids ) );
						$as_sorted = array_values( array_filter( array_map( 'intval', (array) $wpdb->get_col( "SELECT action_id FROM {$as_t} WHERE action_id IN ({$as_in}) ORDER BY scheduled_date_gmt DESC, action_id DESC" ) ) ) );
						if ( count( $as_sorted ) === count( $as_ids ) ) { $as_ids = $as_sorted; }
					}
					// #1143 review: newest first alone is LIFO, so under a steady arrival the oldest due email could wait
					// forever. It gets the second slot of every leg (it is not in the claim, which holds the newest), so a
					// leg that runs two actions moves both ends of the queue. It is CLAIMED first, into this leg's claim, by
					// one atomic UPDATE (claim_id = 0): the alarm is the only regular runner (DISABLE_WP_CRON in
					// php/wp-config.php; php/action-scheduler-alarm-only.php turns off the async request runner and
					// action_scheduler_run_queue in every build; pool objects never run cron), but an operator's /_runcron
					// (spike token) runs this same leg in another isolate. A row another runner holds is skipped.
					$as_g_old  = ( isset( $wpdb->actionscheduler_groups ) && $wpdb->actionscheduler_groups ) ? $wpdb->actionscheduler_groups : $wpdb->prefix . 'actionscheduler_groups';
					$as_oldest = array_values( array_filter( array_map( 'intval', (array) $wpdb->get_col( $wpdb->prepare( "SELECT a.action_id FROM {$as_t} a INNER JOIN {$as_g_old} g ON a.group_id = g.group_id WHERE g.slug = %s AND a.status = %s AND a.claim_id = 0 AND a.scheduled_date_gmt <= %s ORDER BY a.scheduled_date_gmt ASC, a.action_id ASC LIMIT 1", 'woocommerce-emails', 'pending', gmdate( 'Y-m-d H:i:s' ) ) ) ) ) );
					$as_cid = method_exists( $claim, 'get_id' ) ? (int) $claim->get_id() : 0;
					if ( $as_oldest && $as_cid > 0 && ! in_array( $as_oldest[0], $as_ids, true )
						&& 1 === (int) $wpdb->query( $wpdb->prepare( "UPDATE {$as_t} SET claim_id = %d WHERE action_id = %d AND claim_id = 0 AND status = %s", $as_cid, $as_oldest[0], 'pending' ) ) ) {
						array_splice( $as_ids, 1, 0, array( $as_oldest[0] ) );
					}
				} else {
					if ( $claim ) { $as_store->release_claim( $claim ); $claim = null; }
					$as_g = ( isset( $wpdb->actionscheduler_groups ) && $wpdb->actionscheduler_groups ) ? $wpdb->actionscheduler_groups : $wpdb->prefix . 'actionscheduler_groups';
					$as_sql = $wpdb->prepare( "SELECT a.action_id FROM {$as_t} a INNER JOIN {$as_g} g ON a.group_id = g.group_id WHERE g.slug = %s AND a.status = %s AND a.scheduled_date_gmt <= %s ORDER BY a.scheduled_date_gmt DESC, a.action_id DESC LIMIT %d", 'woocommerce-emails', 'pending', gmdate( 'Y-m-d H:i:s' ), (int) ${actions} );
					$as_direct = array_values( array_filter( array_map( 'intval', (array) $wpdb->get_col( $as_sql ) ) ) );
					if ( count( $as_direct ) ) { $as_ids = $as_direct; $as_pass = 'emails-direct'; }
				}
				// Pass 2, only when no due email was found: everything else, oldest first, as before.
				if ( ! count( $as_ids ) ) {
					$as_pass = 'all';
					$claim = $as_store->stake_claim( ${actions} );
					$as_ids = $claim->get_actions();
				}
				foreach ( $as_ids as $as_id ) {
					// #1120: before each further action, the Worker says whether the leg's time budget and heap allow it.
					if ( $as_n > 0 ) { $as_more = function_exists( 'post_message_to_js' ) ? post_message_to_js( json_encode( array( 'cronMore' => $as_n ) ) ) : 'stop'; if ( '1' !== $as_more ) { $as_stop = $as_more; break; } }
					$as_a = $as_store->fetch_action( $as_id ); $as_h = $as_a ? $as_a->get_hook() : '?';
					$as_hooks[ $as_h ] = ( isset( $as_hooks[ $as_h ] ) ? $as_hooks[ $as_h ] : 0 ) + 1;
					// The claimed action's scheduled date (#357), so a tick shows WHICH email it sent: a new one or the backlog.
					$as_sd = ( $as_a && method_exists( $as_a, 'get_schedule' ) && $as_a->get_schedule() && method_exists( $as_a->get_schedule(), 'get_date' ) ) ? $as_a->get_schedule()->get_date() : null; $as_dates[] = $as_sd ? $as_sd->format( 'Y-m-d H:i:s' ) : '?';
					$skyphusion_cron_mark( 'as', $as_h, $as_id );
					$as_runner->process_action( $as_id, 'Skyphusion DO alarm' ); $as_n++;
					// Drop what the action loaded (orders, meta) from the in-request cache, as the queue
					// runner did per batch: without it memory grows with every action (#291).
					if ( function_exists( 'wp_cache_flush_runtime' ) ) { wp_cache_flush_runtime(); }
				}
				if ( $claim ) { $as_store->release_claim( $claim ); }
				// The cleaner (timeouts, failures) on a tick with nothing to do, and at least every
				// CRON_CLEAN_MS on a busy store (cronCleanDue), so a long backlog cannot starve it.
				$cleaned = 0;
				if ( 0 === $as_n || ${cleanDue ? 1 : 0} ) { $as_cleaner = new ActionScheduler_QueueCleaner( $as_store ); $as_cleaner->reset_timeouts(); $as_cleaner->mark_failures(); $cleaned = 1; }
				$ran[] = 'action_scheduler';
			}
			// The WP-Cron leg never runs Action Scheduler's queue runner (#335). Action Scheduler
			// schedules action_scheduler_run_queue every minute, so it was nearly always the earliest
			// due event and took the tick's one WP-Cron slot. Its runner is the unbounded one #323
			// replaced: on the sample store it grew the heap from 99.4 to 119.3 MiB and reset the
			// isolate in 19 of 19 ticks (fdprobe1112g, 2026-11-12). The bounded loop above is the
			// only Action Scheduler runner. So the hook is removed (as /_activate does, #289), and a
			// due run_queue event is skipped when the slot is picked, so the slot goes to the next
			// due event: with the hook removed alone, run_queue still took the slot in 21 of 21 ticks
			// and no other WP-Cron event ran. It is not unscheduled: Action Scheduler would only
			// schedule it again at init.
			remove_all_actions( 'action_scheduler_run_queue' );
			${typeof ENV !== 'undefined' && ENV && ENV.CRON_TEST_FATAL === '1' ? "$skyphusion_cron_mark( 'wp', 'skyphusion_test_fatal' ); skyphusion_undefined_function_471();" : '// CRON_TEST_FATAL (#471): a local test seam, off'}
			$events = 0; $wp_hooks = array(); $skipped = array(); $crons = function_exists( '_get_cron_array' ) ? _get_cron_array() : array();
			// The due WP-Cron hooks other than run_queue, before the leg runs: a tick that runs none
			// while this is not empty would be starving them (#335).
			$wp_due = array(); if ( is_array( $crons ) ) { foreach ( $crons as $dts => $dhooks ) { if ( $dts > time() ) break; foreach ( (array) $dhooks as $dh => $devs ) { if ( 'action_scheduler_run_queue' !== $dh ) { $wp_due[ $dh ] = 1; } } } }
			if ( ${wpEvents} > 0 && is_array( $crons ) ) { $now = time(); foreach ( $crons as $ts => $hooks ) { if ( $ts > $now ) break;
				foreach ( (array) $hooks as $hook => $evs ) { if ( 'action_scheduler_run_queue' === $hook ) { $skipped[ $hook ] = 1; continue; } foreach ( (array) $evs as $ev ) { $wp_hooks[] = $hook;
					// Whether this event's unschedule (and reschedule) was SAVED (#362): a mail the event sends
					// is then its only send, so the Worker hands it off even after a reset (wp_cron 1); when it
					// was not saved the event runs again and the Worker holds the mail (wp_cron -1).
					$wp_ok = true;
					if ( ! empty( $ev['schedule'] ) ) { $wp_r = wp_reschedule_event( $ts, $ev['schedule'], $hook, $ev['args'], isset($ev['interval']) ? $ev['interval'] : 0 ); if ( false === $wp_r || ( function_exists( 'is_wp_error' ) && is_wp_error( $wp_r ) ) ) { $wp_ok = false; } }
					$wp_r = wp_unschedule_event( $ts, $hook, $ev['args'] ); if ( false === $wp_r || ( function_exists( 'is_wp_error' ) && is_wp_error( $wp_r ) ) ) { $wp_ok = false; }
					$GLOBALS['skyphusion_mail_wp_cron'] = $wp_ok ? 1 : -1;
					$skyphusion_cron_mark( 'wp', $hook );
					do_action_ref_array( $hook, $ev['args'] ); $GLOBALS['skyphusion_mail_wp_cron'] = 0; if ( function_exists( 'wp_cache_flush_runtime' ) ) { wp_cache_flush_runtime(); } if ( ++$events >= ${wpEvents} ) { break 3; }
				} } } }
			$as_list = array(); foreach ( $as_hooks as $k => $v ) { $as_list[] = $k . ':' . $v; }
			// The backlog after this tick (#335): what the bounded loop has left to drain.
			$as_pending = null; $as_due = null;
			if ( isset( $as_t ) ) {
				$as_pending = (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$as_t} WHERE status = 'pending'" );
				$as_due = (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$as_t} WHERE status = 'pending' AND scheduled_date_gmt <= '" . gmdate( 'Y-m-d H:i:s' ) . "'" );
			}
			echo json_encode( array( 'ran' => $ran, 'wp_cron_events' => $events, 'wp_cron_hooks' => implode( ',', $wp_hooks ), 'wp_cron_skipped' => implode( ',', array_keys( $skipped ) ), 'wp_cron_due' => implode( ',', array_keys( $wp_due ) ), 'released' => $released, 'as_actions' => $as_n, 'as_stop' => $as_stop, 'as_pass' => isset( $as_pass ) ? $as_pass : null, 'as_dates' => implode( ',', $as_dates ), 'as_hooks' => implode( ',', $as_list ), 'as_pending' => $as_pending, 'as_due' => $as_due, 'cleaned' => $cleaned ) );` });
		} finally {
			tickMail = null;
			cronMoreGate = null;
			evictLazy();
			if (remotePacks) remotePacks.endRequest(); // #563: held packs live for one request
			if (sitePacks) sitePacks.endRequest(); // #569: the site packs too (not the hot pack)
			if (fetchBudget) fetchBudget.reset(); // #569: the request's subrequest budget
			dropBootPack(php[__private__dont__use].FS); // #394 L1: a cron run that booted drops the boot files too
		}
		let out = {};
		try { out = JSON.parse(String(r.text).slice(String(r.text).lastIndexOf('{'))); } catch (e) { out = { parse: String(r.text).slice(-200) }; }
		out.legMs = Date.now() - legT0;
		try { out.wasmMib = Math.round(php[__private__dont__use].HEAPU8.length / 1048576); } catch { /* no heap to read */ }
		return out;
		}, { held });
	}

// The front Worker verifies a gated POST before it reaches the object (#351, turnstile.mjs). It
// returns the header value for the object, or null when the request is not a gated form or carries
// no token (its PHP gate then fails closed on its own). The token and the secret are never logged.
async function preverifyTurnstile(req, env, url) {
	const fields = turnstileEnabled(env) ? await readRouteFields(req) : null;
	const route = turnstileRoute(env, req.method, url, fields);
	if (!route) return null;
	const token = await readGatedToken(route, req.clone());
	if (!token) return { route, value: null, res: null };
	const t0 = Date.now();
	const res = await verifyToken(env.TURNSTILE_SECRET, token, req.headers.get('cf-connecting-ip') || '', {
		timeoutMs: turnstileTimeoutMs(env),
		expect: { hostname: siteHost(env.SITE_ORIGIN), action: TURNSTILE_ACTION },
	});
	console.log(JSON.stringify({ m: 'turnstile', where: 'front', route, success: res.success, codes: res.codes || [], error: res.error, tries: res.tries, ms: Date.now() - t0 }));
	return { route, value: encodeResult(res, token), res };
}

// #352: ask the object (a NEW isolate after a reset) what became of a request's frame. One subrequest, on
// the write-loss path only. null when it cannot answer: then the client gets today's message.
async function frameProbe(env, name, id) {
	if (env.REQUEST_FRAMES !== 'on' || !id) return null;
	try {
		const stub = env.PHP_RUNTIME.get(env.PHP_RUNTIME.idFromName(name), env.PHP_LOCATION ? { locationHint: env.PHP_LOCATION } : undefined);
		const r = await stub.fetch(new Request('https://php-object/_frame?id=' + encodeURIComponent(id)));
		const text = await r.text();
		let j = null;
		try { j = JSON.parse(text); } catch {}
		// The raw answer, so a null state is never a blind spot: status, the body keys, the frame or the reason.
		console.log(JSON.stringify({ m: 'frame-probe-raw', status: r.status, keys: j && typeof j === 'object' ? Object.keys(j) : null, frame: j ? j.frame ?? null : null, reason: j ? j.reason ?? null : null, body: j ? undefined : text.slice(0, 120) }));
		if (!r.ok) return null;
		return (j && j.frame) || null;
	} catch (e) {
		console.log(JSON.stringify({ m: 'frame-probe-raw', error: String((e && e.message) || e).slice(0, 200) }));
		return null;
	}
}
// target (#296 (3), overflow): { name, hint, overflow: true } sends the request to that pool object
// instead of the PHP_IN_DO object. Without it, everything is as before.
// #708: the client sees the call id on every answer of the object path (review 5), so a client-seen 503 joins to its
// object lines. One id per client request (a retry keeps it). /_frame is the operator's own probe and is left as is.
async function toPhpObject(req, env, url, ctx, target = null) {
	const callId = (target && target.callId) || crypto.randomUUID();
	const r = await toPhpObjectCall(req, env, url, ctx, target, callId);
	return url.pathname === '/_frame' ? r : tagCallId(r, callId); // only an answer no cache keeps (review2 1)
}
async function toPhpObjectCall(req, env, url, ctx, target, callId) {
	const name = target ? target.name : phpObjectName(env, url);
	const hint = target ? target.hint : env.PHP_LOCATION;
	// #352: /_frame is the Worker's own probe of the object. A client gets 404; a spike-token holder gets the
	// frame of ?id= (the proof reads it; the request id is in the x-pf-req response header).
	const frameSpikeOk = Boolean(env.SPIKE_TOKEN) && req.headers.get('x-spike-token') === env.SPIKE_TOKEN;
	if (url.pathname === '/_frame' && frameSpikeOk) return Response.json({ frame: await frameProbe(env, name, url.searchParams.get('id') || '') }, { headers: { 'cache-control': 'no-store' } });
	if (url.pathname === '/_frame') return new Response('Not Found', { status: 404 });
	// #352: one id per client request (a retry keeps it), so the probe can ask for this request's frame.
	const pfReq = env.REQUEST_FRAMES === 'on' ? crypto.randomUUID() : null;
	// Turnstile (#351): verified here, before the object, so the object never waits on siteverify.
	const pre = await preverifyTurnstile(req, env, url);
	// The hint applies only when the object is made. D1's primary is in the
	// Chicago area; "enam" is Eastern North America.
	let t0 = Date.now();
	// A GET or HEAD that dies in an object reset (memory #335, or storage #398) is sent once more
	// (object-error.mjs fetchWithMemoryRetry); each attempt makes its own stub and request. A #605 no-answer on GET/HEAD/OPTIONS is retried once.
	// #605: if this attempt has not started answering within the deadline, abort it. Exempt
	// paths (install, import, sqlimport, cron) pass 0 and are not cut. 0 also means the
	// operator set OBJECT_CALL_DEADLINE_S=off.
	const objectDeadlineMs = objectCallExempt(url.pathname) ? 0 : objectCallDeadlineMs(env);
	// #708: a start-by per attempt: the object never starts a request it has not granted by then, so the deadline
	// above only ever catches a request that started. An exempt path never gets one (review 6).
	const startByQ = startByMs(env, objectDeadlineMs, { exempt: startByExempt(url.pathname) }); // review2 6: control paths too
	const res = await fetchWithMemoryRetry(
		() => {
			const stub = env.PHP_RUNTIME.get(env.PHP_RUNTIME.idFromName(name), hint ? { locationHint: hint } : undefined);
			const ac = objectDeadlineMs > 0 ? new AbortController() : null;
			const fwd = new Request(req);
			// Only this Worker sets the Turnstile answer: a copy from the client is always dropped.
			setResultHeader(fwd.headers, pre && pre.value);
			// The same for the overflow mark (#296 (3)).
			fwd.headers.delete(OVERFLOW_HEADER);
			if (target && target.overflow) fwd.headers.set(OVERFLOW_HEADER, '1');
			fwd.headers.delete(OVERFLOW_BUSY_OK_HEADER);
			if (target && target.busyOk) fwd.headers.set(OVERFLOW_BUSY_OK_HEADER, '1');
			fwd.headers.set(ORIGIN_HEADER, siteOrigin(env, url));
			t0 = Date.now();
			fwd.headers.set(SENT_HEADER, String(t0));
			if (pfReq) fwd.headers.set('x-pf-req', pfReq);
			else fwd.headers.delete('x-pf-req');
			// #708: the call id, and this attempt's start-by or none (serve() already dropped any client copy).
			fwd.headers.set(CALL_HEADER, callId);
			if (startByQ > 0) fwd.headers.set(START_BY_HEADER, String(t0 + startByQ));
			else fwd.headers.delete(START_BY_HEADER);
			// The signal goes on the request that is sent. Headers are copied from fwd, which
			// already has the Turnstile answer and the other marks.
			const sent = ac ? new Request(fwd, { signal: ac.signal }) : fwd;
			return callPhpObject(stub, sent, {
				deadlineMs: objectDeadlineMs,
				controller: ac,
				method: req.method,
				objectName: name,
				json: wantsJson(url.pathname, url.search, req.headers.get('accept')),
				pfReq,
			});
		},
		req.method,
		(e, a) => console.log(JSON.stringify({ m: isObjectCallDeadline(e) ? 'object-deadline-retry' : 'isolate-reset-retry', attempt: a, kind: classifyObjectError(e) || (isObjectCallDeadline(e) ? 'no-answer' : null), path: url.pathname, deadlineMs: e.deadlineMs || null, ...memIdOf(req, env), error: String(e.message).slice(0, 200) })),
	).catch((e) => {
		if (req.signal && req.signal.aborted) return { gone: true }; // #721: the caller disconnected (not an object error)
		throw e;
	});
	if (res.gone) {
		console.log(JSON.stringify({ m: 'disconnect', path: url.pathname, method: req.method, call: callId, writeLoss: disconnectAnswer(req.method).headers.get('x-write-loss') }));
		return disconnectAnswer(req.method);
	}
	if (res.deadline) {
		console.log(JSON.stringify({ m: 'object-deadline', path: url.pathname, method: req.method, deadlineMs: res.deadlineMs, attempts: res.attempts, call: callId, ...memIdOf(req, env), answered: res.deadline.status }));
		return res.deadline;
	}
	const retried = res.attempts > 1;
	if (res.error) {
		const e = res.error;
		const kind = res.kind;
		// The object runs one PHP request at a time. Past its queue limit the
		// runtime refuses with "Durable Object is overloaded" (measured
		// 2026-11-05: 27 of 400 at 100 clients, docs/perf-dosql.md). Uncaught,
		// that was an exception and a bare 503 with no body. Answer it: a 503
		// the client can act on, never stored by the page cache in front of the
		// Worker (a cached error would reach readers after the queue drains).
		// An isolate memory reset also comes with e.overloaded set; it gets its own
		// header, x-isolate-reset: memory, not x-overloaded (#335, object-error.mjs).
		// A storage reset (#398) is a reset too: x-isolate-reset: storage, the same retry and the same
		// write-loss answer. A platform internal error (#976) is not a reset. On a method that may
		// have written it still takes the write-loss path (#1004): rows may already be saved, so
		// the client is not told to try again. GET, HEAD and OPTIONS keep the 503. Other errors
		// are thrown as before (fetchWithMemoryRetry rethrows them).
		const reset = isResetKind(kind);
		const tag = reset ? 'isolate-reset' : kind === 'internal' ? 'platform-internal' : 'overloaded';
		console.log(JSON.stringify({ m: tag, kind, path: url.pathname, retried, ...memIdOf(req, env), call: callId, error: String(e.message).slice(0, 200) }));
		// A method that may have written (anything but GET, HEAD or OPTIONS) and died in a reset,
		// or in a platform internal error (#1004): its earlier writes may be saved (#350; #398 saw
		// a page create and a delete saved), so no 503 "try again" and never the dispatcher 502
		// (write-loss.mjs). The frame probe answers rolled back only when it proves rollback.
		if (objectErrorOutcome(kind, req.method) === 'write-loss') {
			// #352: "nothing was saved" only when the object PROVES the frame rolled back.
			const fr = await frameProbe(env, name, pfReq);
			console.log(JSON.stringify({ m: 'frame-probe', phase: 'request-killed', state: fr ? fr.state : null, points: fr ? fr.points : null }));
			const wl = frameProvesRollback(fr) ? rolledBackResponse(wantsJson(url.pathname, url.search, req.headers.get('accept')), kind, fr.undone) : writeLossResponse('unknown', wantsJson(url.pathname, url.search, req.headers.get('accept')), kind);
			// #596: id is the operator perf id. answered is this response's status. PHP never answered here, so there is no phpStatus.
			console.log(JSON.stringify({ '@event': 'write-loss', m: 'write-loss', kind, method: req.method, path: url.pathname, failed: 'unknown', phase: 'request-killed', ...memIdOf(req, env), call: callId, answered: wl.status }));
			wl.headers['x-php-object'] = name;
			if (pfReq) wl.headers['x-pf-req'] = pfReq; // the request id, for a spike-token /_frame read (#352)
			return new Response(wl.body, { status: wl.status, headers: wl.headers });
		}
		const headers = objectErrorHeaders(kind, name, OVERLOAD_RETRY_AFTER_S);
		if (retried) headers['x-isolate-retry'] = '1';
		const bodyText = reset
			? 'The site restarted. Please try again in a few seconds.\n'
			: kind === 'internal'
				? 'The site had an internal error. Please try again in a few seconds.\n'
				: 'The site is busy. Please try again in a few seconds.\n';
		return new Response(bodyText, {
			status: 503,
			headers,
		});
	}
	const r = res.r;
	// #352: the object answered write-loss itself (its storage failed after a reset, PHP ran on): the frame
	// was left open in storage; ask the new isolate whether it was rolled back.
	if (pfReq && r.status === 500 && r.headers.get('x-write-loss') && r.headers.get('x-write-loss') !== 'rolled-back') {
		const fr = await frameProbe(env, name, pfReq);
		console.log(JSON.stringify({ m: 'frame-probe', phase: 'object-answered', state: fr ? fr.state : null, points: fr ? fr.points : null }));
		if (frameProvesRollback(fr)) {
			const rb = rolledBackResponse(wantsJson(url.pathname, url.search, req.headers.get('accept')), r.headers.get('x-isolate-reset') === 'storage' ? 'storage' : 'memory', fr.undone);
			rb.headers['x-php-object'] = name;
			if (pfReq) rb.headers['x-pf-req'] = pfReq;
			return new Response(rb.body, { status: rb.status, headers: rb.headers });
		}
	}
	const out = new Response(r.body, r);
	out.headers.set('x-php-object', name);
	// A Store API checkout refused because the verifier was unreachable: nothing was written, so
	// the client may retry (#351).
	const ra = retryAfterFor(pre && pre.route, pre && pre.res, out.status);
	if (ra) out.headers.set('retry-after', ra);
	// The answer came from the retry after a memory reset (#335): the instrument for the A/B.
	if (retried) out.headers.set('x-isolate-retry', '1');
	// Wall time from the Worker to the object and back, PHP time included.
	const objectMs = Date.now() - t0;
	out.headers.set('x-object-ms', String(objectMs));
	// Server-Timing (docs/perf-dosql.md): object = the Worker's own wall time
	// for the object (its clock moves at this I/O); the rest is from the object.
	try {
		const p = JSON.parse(out.headers.get('x-perf') || '{}');
		const q = JSON.parse(out.headers.get('x-perf-queue') || '{}');
		const t = [`object;dur=${objectMs}`];
		if (q.inboxMs !== undefined && q.inboxMs !== null) t.push(`inbox;dur=${q.inboxMs}`);
		if (q.waitMs !== undefined) t.push(`queue;dur=${q.waitMs};desc="ahead ${q.ahead}"`);
		if (q.inMs !== undefined && q.inboxMs !== undefined && q.inboxMs !== null) t.push(`in;dur=${q.inMs}`, `outbox;dur=${objectMs - q.inboxMs - q.inMs}`);
		if (p.bootWaitMs !== undefined) t.push(`boot;dur=${p.bootWaitMs};desc="boot ${p.boot}"`);
		t.push(...serverTimingPhp(p)); // #716: php is wall time at I/O points, not CPU (the desc says so)
		out.headers.set('server-timing', t.join(', '));
		out.headers.set('x-perf-worker', JSON.stringify({ colo: (req.cf && req.cf.colo) || null, iso: ISOLATE_ID }));
	} catch {}
	return out;
}

const INSTALL = `<?php
define( 'WP_INSTALLING', true );
require '/wordpress/wp-load.php';
require_once ABSPATH . 'wp-admin/includes/upgrade.php';
if ( is_blog_installed() ) { echo json_encode( array( 'installed' => 'already' ) ); exit; }
$pw = trim( (string) @file_get_contents( '/tmp/admin-password' ) );
@unlink( '/tmp/admin-password' );
if ( strlen( $pw ) < 12 ) { echo json_encode( array( 'installed' => false, 'error' => 'admin password missing or shorter than 12' ) ); exit; }
$admin_email = trim( (string) @file_get_contents( '/tmp/admin-email' ) );
@unlink( '/tmp/admin-email' );
// A test deploy keeps the placeholder admin@example.com, which the mail layer now
// drops as undeliverable so its New Order mail never bounces (#198); a real deploy
// sets ADMIN_EMAIL / x-admin-email to a deliverable address.
if ( $admin_email === '' || ! is_email( $admin_email ) ) { $admin_email = 'admin@example.com'; }
$r = wp_install( 'WordPress on D1', 'admin', $admin_email, false, '', $pw );
$tz = trim( (string) @file_get_contents( '/tmp/site-timezone' ) );
@unlink( '/tmp/site-timezone' );
if ( $tz === '' || ! in_array( $tz, timezone_identifiers_list(), true ) ) {
	$tz = 'America/Detroit';
}
update_option( 'timezone_string', $tz );
echo json_encode( array( 'installed' => true, 'user_id' => $r['user_id'], 'timezone_string' => get_option( 'timezone_string' ) ) );
`;

const site = {
	// Every answer passes through here, so the performance headers leave only on a request that
	// may see them (perf-headers.mjs), whichever branch of serve() built the response.
	async fetch(req, env, ctx) {
		// Never store operator responses at the edge (perf-headers.mjs operatorNoStore).
		return operatorNoStore(scrubPerfHeaders(await this.serve(req, env, ctx), perfHeadersAllowed(req, env)), req);
	},
	async serve(req, env, ctx) {
		ENV = env;
		// #708 review 8: only this Worker sets the start-by and the call id. A client copy is dropped on EVERY path
		// (the object path, and this Worker's own PHP, where WordPress would see HTTP_X_PF_*).
		if (req.headers.has(START_BY_HEADER) || req.headers.has(CALL_HEADER)) {
			req = new Request(req);
			req.headers.delete(START_BY_HEADER);
			req.headers.delete(CALL_HEADER);
		}
		const url = new URL(req.url);
		if (url.pathname === '/_ping') return new Response('ok');
		// Approach A's MySQL connection lives one PHP run, inside the PHP lock (#1087, db-lifecycle.mjs withDbRun). A reset
		// here, outside the lock, nulled the socket of a run still executing in another context.
		// Spike endpoints need the SPIKE_TOKEN secret when it is set (always on a deploy).
		// #394 L1: the OPcache boot packs live under /_pf/ in the static assets. They hold compiled PHP of
		// the site's code, so no request may read them; only the object fetches them, through the binding.
		if (url.pathname.startsWith('/_pf/')) return new Response('Not Found', { status: 404 });
		// The scheduled snapshot (#533): the dispatcher's cron calls it with SNAPSHOT_TOKEN (db-snapshot.mjs),
		// so it is gated by that key, not by SPIKE_TOKEN, and goes to the object, which is the database.
		if (url.pathname === SNAPSHOT_PATH) {
			const gate = snapshotGate(req, env);
			if (gate !== 'ok') return gateResponse(gate);
			if (env.PHP_IN_DO !== 'on' || !env.PHP_RUNTIME) return Response.json({ ok: false, error: 'no-object' }, { status: 409 });
			return toPhpObject(req, env, url, ctx);
		}
		const spikeOk = Boolean(env.SPIKE_TOKEN) && req.headers.get('x-spike-token') === env.SPIKE_TOKEN;
		if (url.pathname.startsWith('/_') && !spikeOk) return new Response('forbidden', { status: 403 });
		if (env.MEDIA && (req.method === 'GET' || req.method === 'HEAD') && url.pathname.startsWith('/wp-content/uploads/')) return serveUpload(req, env, url);
		// Signed invoice PDF download (issue #227). The Worker verifies the HMAC the
		// browserRender op minted and streams the PDF from R2; PHP never holds the secret.
		if (env.MEDIA && env.INVOICE_TOKEN && (req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/skyphusion-invoice') return serveInvoice(req, env, url);
		// Static files (build/public) never reach this code (#412). The asset router serves them
		// BEFORE the Worker runs, on a WfP site (measured on ggc.sh 2026-11-13, and the WfP static
		// assets page) and on every spike env and deploy.sh site alike. The Worker sees only a miss,
		// or a run_worker_first path (only /_pf/*, refused above). So a gateway asset lookup here
		// could only miss again; it was removed. The ASSETS binding exists only so the object can
		// fetch the OPcache boot packs (#394 L1): a WfP site has it only with OPCACHE_SPLIT=1.
		// XML-RPC lets one request try many passwords (system.multicall). Off unless XMLRPC=on.
		if (url.pathname === '/xmlrpc.php' && env.XMLRPC !== 'on') return new Response('XML-RPC is off', { status: 403 });
		const maxBody = env.MEDIA && isMediaUpload(req, url) ? Number(env.MAX_UPLOAD_BYTES || MAX_UPLOAD_BYTES) : Number(env.MAX_BODY_BYTES || MAX_BODY_BYTES);
		if (Number(req.headers.get('content-length') || 0) > maxBody) return new Response('request body too large', { status: 413 });
		// WordPress serves no WebSockets. PHP's socket layer opens them to the site
		// itself (during /_install, measured 2026-11-05), and such a request must
		// never reach PHP: it booted a runtime with a wrong origin. This holds for
		// every variant: in variant a (PHP in the Worker) such a request booted the
		// runtime right after /_install with the origin http://127.0.0.1:<port>,
		// while the site is http://localhost:<port>, so every page linked to
		// 127.0.0.1 (2026-11-06, tests/a2/opcache-diag.sh, issue #50).
		if (req.headers.get('upgrade')) {
			console.log(JSON.stringify({ m: 'ws-refused', host: req.headers.get('host'), path: url.pathname }));
			return new Response('WebSocket is not served', { status: 426 });
		}
		// Import a MySQL dump (issue #31): variant a, where dbHandler is the MySQL
		// bridge. With PHP_IN_DO=on that bridge lives in the PhpRuntime isolate
		// (index-a-lean.js), so the request goes there (#551). Every other variant
		// gets the 404 of sql-import.js. A missing object binding is the same 500
		// as every other PHP_IN_DO request.
		if (url.pathname === '/_sqlimport') {
			if (env.PHP_IN_DO === 'on') {
				return env.PHP_RUNTIME ? toPhpObject(req, env, url, ctx) : new Response('PHP_IN_DO=on needs the PHP_RUNTIME Durable Object binding', { status: 500 });
			}
			return sqlImport(req, env, url, dbHandler);
		}
		// The cache versions table and its triggers (#296 (2), cache-versions.mjs): approach A only.
		// op=status (default), install (all or nothing; versioned false when the provider cannot make
		// triggers) or remove. Spike-gated like every /_ path above. It works with the flag off too, so
		// the schema is installed and read back before OBJECT_CACHE_VERSIONS=on is deployed.
		if (url.pathname === '/_ocversions') {
			if (!dbHandler || env.PHP_IN_DO === 'on') return new Response('approach A only', { status: 404 });
			const op = url.searchParams.get('op') || 'status';
			if (!['status', 'install', 'remove'].includes(op)) return new Response('op is status, install or remove', { status: 400 });
			if (op !== 'status' && req.method !== 'POST') return new Response('install and remove need POST', { status: 405 });
			const q = (sql) => dbHandler.query(env, { mysql: sql });
			const out = await withPhp(() => cacheVersions[op](q, tablePrefix(env))); // #1087: under the lock, its own connection
			return Response.json(out, { status: out.ok ? 200 : 500 });
		}
		// The page version counter and its triggers (#296 step 1, page-versions.mjs): approach A only.
		// op=status (default), install (all or nothing; versioned false when the provider cannot make
		// triggers) or remove. Spike-gated like every /_ path above. It works with the flag off too, so
		// the schema can be installed and checked before PAGE_CACHE_VERSIONS=on is deployed.
		if (url.pathname === '/_pcversions') {
			if (!dbHandler || env.PHP_IN_DO === 'on') return new Response('approach A only', { status: 404 });
			const op = url.searchParams.get('op') || 'status';
			if (!['status', 'install', 'remove'].includes(op)) return new Response('op is status, install or remove', { status: 400 });
			if (op !== 'status' && req.method !== 'POST') return new Response('install and remove need POST', { status: 405 });
			const q = (sql) => dbHandler.query(env, { mysql: sql });
			const out = await withPhp(() => pageVersions[op](q, tablePrefix(env))); // #1087: under the lock, its own connection
			return Response.json(out, { status: out.ok ? 200 : 500 });
		}
		// PHP in a Durable Object (PHP_IN_DO=on, issue #28): every request that
		// needs PHP goes to the object, including /_d1ping (D1 as PHP sees it).
		// DB_IN_DO needs the object; without it the Worker would use D1 silently.
		if (env.DB_IN_DO === 'on' && env.PHP_IN_DO !== 'on') return new Response('DB_IN_DO=on needs PHP_IN_DO=on', { status: 500 });
		// Without the binding, fail: a silent fallback would run PHP in the Worker.
		if (env.PHP_IN_DO === 'on') {
			if (!env.PHP_RUNTIME) return new Response('PHP_IN_DO=on needs the PHP_RUNTIME Durable Object binding', { status: 500 });
			// #962: forward a lookup after a short beat so the templates list
			// sent with it reaches the object first.
			const forwardYield = templateLookupForwardYield(req.method, url);
			if (forwardYield) await new Promise((resolve) => setTimeout(resolve, forwardYield));
			return toPhpObject(req, env, url, ctx);
		}
		// Spike: time N sequential D1 statements from where this Worker runs.
		if (url.pathname === '/_d1ping') return d1ping(req, env, url, ctx);
		// Spike: stop the checkout Container, so the next request starts the current image.
		if (env.WOO_CHECKOUT && url.pathname === '/_container-stop') {
			const name = url.searchParams.get('name');
			await (name ? getContainer(env.WOO_CHECKOUT, name) : checkoutContainer(env)).stop();
			return new Response('stopped ' + (name || 'current'));
		}
		// Spike: reach the checkout Container on any path, e.g. /_container/_diag.php
		if (env.WOO_CHECKOUT && url.pathname.startsWith('/_container/')) {
			const inner = new URL(url.pathname.slice('/_container'.length) + url.search, url.origin);
			const r = await checkoutContainer(env).fetch(new Request(new Request(inner, req), { signal: null })); // #721: detached
			const out = new Response(r.body, r);
			out.headers.set('cache-control', 'private, no-store');
			return out;
		}
		if (env.WOO_CHECKOUT && env.CHECKOUT_CONTAINER === 'on' && isCheckout(url)) {
			// #721: a checkout in the container must never inherit the caller's signal: a disconnect would abort it
			// mid-write (signal: null detaches it; measured locally on workerd).
			const r = await checkoutContainer(env).fetch(new Request(req, { signal: null }));
			const out = new Response(r.body, r);
			out.headers.set('x-served-by', 'checkout-container');
			// Checkout is per shopper: never let the edge cache keep it.
			if (!out.headers.has('cache-control')) out.headers.set('cache-control', 'private, no-store');
			return out;
		}
		// #296 (3): a request that would WAIT here (this isolate busy, the queue at the depth) runs on a pool
		// object instead, before it has run. Wherever PHP runs in this Worker with the database outside the
		// object (approach A; also a D1 Worker, which is how it is tested locally), with the binding.
		const ovs = overflowSettings(env);
		let ovCall = null; // #1101: the overflow call id, when this request was offered to the pool first
		// Uploads never move: media uploads, and any request whose declared body is over 1 MiB (the Font Library, #591).
		const ovUpload = isMediaUpload(req, url) || Number(req.headers.get('content-length') || 0) > OVERFLOW_MAX_BODY;
		if (ovs.on && env.PHP_RUNTIME && env.PHP_IN_DO !== 'on' && env.DB_IN_DO !== 'on' && shouldOverflow(ovs, { running: phpLock.running, waiting: phpLock.waiting }, url, ovUpload)) {
			// #714: at the cap, refuse before anything is forwarded: a fast, retry-safe 503 that never ran.
			if (overHeld(ovs, ovHeld)) {
				console.log(JSON.stringify({ m: 'php-lock', iso: ISOLATE_ID, event: 'overflow-capped', held: ovHeld, max: ovs.maxHeld }));
				return overflowCapResponse();
			}
			const picker = ovPickerFor(ovs.pool);
			const callId = crypto.randomUUID(); // #708: one id for this request across its choices
			ovCall = callId; // #1101: kept if the request falls through to run here
			ovHeld++;
			// #714 measurement: with MEM_LEDGER=on, what this isolate holds while it forwards (the ledger is otherwise taken
			// only in handle(), which a forwarded request never calls here).
			if (env.MEM_LEDGER === 'on') console.log(JSON.stringify({ m: 'mem-ledger', ...ledgerSnapshot('overflow-held'), held: ovHeld }));
			try {
			// #296 (3)(c), PHP_OVERFLOW_BUSY=on (default off): a retry-safe request asks the object to answer busy instead
			// of queueing; it then tries the second choice, then runs here. A Turnstile-gated request is verified once at
			// the front, so it is sent once. With busy off, each request goes to one choice and may queue in the object.
			const busyFields = turnstileEnabled(env) ? await readRouteFields(req) : null;
			const busyOk = ovs.busy && !turnstileRoute(env, req.method, url, busyFields);
			const choices = busyOk ? picker.pickTwo() : [picker.pick()];
			for (const i of choices) {
				picker.start(i);
				console.log(JSON.stringify({ m: 'php-lock', iso: ISOLATE_ID, event: 'overflow', obj: overflowName(i), running: phpLock.running, waiting: phpLock.waiting, inflight: picker.inflight(i), call: callId }));
				let r;
				try {
					// A copy per attempt: a busy answer leaves the original request (and its body) unread for the next one.
					r = await toPhpObject(busyOk ? req.clone() : req, env, url, ctx, { name: overflowName(i), hint: ovs.hint, overflow: true, busyOk, callId });
				} finally {
					picker.end(i);
				}
				if (busyOk && r.status === 503 && r.headers.get('x-php-busy') === '1') {
					console.log(JSON.stringify({ m: 'php-lock', iso: ISOLATE_ID, event: 'overflow-busy', obj: overflowName(i) }));
					continue;
				}
				r.headers.set('x-php-overflow', overflowName(i));
				// The object handed a content change's purge back (x-cache-purge: front): this Worker owns the page cache.
				if (r.headers.get('x-cache-purge') === 'front') schedulePurge(ctx);
				return r;
			}
			} finally {
				ovHeld--;
			}
			// Both choices were busy: run here, as without overflow (the request has not run anywhere), unless this
			// isolate still holds other overflowed requests (#714: a booted runtime beside held waiters exceeded memory).
			if (overflowHeldBlocksLocal(ovs, ovHeld)) {
				console.log(JSON.stringify({ m: 'php-lock', iso: ISOLATE_ID, event: 'overflow-held-block', held: ovHeld, call: callId }));
				return overflowHeldBlockResponse();
			}
			console.log(JSON.stringify({ m: 'php-lock', iso: ISOLATE_ID, event: 'overflow-local', running: phpLock.running, waiting: phpLock.waiting, call: callId })); // review2 8 (callId is always set here)
		}
		if (overflowHeldBlocksLocal(ovs, ovHeld) && !url.pathname.startsWith('/_') && !ovUpload) {
			console.log(JSON.stringify({ m: 'php-lock', iso: ISOLATE_ID, event: 'overflow-held-block', held: ovHeld }));
			return overflowHeldBlockResponse();
		}
		// #962: same beat as the object, for a Worker that runs PHP itself.
		const workerLookupYield = templateLookupYield(req.method, url, phpLock);
		if (workerLookupYield) await new Promise((resolve) => setTimeout(resolve, workerLookupYield));
		// #1101: approach A's local run has a call id too, on the lock lines, the error lines and the answer (x-pf-call).
		const callId = ovCall || crypto.randomUUID(); // #1101
		const workerRun = await withPhp(() => withRunCall(callId, () => handle(req, env, url, spikeOk, maxBody, ctx)), { shedMs: phpShedMs(env, false), priority: templateQueuePriority(req.method, url), staleAction: 'shed', tag: { call: callId } }); // #1060
		return tagCallId(workerRun === PHP_SHED ? phpShedResponse() : workerRun, callId);
	},
};

// The cached entrypoint (wrangler.toml: exports.Pages.cache). It gets only what
// pageCacheRoute() lets through, with no Cookie header.
export class Pages extends WorkerEntrypoint {
	async fetch(req) {
		// #296 step 1: the page version is part of the cache key only; WordPress never sees it.
		if (pageVersions.pageVersionsOn(this.env, dbHandler)) req = pageVersions.stripPcv(req);
		const r = await site.fetch(req, this.env, this.ctx);
		// So a test can see which entrypoint answered (the gateway sets nothing).
		const out = new Response(r.body, r);
		out.headers.set('x-entrypoint', 'pages');
		// #628: when PHP rendered this answer. A cached copy keeps it (page-stamp.mjs).
		stampRendered(out.headers);
		// An operator request (it carries the token header) may be answered with the performance
		// headers; never let the edge cache keep that copy for the next visitor. cache-control alone
		// was not enough: the edge obeys cloudflare-cdn-cache-control over it (perf-headers.mjs).
		if (isOperatorRequest(req)) noStoreAnywhere(out.headers);
		return out;
	}
	// An RPC method, so not cached. A purge reaches only the cache of the
	// entrypoint that calls it, so the purge of the page cache runs here.
	async purge(tags) {
		if (!this.ctx.cache) return { ok: false, error: NO_CACHE_API }; // purge-state.mjs drops only this (#699)
		const r = await this.ctx.cache.purge({ tags });
		return { ok: !!(r && r.success !== false), errors: (r && r.errors) || [] };
	}
}

// The gateway (not cached). A request that pageCacheRoute() accepts goes to
// Pages without its Cookie header; every other request runs here.
export default {
	async fetch(req, env, ctx) {
		const url = new URL(req.url);
		// #855: the cron tick is Worker to PhpRuntime only, never a public URL.
		if (url.pathname === CRON_TICK_PATH) return new Response('Not Found', { status: 404 });
		if (url.pathname === MAIL_RETRY_PATH) return new Response('Not Found', { status: 404 }); // #1057: internal only
		// #752: the PHP object's start-by tick lands here, FIRST: a cheap 204, before the page cache and any object call.
		if (url.pathname === TICK_PATH) return tickResponse();
		// #912: //checkout-link is the home page. Merge the slash and redirect.
		// #1005: GET, HEAD and OPTIONS only. A 301 on any other method is followed as GET and the body is lost.
		const merged = collapsedSlashRedirect(req.url, req.method);
		if (merged) return Response.redirect(merged, 301);
		let pcvMissed = false;
		if (pageCacheRoute(req, url, env)) {
			const h = new Headers(req.headers);
			h.delete('cookie');
			h.delete('authorization');
			// #296 step 1: with PAGE_CACHE_VERSIONS=on the version is SET on the URL (the cache key); a
			// failed read gives null, and the request is served below, uncached.
			const pages = pageVersions.pageVersionsOn(env, dbHandler) ? await versionedPagesRequest(req, h, env) : new Request(req, { headers: h });
			if (pages) return ctx.exports.Pages.fetch(pages);
			pcvMissed = true;
		}
		const r = await site.fetch(req, env, ctx);
		if (!pcvMissed) return r;
		// Served without a version: no cache in front (a zone cache on a custom domain) may keep it.
		const out = new Response(r.body, r);
		noStoreAnywhere(out.headers);
		return out;
	},
	async queue(batch, env, ctx) {
		return consumeEmailQueue(batch, env);
	},
	async scheduled(event, env, ctx) {
		return approachACronScheduled(event, env, ctx, siteOrigin);
	},
};

// #296 step 1 (PAGE_CACHE_VERSIONS=on): read the page version on the gateway's OWN connection, then
// send the request to Pages with the version SET on its URL, which is the cache key. A write bumps
// the version in the same statement (page-versions.mjs triggers), so the next request of any
// isolate asks for a new key. A failed or slow read returns null: the gateway serves the request
// uncached, never from an old key. One log line per read (m: pcv), so a run can measure its cost.
const PCV_TIMEOUT_MS = 3000;
async function versionedPagesRequest(req, h, env) {
	const t0 = Date.now();
	const read = await Promise.race([
		pageVersions.readPageVersion((sql) => dbHandler.oneShot(env, sql), tablePrefix(env)).catch((e) => ({ ok: false, error: String(e) })),
		new Promise((res) => setTimeout(() => res({ ok: false, error: 'timeout' }), PCV_TIMEOUT_MS)),
	]);
	const ms = Date.now() - t0;
	console.log(JSON.stringify(read.ok ? { m: 'pcv', ok: true, ms, v: read.v } : { m: 'pcv', ok: false, ms, error: String(read.error).slice(0, 200) }));
	if (!read.ok) return null;
	return new Request(pageVersions.versionedUrl(req.url, read.v), new Request(req, { headers: h }));
}

// #598 / #603: the ONE conversion of a refused boot into the known 503, for every route and both callers (the object
// and the Worker, variant a). A cron leg converts its own into a deferral (alarmRun).
async function handle(req, env, url, spikeOk, maxBody, ctx) {
	return withBootRefusal(() => handleInner(req, env, url, spikeOk, maxBody, ctx));
}
async function handleInner(req, env, url, spikeOk, maxBody, ctx) {
	ocCtx = ctx; // for L2 (KV) object-cache write-through this request (#218)
	if (ocL2W) ocL2W.beginRequest(); // #500: the per-request PUT cap starts again
	{
		// A runtime serves only the origin it booted with (8i). The first request
		// after /_install used to boot the runtime for every later one, and that
		// request could be PHP's own socket connection back to the site: every
		// page then linked to (or answered 301 to) that request's origin. The
		// origin is now the configured site origin (siteOrigin, #33), so it does
		// not change; without SITE_ORIGIN a request for another origin boots a
		// new runtime, in the Worker as in the object.
		const origin = siteOrigin(env, url);
		if (bootPromise && bootOrigin !== origin) {
			runtimeDrops++;
			dropRuntimeIdle();
		}
		// #798: /_install and /_activate RUN ON THE CURRENT RUNTIME. They used to drop it first and boot a fresh one (#185:
		// "a reused runtime returns runCron's output in place of the activation"). That symptom was internal/eval.php kept
		// in OPcache (every php.run wrote that one path), fixed by its blacklist (#294). With PHP_MEMORY_REUSE off, the
		// live default, the dropped runtime's memory stayed resident beside the fresh one: 3 live memories (173 MiB
		// retired) after install, a page, /_runcron and /_activate (tests/deploy-flow-e2e.sh). That test also checks that
		// /_activate after /_runcron answers its own result.
		if (url.pathname === '/_last') return Response.json(globalThis.__lastRequest || {});
		if (url.pathname === '/_peak') {
			bootPromise ??= boot(origin);
			const { php } = await bootPromise;
			const r = await php.run({ code: `<?php
				$a = memory_get_peak_usage(false); $b = memory_get_peak_usage(true);
				register_shutdown_function(function () use ($a, $b) { while (ob_get_level()) ob_end_clean(); echo 'PEAK' . json_encode(array('before' => array($a, $b), 'peak' => memory_get_peak_usage(false), 'peak_real' => memory_get_peak_usage(true), 'limit' => ini_get('memory_limit'), 'files' => count(get_included_files()))); });
				define('WP_USE_THEMES', true);
				ob_start(); require '/wordpress/wp-blog-header.php';` });
			return new Response(r.text.slice(r.text.indexOf('PEAK')));
		}
		if (url.pathname === '/_runcron') {
			// Run due background work off the request path (issue #185, Phase 2). WP-Cron is
			// disabled (DISABLE_WP_CRON), so nothing runs it otherwise; the DO alarm calls the
			// same runCron() on a cadence. Runs the Action Scheduler queue (the deferred WC
			// order emails) and due WP-Cron events. Spike/manual trigger and the test seam.
			// #720: already inside the request withPhp (object fetch and the Worker serve both call
			// handle inside it). Pass held so runCron does not take the lock again. The alarm calls
			// runCron without it, so that leg always takes the lock. #603 (B): the runtime is resolved in
			// runCron, under that lock.
			const mail = tickMailFor(env, sqlStorage);
			const r = await runCron(() => (bootPromise ??= boot(origin)), false, mail, { held: true });
			// Drain + SEND here too (a manual run), awaiting delivery so the response reports actual
			// sends, not enqueues (#185). The alarm uses waitUntil; a manual trigger awaits the signal.
			const drained = pendingEmails.length;
			const sp = sendPending(env);
			// Bound the drain the same way the alarm does (#198): a manual /_runcron must
			// not hang on a send env.EMAIL.send will not promptly answer. sendBounded flags
			// a send still in flight at the bound; the next alarm tick (and #190's Queue)
			// re-drives it.
			let sent = 0;
			let sendBounded = false;
			if (sp) {
				const res = await boundedWait(sp, SEND_TIMEOUT_MS);
				if (res === TIMED_OUT) sendBounded = true;
				else sent = res;
			}
			return new Response(JSON.stringify({ ...r, drained, sent, mail: mail.counts, lostWrites: mail.lostWritesSeen(), ...(sendBounded ? { sendBounded: true } : {}) }), { headers: { 'content-type': 'application/json' } });
		}
		if (url.pathname === '/_activate') {
			// Activate a plugin, e.g. ?plugin=woocommerce/woocommerce.php. Spike only.
			bootPromise ??= boot(origin);
			const { php } = await bootPromise;
			const plugin = url.searchParams.get('plugin') || '';
			// Underscores are allowed (#279: All in One SEO is all-in-one-seo-pack/all_in_one_seo_pack.php).
			// No dot, quote or second slash: the value is interpolated into the PHP below.
			if (!/^[a-z0-9_-]+\/[a-z0-9_-]+\.php$/.test(plugin)) return new Response('bad plugin', { status: 400 });
			const start = stats.calls;
			const failSeq0 = failureSeq; // #744: this run's database failures are the ones numbered after this
			let r;
			try {
				r = await php.run({ code: `<?php
					define( 'WP_ADMIN', true );
					// A deploy-time activation never runs the store's queued work (#289). In an admin load,
					// Action Scheduler starts its async queue runner, and on a store with pending actions
					// that ran one inside this request; its failure (an uncaught InvalidArgumentException
					// from mark_failure) ended the request before the activation was saved. The filter is
					// pre-seeded in $wp_filter (WP_Hook::build_preinitialized_hooks), because Action
					// Scheduler reads it while wp-load runs, before any add_filter here could. The cron
					// alarm stays the one runner of that queue.
					$GLOBALS['wp_filter']['action_scheduler_allow_async_request_runner'][999]['skyphusion_activate_no_queue'] = array( 'function' => '__return_false', 'accepted_args' => 1 );
					require '/wordpress/wp-load.php';
					remove_all_actions( 'action_scheduler_run_queue' );
					require_once ABSPATH . 'wp-admin/includes/plugin.php';
					wp_set_current_user( 1 );
					// Deploy-time activation race (#35): seed WooCommerce's own attribute-taxonomies transient so
					// its admin init (wc_get_attribute_taxonomies) does not read wp_woocommerce_attribute_taxonomies
					// before the activation creates it. A cold just-deployed isolate hits this read-before-create
					// window and logs "no such table"; a warm activate does not, because the table already exists.
					// wc_get_attribute_taxonomies() checks this transient before the DB, and there are no attributes
					// at activation, so an empty seed is correct; WC_Install then creates the table and normal cache
					// invalidation takes over.
					if ( '${plugin}' === 'woocommerce/woocommerce.php' ) { set_transient( 'wc_attribute_taxonomies', array() ); }
					// The result is printed from a shutdown function, so it is printed also when a plugin
					// ends the request itself (#289): Slim SEO's activated_plugin hook redirects to its
					// settings page and calls die AFTER the activation is saved, and /_activate answered an
					// empty out for an activation that had worked (sample store, 2026-11-12). exited is true
					// when the run did not reach the end of this script.
					$GLOBALS['skyphusion_act'] = array( 'r' => null, 'done' => false, 'lock_cleared' => 0 );
					// #661: did WooCommerce really INSTALL? Activation alone is not proof. WC_Install::install() takes the
					// wc_installing lock first and, while a lock under 10 minutes old exists, returns WITHOUT installing; and
					// WordPress saves the plugin as active AFTER the activation hook. So a first attempt that died mid-install
					// (#198's cold-isolate reset) left the lock, the retry skipped the install, and deploy.sh passed on
					// "active": every request then failed the lock INSERT, and with create_roles never run, every WooCommerce
					// REST write answered 403 (#661, #791's control, 2026-11-17). Read from the table, not the cache.
					function skyphusion_wc_installed() {
						global $wpdb;
						$ver = $wpdb->get_var( "SELECT option_value FROM {$wpdb->options} WHERE option_name = 'woocommerce_version'" );
						$lock = (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$wpdb->options} WHERE option_name = 'wc_installing'" );
						$roles = maybe_unserialize( $wpdb->get_var( $wpdb->prepare( "SELECT option_value FROM {$wpdb->options} WHERE option_name = %s", $wpdb->prefix . 'user_roles' ) ) );
						$caps = ( is_array( $roles ) && isset( $roles['administrator']['capabilities'] ) ) ? $roles['administrator']['capabilities'] : array();
						$code = defined( 'WC_VERSION' ) ? WC_VERSION : null;
						$ok = null !== $code && $ver === $code && 0 === $lock && ! empty( $caps['edit_products'] ) && ! empty( $caps['manage_woocommerce'] );
						return array( 'ok' => $ok, 'detail' => array( 'version' => $ver, 'code' => $code, 'lock' => $lock, 'edit_products' => ! empty( $caps['edit_products'] ), 'manage_woocommerce' => ! empty( $caps['manage_woocommerce'] ), 'lock_cleared' => $GLOBALS['skyphusion_act']['lock_cleared'] ) );
					}
					register_shutdown_function( function () {
						global $wpdb;
						$a = $GLOBALS['skyphusion_act']; $r = $a['r'];
						echo json_encode( array( 'active' => is_plugin_active( '${plugin}' ), 'error' => is_wp_error( $r ) ? $r->get_error_message() : null, 'exited' => ! $a['done'], 'db_error' => $wpdb->last_error ? $wpdb->last_error : null, 'queue_runs' => did_action( 'action_scheduler_run_queue' ), 'installed' => '${plugin}' === 'woocommerce/woocommerce.php' ? ( $w = skyphusion_wc_installed() ) && $w['ok'] : null, 'install' => '${plugin}' === 'woocommerce/woocommerce.php' ? $w['detail'] : null ) );
					} );
					// #661: a retry clears the lock its own dead attempt left. Safe because WooCommerce is NOT active yet: no
					// request loads WooCommerce, so none runs check_version or holds this lock; only an earlier /_activate can
					// have written it. With WooCommerce already active the lock is left alone (a live takeover may own it).
					if ( '${plugin}' === 'woocommerce/woocommerce.php' && ! is_plugin_active( '${plugin}' ) ) {
						$GLOBALS['skyphusion_act']['lock_cleared'] = (int) $wpdb->query( "DELETE FROM {$wpdb->options} WHERE option_name = 'wc_installing'" );
						delete_transient( 'wc_installing' );
					}
					$r = activate_plugin( '${plugin}' );
					$GLOBALS['skyphusion_act']['r'] = $r;
					// WooCommerce sends the first admin visit to its setup wizard (a 302 on /wp-admin/). A deploy has no use for it.
					delete_transient( '_wc_activation_redirect' );
					// WooCommerce makes its order tables (HPOS) on the first admin page view. dbDelta
					// first runs DESCRIBE on each missing table, which is an error by design. Make them
					// here, so that one-time step is part of the activation and not of a visitor's page.
					if ( function_exists( 'wc_get_container' ) && class_exists( 'Automattic\\\\WooCommerce\\\\Internal\\\\DataStores\\\\Orders\\\\DataSynchronizer' ) ) {
						$sync = wc_get_container()->get( 'Automattic\\\\WooCommerce\\\\Internal\\\\DataStores\\\\Orders\\\\DataSynchronizer' );
						if ( ! $sync->check_orders_table_exists() ) $sync->create_database_tables();
					}
					// db_error (the last database error of this run) and queue_runs (did Action Scheduler run
					// its queue in this request) are printed by the shutdown function above (#289).
					$GLOBALS['skyphusion_act']['done'] = true;` });
			} catch (e) {
				dropRuntime();
				return new Response('activate failed: ' + String((e && e.message) || e), { status: 500 });
			}
			// #798: the runtime is KEPT after an activation. WordPress reads the active plugins from the database on every
			// request, so the next request loads the new plugin on this runtime; a drop here made that request boot beside
			// this runtime's uncollected memory. A FAILED activation (the catch above) still drops: its runtime is not trusted.
			// #744: dbFailures names each failed statement of this run (its error and SQL, bounded), which the 2,000-character
			// errors cut hid: WooCommerce's cart-page probe failed mid-query and showed only the query head.
			return new Response(JSON.stringify({ out: r.text.slice(-2000), errors: String(r.errors).slice(0, 2000), d1: stats.calls - start, dbFailures: failuresSince(stats.failures, failSeq0) }), { headers: { 'content-type': 'application/json' } });
		}
		if (url.pathname === '/_opcache-dump') {
			// Zip of the OPcache file cache, for opcache.sh. Run it after the e2e
			// requests, so it holds the scripts real pages use.
			// x-isolate and x-runtime-drops: opcache.sh needs the isolate it started with
			// and 0 drops, so one runtime compiled everything the pages used.
			const dumpHeaders = { 'x-isolate': ISOLATE_ID, 'x-runtime-drops': String(runtimeDrops), 'x-runtimes': String(runtimeSerial) };
			if (!bootPromise) return new Response('not booted', { status: 409, headers: dumpHeaders });
			const { php } = await bootPromise;
			const files = {};
			const walk = (dir) => {
				for (const name of php.listFiles(dir)) {
					const p = dir + '/' + name;
					if (php.isDir(p)) walk(p);
					else if (!p.endsWith('/wordpress/wp-runtime.php.bin')) files[p.slice(OPCACHE_DIR.length + 1)] = php.readFileAsBuffer(p);
				}
			};
			walk(OPCACHE_DIR);
			const { zipSync } = await import('fflate');
			// Deflated: with WooCommerce, a stored zip passes the 64 MiB Worker size
			// limit. The Worker inflates each file on its first read only.
			return new Response(zipSync(files, { level: 6 }), { headers: { 'content-type': 'application/zip', 'x-files': String(Object.keys(files).length), ...dumpHeaders } });
		}
		if (url.pathname === '/_trace') {
			// The file reads recorded since the last call (FILE_TRACE=on, #394 M0), then cleared.
			return Response.json({ on: tracing(), ...fileTrace.drain() });
		}
		if (url.pathname === '/_mem') {
			if (!bootPromise) return Response.json({ booted: false });
			const { php, bootMs } = await bootPromise;
			const r = await php.run({ code: '<?php echo json_encode(array("opcache" => ini_get("opcache.enable"), "mc" => ini_get("opcache.memory_consumption"), "fco" => ini_get("opcache.file_cache_only"), "cached" => function_exists("opcache_get_status") && ($st = opcache_get_status(false)) ? $st["opcache_statistics"]["num_cached_scripts"] : null, "mem" => isset($st["memory_usage"]) ? $st["memory_usage"] : null, "pf" => function_exists("pagefeather_opcache_stats") ? pagefeather_opcache_stats() : null, "lb" => (isset($st) && is_array($st) && isset($st["pagefeather_lazy_bodies"])) ? $st["pagefeather_lazy_bodies"] : null));' });
			return Response.json({ bootMs, wasmMemoryBytes: php[__private__dont__use].HEAPU8.length, fileBytes: bootMs.fileBytes, fileCount: bootMs.fileCount, memAt: bootMs.memAt, ini: JSON.parse(r.text || '{}') });
		}
		if (url.pathname === '/_memprobe') {
			// Decompose the Woo-warmed admin-upload working set (issue #189), so the biggest
			// FREEABLE chunk is visible. Bootstraps WordPress in the admin-upload context
			// (WooCommerce active, the wp-admin media includes) and reports memory at each
			// phase, the OPcache breakdown, and WooCommerce's share of loaded files, classes
			// and functions; the Worker adds the WASM heap size and the cross-request object
			// cache. Spike-token gated (every /_ path is). A measurement run: it loads
			// WooCommerce into the runtime, so run it on an isolate you are done measuring.
			bootPromise ??= boot(origin);
			const { php } = await bootPromise;
			const r = await php.run({ code: `<?php
				$P = array('limit' => ini_get('memory_limit'), 'use_zend_alloc' => (memory_get_usage(true) > 0 ? '1' : '0')); // #547: not getenv, which php-wasm sets to "0" itself
				$heap = function () {
					if (!function_exists('post_message_to_js')) { return null; }
					$r = json_decode(post_message_to_js(json_encode(array('probeMem' => 1))), true);
					return (is_array($r) && isset($r['wasm'])) ? $r['wasm'] : null;
				};
				register_shutdown_function(function () use (&$P, $heap) {
					while (ob_get_level()) { ob_end_clean(); }
					$P['wasm_end'] = $heap();
					// memory_get_usage reports 0 under USE_ZEND_ALLOC=0 (the Zend allocator is
					// bypassed), so the wasm_* heap samples above are the memory of record.
					$P['php_mem_end'] = memory_get_usage(true);
					$P['php_mem_peak'] = memory_get_peak_usage(true);
					if (function_exists('opcache_get_status')) {
						$st = @opcache_get_status(false);
						if (is_array($st)) {
							$P['opcache'] = array(
								'used' => isset($st['memory_usage']['used_memory']) ? $st['memory_usage']['used_memory'] : null,
								'free' => isset($st['memory_usage']['free_memory']) ? $st['memory_usage']['free_memory'] : null,
								'wasted' => isset($st['memory_usage']['wasted_memory']) ? $st['memory_usage']['wasted_memory'] : null,
								'scripts' => isset($st['opcache_statistics']['num_cached_scripts']) ? $st['opcache_statistics']['num_cached_scripts'] : null,
								'interned_used' => isset($st['interned_strings_usage']['used_memory']) ? $st['interned_strings_usage']['used_memory'] : null,
							);
						}
					}
					$inc = get_included_files();
					$tot = 0; $wc_files = 0; $wc_bytes = 0;
					foreach ($inc as $f) {
						$sz = @filesize($f);
						if ($sz !== false) { $tot += $sz; }
						if (strpos($f, '/plugins/woocommerce/') !== false) { $wc_files++; if ($sz !== false) { $wc_bytes += $sz; } }
					}
					$wc_classes = 0;
					foreach (get_declared_classes() as $c) { if (stripos($c, 'woocommerce') !== false) { $wc_classes++; } }
					$fns = get_defined_functions();
					$user_fns = isset($fns['user']) ? $fns['user'] : array();
					$wc_fns = 0;
					foreach ($user_fns as $fn) { if (stripos($fn, 'woocommerce') !== false || strpos($fn, 'wc_') === 0) { $wc_fns++; } }
					$P['included'] = array('count' => count($inc), 'bytes' => $tot);
					$P['woocommerce'] = array('files' => $wc_files, 'file_bytes' => $wc_bytes, 'classes' => $wc_classes, 'functions' => $wc_fns);
					$P['classes_total'] = count(get_declared_classes());
					$P['user_functions'] = count($user_fns);
					echo 'PROBE' . json_encode($P);
				});
				$P['wasm_start'] = $heap();
				if (!defined('WP_ADMIN')) { define('WP_ADMIN', true); }
				$_SERVER['REQUEST_URI'] = '/wp-admin/';
				require '/wordpress/wp-load.php';
				$P['wasm_after_wp_load'] = $heap();
				if (function_exists('wp_set_current_user')) { wp_set_current_user(1); }
				require_once ABSPATH . 'wp-admin/includes/image.php';
				require_once ABSPATH . 'wp-admin/includes/media.php';
				require_once ABSPATH . 'wp-admin/includes/admin.php';
				$P['wasm_after_media_includes'] = $heap();` });
			let phpSide;
			const marker = r.text.indexOf('PROBE');
			try { phpSide = JSON.parse(r.text.slice(marker + 5)); } catch { phpSide = { parse_error: true, raw: r.text.slice(Math.max(0, marker), marker + 500) }; }
			return Response.json({
				wasmMemoryBytes: php[__private__dont__use].HEAPU8.length,
				recycleThresholdBytes: recycleLine(env, ENGINE_RECYCLE_MIB).bytes,
				objectCache: { entries: objectCache.size, bytes: objectCacheBytes, capBytes: OBJECT_CACHE_BYTES },
				php: phpSide,
			});
		}
		try {
			if (!isolateStart) isolateStart = Date.now(); // #474: the isolate's first request
			ledgerActive = ledgerOn(env, req.headers.get('x-mem-ledger'), perfHeadersAllowed(req, env));
			qtrace = Boolean(env.SPIKE_TOKEN) && req.headers.get('x-spike-token') === env.SPIKE_TOKEN && req.headers.get('x-pf-qtrace') === '1' ? createQueryTrace() : null;
			ledgerId = ledgerActive ? memIdOf(req, env).id || null : null;
			ledgerFailLogged = false;
			sqlMeter.reset();
			ledgerInfl0 = { n: stats.inflates, b: stats.inflateBytes, r: stats.reinflates, ae: inflateArena ? inflateArena.counts.evicts : 0 };
			if (ledgerActive) ledgerLog('start');
			const tBoot = Date.now();
			const booted = !bootPromise;
			if (tracing()) fileTrace.begin({ cls: routeClass(req.method, url.pathname, url.search), method: req.method, path: url.pathname, boot: booted ? 1 : 0 });
			const remote0 = remoteCounters();
			const frame0 = undoLog ? undoLog.counts() : null; // #352: the frame counts, before this request
			bootPromise ??= boot(origin);
			const { php, handler, bootMs } = await bootPromise;
			const bootWaitMs = Date.now() - tBoot;
			const wasm0 = php[__private__dont__use].HEAPU8.length;
			ocReqBegin(); // #766
			// #1039, approach A: a media upload marks the files it creates; the throttled sweep runs first, so an orphan's
			// name is free again before this upload picks one.
			uploadRun = dbHandler && isMediaUploadRequest(req.method, url.pathname, url.search) ? [] : null;
			if (uploadRun) await uploadSweepThrottled(env);
			const start = { dbTables: { ...stats.dbTables }, ocGroups: { ...stats.ocGroups }, calls: stats.calls, ms: stats.ms, fail: stats.failures.length, log: stats.log.length, rowsRead: stats.rowsRead, rowsWritten: stats.rowsWritten, inflates: stats.inflates, inflateBytes: stats.inflateBytes, reinflates: stats.reinflates, lazyWrites: stats.lazyWrites, rfN: stats.rfN, rfBytes: stats.rfBytes, rfMs: stats.rfMs, rfFail: stats.rfFail, rfCapped: stats.rfCapped, rsN: stats.rsN, rsBytes: stats.rsBytes, rsMs: stats.rsMs, rsFail: stats.rsFail, rsCapped: stats.rsCapped, rsRetry: stats.rsRetry, ocCalls: stats.ocCalls, ocHits: stats.ocHits, l2N: stats.l2N, l2Ms: stats.l2Ms, l2Hits: stats.l2Hits, httpCalls: stats.httpCalls, httpMs: stats.httpMs, txnOps: stats.txnOps, undoRows: stats.undoRows };
			const delta = () => ({ calls: stats.calls - start.calls, ms: stats.ms - start.ms, failures: stats.failures.slice(start.fail), log: stats.log.slice(start.log) });
			const t0 = Date.now();
			// #352 the forced-reset proof (a MEASUREMENT that KILLS the isolate; spike token and HEADROOM_PROBE=on,
			// the /_headroom kill probe's gate). plain: option A, then grow the PHP heap until the isolate resets,
			// then option B: with REQUEST_FRAMES=on both must be gone after recovery. point: the same with a DDL
			// (a commit point) after A: A must be KEPT. check: read A and B back (a later request, after recovery).
			if (url.pathname === '/_frame-probe' && spikeOk && env.HEADROOM_PROBE === 'on') {
				const mode = url.searchParams.get('mode') || 'plain';
				const tag = String(url.searchParams.get('tag') || 'p').replace(/[^a-z0-9]/gi, '').slice(0, 16) || 'p';
				if (mode === 'check') {
					const r = await php.run({ code: `<?php require '/wordpress/wp-load.php'; echo json_encode(array('a' => get_option('pf352_${tag}_a', null), 'b' => get_option('pf352_${tag}_b', null)));` });
					return new Response(r.text, { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
				}
				const point = mode === 'point' ? "$wpdb->query('CREATE TABLE IF NOT EXISTS pf352_probe_ddl (a INTEGER)');" : '';
				const r = await php.run({ code: `<?php require '/wordpress/wp-load.php'; global $wpdb; update_option('pf352_${tag}_a', 'A', false); ${point} $keep = array(); for ($i = 0; $i < 64; $i++) { $keep[] = str_repeat('x', 8 << 20); } update_option('pf352_${tag}_b', 'B', false); echo 'survived';` });
				return new Response(String(r.text).slice(0, 200), { headers: { 'cache-control': 'no-store' } });
			}
			if (url.pathname === '/_install') {
				php.writeFile('/tmp/admin-password', req.headers.get('x-admin-password') || (env.SPIKE_TOKEN ? '' : 'local-spike-password'));
				php.writeFile('/tmp/admin-email', req.headers.get('x-admin-email') || env.ADMIN_EMAIL || 'admin@example.com');
				php.writeFile('/tmp/site-timezone', req.headers.get('x-site-timezone') || env.SITE_TIMEZONE || 'America/Detroit');
				let out, errors;
				try {
					const r = await php.run({ code: INSTALL });
					out = r.text;
					errors = r.errors;
				} catch (e) {
					out = String((e && e.message) || e);
					errors = 'PHP exited non-zero';
				}
				// #756: the runtime is KEPT, so the first page reuses it. Dropping it here (a claim from the first D1
				// spike, never measured) made the first page boot a second runtime beside this one's WebAssembly
				// memory, which V8 had not yet collected, and the isolate died of exceededMemory: 6 of 6
				// install-then-page deploys; with it kept, 0 of 3 (#756, lean, wfp). #185's reuse hazard (a reused
				// runtime ran the previous php.run's code) was
				// internal/eval.php in OPcache, fixed by its blacklist (#294). A runtime over the recycle line
				// is still recycled by the next request's run, as any other one is.
				objectCacheClear(); // the database changed outside WordPress's cache
				const tail = out.length > 6000 ? out.slice(-6000) : out;
				return Response.json({ bootMs, ms: Date.now() - t0, out: tail, errors: String(errors).slice(0, 4000), d1: delta() });
			}
			const headers = {};
			req.headers.forEach((v, k) => (headers[k] = v));
			// The AST-cache per-request bypass (issue #173) is honored only with a
			// valid spike token, so a visitor cannot disable the cache in production.
			if (!spikeOk) delete headers['x-ast-cache-off'];
			if (!spikeOk) delete headers['x-oc-off'];
			// The memory trace and its switches (#434) reach PHP only with a valid spike token.
			if (!spikeOk) { delete headers['x-mem-trace']; delete headers['x-mem-off']; }
			if (!spikeOk) delete headers['x-pf-wc-defer']; // #768: the deferral's operator A/B switch (php/wc-route-defer.php)
			let body;
			if (env.MEDIA && isMediaUpload(req, url) && Number(req.headers.get('content-length') || 0) > STAGE_MIN_BYTES) {
				const staged = await stageUpload(req, env);
				body = staged.body;
				headers['content-type'] = staged.contentType;
				headers['content-length'] = String(body.length);
			} else {
				body = ['GET', 'HEAD'].includes(req.method) ? undefined : new Uint8Array(await req.arrayBuffer());
			}
			if (body && body.length > maxBody) return new Response('request body too large', { status: 413 });
			purgeRequested = false;
			pendingEmails = [];
			emailDueRequest = false;
			const r2before = JSON.stringify(stats.r2);
			const r2start = JSON.parse(r2before);
			// OPcache counters before and after, only when a spike-token holder asks (two extra php.run calls).
			const wantOpcache = spikeOk && req.headers.get('x-perf-opcache') === '1'; // #1078: on approach A too
			const op0 = wantOpcache ? await opcacheStats(php) : null;
			const tPhp = Date.now();
			lastMemTrace = null;
			const r = await handler.request({ url: url.pathname + url.search, method: req.method, headers, body });
			// #716: NOT CPU. Date.now() moves only at I/O on Cloudflare, so this is PHP's wall time at I/O points; a CPU-bound
			// render reads near 0. Cite the invocation's $workers.cpuTimeMs for CPU (docs/perf-dosql.md, "Citing CPU").
			const phpOnlyMs = Date.now() - tPhp;
			const op1 = wantOpcache ? await opcacheStats(php) : null;
			// Approach A: close this request's MySQL connection after the response.
			if (dbHandler) (ctx ? ctx.waitUntil(dbHandler.end()) : dbHandler.end());
			if (ctx && ctx.exports && purgeRequested) schedulePurge(ctx);
			const out = new Headers();
			// In the PHP object, the object itself coalesces the purges of the whole site (issue #78).
			// x-cache-purge (scheduled or coalesced) is for tests.
			// #935: PHP has already answered. The page-cache purge is a storage call after that.
			// A platform reset there threw into the bare internal error catch. A finished
			// force-delete then came back as text, and a REST client could not parse it.
			// The lost-write return below still replaces this answer. A purge miss does not.
			// #1007: a failed purge is never swallowed. purge-after-php.mjs logs it and hands back one retry, which is
			// called below once the runtime is dropped (a reset) or once the answer is built (any other failure).
			let purgeReset = null;
			let purgeRetry = null;
			if (ctx && ctx.requestPurge && purgeRequested) {
				const pa = await askPurgeAfterAnswer(ctx, url.pathname);
				if (pa.header != null) out.set('x-cache-purge', pa.header);
				purgeReset = pa.resetKind;
				purgeRetry = pa.retry;
			}
			const d = delta();
			// A write lost to an isolate memory reset (#350, write-loss.mjs): PHP's answer is replaced,
			// whatever its status, before any of its headers (a Set-Cookie for a session that was not
			// stored) is copied. The statements before the reset may be saved, so no "try again".
			const lost = resetFailures(d.failures);
			// Async email (issue #185): hand the collected messages to the send_email binding off the
			// request path, so checkout never waits on delivery. No binding, no MAIL_FROM, or no ctx:
			// sendPending drops them and says so. Decided only AFTER the lost writes are counted (#368,
			// HOLD): a request with a loss sends no mail, and each held mail is an email-held event.
			if (pendingEmails.length) {
				const plan = heldRequestMail(pendingEmails, lost, { method: req.method, path: url.pathname });
				for (const e of plan.events) console.log(JSON.stringify(e));
				if (plan.events.length) pendingEmails = [];
				else if (ctx && ctx.waitUntil) {
					const sp = sendPending(env);
					if (sp) ctx.waitUntil(sp);
				}
			}
			if (lost) {
				if (ledgerActive) ledgerLog('write-loss', { lost });
				const ocForgot = ocReqForget(); // #766: what this request cached after its failed statements is not kept
				// #794: and what it WROTE is not kept either. A value it derived from a failed read (an add_option of a
				// default over a real value whose read failed) would outlive every cache and deploy. The storage failure
				// is the platform's, so the frame is rolled back now, as the next isolate's recover() would (undo-log.mjs).
				let rb = null;
				try { rb = undoLog && sqlDb ? undoLog.rollbackFrame(sqlDb, sqlStorage) : null; } catch (e) { console.log(JSON.stringify({ m: 'frame-rollback-failed', error: String((e && e.message) || e).slice(0, 160) })); }
				try { if (undoLog) await undoLog.finishCacheDrops(); } catch (e) { console.log(JSON.stringify({ m: 'options-cache-drop-failed', error: String((e && e.message) || e).slice(0, 160) })); }
				if (rb) console.log(JSON.stringify({ m: 'frame-rolled-back', at: 'reset-failure', req: rb.req, undone: rb.undone, points: rb.points, path: url.pathname, ...memIdOf(req, env) }));
				const json = wantsJson(url.pathname, url.search, req.headers.get('accept'));
				// "Nothing was saved" only on the proof, the frame's own row as /_frame reads it (#352).
				const fr = rb && undoLog ? undoLog.status(sqlDb, rb.req) : null;
				// #1039: and the files it created are gone too, or "nothing was saved" is not claimed.
				const filesGone = rb ? await deleteFrameR2(rb.req, rb.r2) : true;
				const rolled = filesGone && frameProvesRollback(fr) ? rolledBackResponse(json, 'memory', fr.undone) : null;
				const wl = writeLossResponse(lost, json);
				const answer = rolled || wl;
				// phpStatus is PHP's status before this replacement. answered is the status returned below (#596).
				console.log(JSON.stringify({ '@event': 'write-loss', m: 'write-loss', method: req.method, path: url.pathname, failed: lost, rolledBack: !!rolled, ocDropped: ocForgot.n, ocDroppedGroups: ocForgot.groups, phpStatus: r.httpStatusCode, firstSql: sqlShape(d.failures[0].sql), ...memIdOf(req, env), ...callTag(ctx), answered: wl.status }));
				dropRuntime(); // the runtime saw the reset; the next request boots a new one
				if (purgeRetry) purgeRetry(); // #1007: the statements before the reset may be saved, so their pages too
				return new Response(answer.body, { status: answer.status, headers: answer.headers });
			}
			// #969: the order request queued a deferred email. Wake the alarm soon. A lost write
			// rolled the queue row back, so that path returns above and does not arm this.
			if (emailDueRequest && ctx && ctx.storage) {
				emailDueRequest = false;
				try {
					const nowDue = Date.now();
					await ctx.storage.put(EMAIL_DUE_KEY, nowDue);
					const dueAt = emailAlarmAt(await ctx.storage.getAlarm(), nowDue);
					if (dueAt !== null) await setAlarmRecorded(ctx.storage, dueAt, nowDue, 'email-due');
				} catch (e) {
					console.log(JSON.stringify({ m: 'email-due', error: String((e && e.message) || e).slice(0, 160) }));
				}
			}
			// #795, by FAILURE CLASS (write-loss.mjs PLATFORM_FAILURE). A PLATFORM failure other than the reset (busy, out of
			// memory, disk full, a timeout...) is never answered as a success: PHP saw an empty or unapplied result that was
			// not the truth. What the request cached is not kept (#766); a failed READ rolls the frame back (#794's
			// boundary); the answer is the visible failure, retryable when nothing was saved. A DETERMINISTIC error (the
			// statement itself is wrong: no such table, syntax, the LIKE cap) goes back to WordPress through wpdb's error
			// path, as MySQL's does: no 5xx (a retry would fail forever), its cache writes from a failed read dropped, and
			// the answer never edge-cached (pageCacheHeaders below). Every failed statement is logged, its shape only.
			if (d.failures.length) {
				const platform = platformFailures(d.failures) > 0;
				const shapes = [...new Set(d.failures.map((x) => sqlShape(x.sql)))].slice(0, 8);
				const errShape = String(d.failures[0].error || '').replace(/'[^']*'|"[^"]*"|[0-9]+/g, '?').slice(0, 100);
				if (platform) {
					const f = ocReqForget();
					const wrote = d.log.some((l) => /^ok\s+\(?\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(l));
					let rb = null;
					if (readFailed(d.failures)) {
						try { rb = undoLog && sqlDb ? undoLog.rollbackFrame(sqlDb, sqlStorage) : null; } catch (e) { console.log(JSON.stringify({ m: 'frame-rollback-failed', error: String((e && e.message) || e).slice(0, 160) })); }
						try { if (undoLog) await undoLog.finishCacheDrops(); } catch (e) { console.log(JSON.stringify({ m: 'options-cache-drop-failed', error: String((e && e.message) || e).slice(0, 160) })); }
					}
					const fr = rb && undoLog ? undoLog.status(sqlDb, rb.req) : null;
					const filesGone = rb ? await deleteFrameR2(rb.req, rb.r2) : true; // #1039
					const saved = rb ? !(filesGone && frameProvesRollback(fr)) : wrote;
					const sf = statementFailureResponse(d.failures.length, wantsJson(url.pathname, url.search, req.headers.get('accept')), saved);
					console.log(JSON.stringify({ '@event': 'statement-failure', m: 'statement-failure', class: 'platform', method: req.method, path: url.pathname, failed: d.failures.length, shapes, error: errShape, wrote, rolledBack: !!(rb && !saved), answered: sf.status, phpStatus: r.httpStatusCode, ocDropped: f.n, ...memIdOf(req, env), ...callTag(ctx) }));
					if (purgeRetry && saved) purgeRetry(); // #1007: a saved write changed pages, so their purge is asked again
					return new Response(sf.body, { status: sf.status, headers: sf.headers });
				}
				// #836 (the lead's ruling, option 2): a deterministic REFUSAL on a read (a platform SQLite limit MySQL does not
				// have) answers a non-retryable 500 naming it, never PHP's plausible empty answer. Other deterministic errors
				// (MySQL raises them too) keep wpdb's path below.
				const refusal = readRefusal(d.failures);
				if (refusal) {
					const f = ocReqForget();
					const wrote = d.log.some((l) => /^ok\s+\(?\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(l));
					const sr = refusedReadResponse(refusal, wantsJson(url.pathname, url.search, req.headers.get('accept')), wrote);
					console.log(JSON.stringify({ '@event': 'sql-refused', m: 'sql-refused', refused: refusal, method: req.method, path: url.pathname, failed: d.failures.length, shapes, error: errShape, wrote, answered: sr.status, phpStatus: r.httpStatusCode, ocDropped: f.n, ...memIdOf(req, env) }));
					return new Response(sr.body, { status: sr.status, headers: sr.headers });
				}
				const f = readFailed(d.failures) ? ocReqForget() : { n: 0 };
				console.log(JSON.stringify({ '@event': 'statement-failure', m: 'statement-failure', class: 'deterministic', method: req.method, path: url.pathname, failed: d.failures.length, shapes, error: errShape, answered: r.httpStatusCode, ocDropped: f.n, ...memIdOf(req, env), ...callTag(ctx) }));
			}
			if (purgeReset) {
				if (bootPromise) runtimeDrops++;
				dropRuntime();
				if (purgeRetry) purgeRetry();
				for (const [k, v] of Object.entries(r.headers || {})) {
					for (const one of [].concat(v)) {
						try { out.append(String(k), String(one)); } catch { /* a header value the Headers API refuses stays off the answer */ }
					}
				}
				out.set('cloudflare-cdn-cache-control', 'no-store');
				if (!out.has('cache-control')) out.set('cache-control', 'private, no-store');
				return new Response(r.bytes, { status: r.httpStatusCode, headers: out });
			}
			// #1007: a purge that failed without a reset is asked once more, off the response path.
			if (purgeRetry) purgeRetry();
			for (const [k, v] of Object.entries(r.headers)) for (const one of [].concat(v)) out.append(k, one);
			const ocTables = diffCounts(stats.dbTables, start.dbTables);
			const ocGroupStats = diffCounts(stats.ocGroups, start.ocGroups);
			pageCacheHeaders(req, url, r, out, env, d.failures.length);
			// A filled cart means a checkout may follow: start the container now.
			if (env.WOO_CHECKOUT && env.CHECKOUT_CONTAINER === 'on' && r.httpStatusCode === 201 && ADD_TO_CART_ROUTE.test(restRoute(url))) {
				ctx.waitUntil(checkoutContainer(env).startAndWaitForPorts().catch((e) => console.log('checkout warm-up failed', String(e))));
				out.set('x-checkout-warmup', '1');
			}
			trimStats();
			const r2now = JSON.stringify(stats.r2);
			if (r2now !== r2before) out.set('x-r2-ops', Object.entries(stats.r2).map(([k, v]) => `${k}:${v.n - (r2start[k]?.n || 0)}/${v.ms - (r2start[k]?.ms || 0)}ms`).filter((s) => !s.includes(':0/')).join(' '));
			if (sqlDb) {
				out.set('x-db', 'object-sqlite');
				out.set('x-db-rows', `read=${stats.rowsRead - start.rowsRead} written=${stats.rowsWritten - start.rowsWritten}`);
			}
			if (Object.keys(ocTables).length || Object.keys(ocGroupStats).length) out.set('x-oc-stats', JSON.stringify({ dbN: d.calls, dbMs: d.ms, tables: ocTables, groups: ocGroupStats, ocKeys: objectCache.size, ocKiB: Math.round(objectCacheBytes / 1024), ...(ocL2W ? { l2w: { ...ocL2W.counts } } : {}) })); // l2w: this isolate's KV write outcomes so far (#500)
			out.set('x-d1-calls', String(d.calls));
			out.set('x-d1-ms', String(d.ms));
			out.set('x-d1-failures', String(d.failures.length));
			if (d.failures.length && spikeOk && env.SPIKE_TOKEN) out.set('x-d1-first-failure', (d.failures[0].error + ' | ' + d.failures[0].sql).replace(/[^\x20-\x7e]/g, ' ').slice(0, 600));
			out.set('x-php-ms', String(Date.now() - t0)); // #716: wall time at I/O points, not CPU (as phpMs)
			out.set('x-boot', booted ? '1' : '0');
			if (spikeOk && lastMemTrace) out.set('x-mem-trace', JSON.stringify(lastMemTrace).slice(0, 7900));
			lastMemTrace = null;
			if (ctx && ctx.inObject) out.set('x-boot-origin', bootOrigin);
			// The path only, never the query string: a store's URLs carry order keys and logins there.
			console.log(JSON.stringify({ m: 'req', path: url.pathname, boot: booted, d1: d.calls, ...callTag(ctx) }));
			if (qtrace) { console.log(JSON.stringify({ m: 'qtrace', ...memIdOf(req, env), method: req.method, status: r.httpStatusCode, ...qtrace.summary() })); qtrace = null; }
			globalThis.__lastRequest = { url: url.pathname, status: r.httpStatusCode, ...d };
			if (tracing()) fileTrace.end({ status: r.httpStatusCode });
			// #1039: PHP answered 2xx, so this upload's files stay; drop its markers off the answer's path. Any other answer
			// (a 500 after the files were stored is the same orphan as a kill) leaves them for the sweep.
			if (uploadRun && uploadRun.length && dropMarkersOn(r.httpStatusCode)) {
				const p = uploadIntentClear(uploadRun);
				if (ctx && ctx.waitUntil) ctx.waitUntil(p);
				else await p;
			}
			uploadRun = null;
			evictLazy();
			if (remotePacks) remotePacks.endRequest(); // #563: held packs live for one request
			if (sitePacks) sitePacks.endRequest(); // #569: the site packs too (not the hot pack)
			if (fetchBudget) fetchBudget.reset(); // #569: the request's subrequest budget
			dropBootPack(php[__private__dont__use].FS); // #394 L1: the boot files are no longer needed
			const wasmBytes = php[__private__dont__use].HEAPU8.length;
			out.set('x-wasm-mib', String(Math.round(wasmBytes / 1048576)));
			// php-wasm answers a crashed runtime with a bare 500. Never reuse it.
			const crashed = r.httpStatusCode === 500 && r.text === 'Internal Server Error';
			// PHP_RECYCLE=off (opcache.sh only): no recycle for memory while OPcache is
			// primed. A recycle drops the runtime and its file cache, so the dump held
			// only what compiled after it, or answered 409 when the last request
			// recycled (measured 2026-11-06: 3 recycles at 119 MiB with WooCommerce and
			// All-in-One WP Migration). A crashed runtime is still dropped.
			let recycled = null;
			// #566 verification: x-runtime-recycle: force (spike-gated) recycles this runtime as a memory recycle would.
			const forceRecycle = spikeOk && req.headers.get('x-runtime-recycle') === 'force';
			// #598: the line is RECYCLE_WASM_MIB (default 100 MiB, today's). A bad value keeps the default and is
			// logged once per isolate (recycle-line.mjs).
			const line = recycleLine(env, ENGINE_RECYCLE_MIB);
			if (line.refused && !recycleRefusedLogged) {
				recycleRefusedLogged = true;
				console.log(JSON.stringify({ m: 'recycle-line-refused', refused: line.refused }));
			}
			const recycleWhy = recycleDecision({ crashed, forced: forceRecycle, wasmBytes, ocBytes: objectCacheBytes, lineBytes: line.bytes, bootBytes: reuseActive() ? runtimeBootBytes : 0, recycleOff: env.PHP_RECYCLE === 'off' });
			if (recycleWhy) {
				runtimeDrops++;
				dropRuntime(); // #566: queued (this run is executing); released when the run ends, after the response below is built
				recycled = php;
				out.set('x-runtime-recycled', recycleWhy);
			}
			if (ctx && ctx.inObject) {
				runtimeServed++;
				const now = Date.now();
				const perf = {
					iso: ISOLATE_ID,
					...(ctx && ctx.callId ? { call: ctx.callId } : {}), // #708: per request (review 2)
					isoAgeS: Math.round((now - isolateStart) / 1000),
					rt: runtimeSerial,
					rtServed: runtimeServed,
					rtAgeS: Math.round((now - runtimeBootAt) / 1000),
					boot: booted ? 1 : 0,
					bootWaitMs,
					phpMs: phpOnlyMs,
					dbN: d.calls,
					dbMs: d.ms,
					inflates: stats.inflates - start.inflates,
					inflateKiB: Math.round((stats.inflateBytes - start.inflateBytes) / 1024),
					reinflates: stats.reinflates - start.reinflates, // #394 step 2: the CPU side of the arena
					lazyWrites: stats.lazyWrites - start.lazyWrites, // #530: bundle files PHP wrote this request (kept, not dropped)
					wasm0MiB: Math.round(wasm0 / 1048576),
					wasm1MiB: Math.round(wasmBytes / 1048576),
					...(booted ? { l1: l1State } : {}), // #394 L1: where this boot's OPcache boot pack came from
					...(booted && OPCACHE_REMOTE ? { remote: remoteState } : {}), // #563: the remote OPcache packs at this boot
					...(booted && SITE_REMOTE ? { siteRemote: siteState } : {}), // #569: the remote site packs at this boot
					// #352: this request's frame: opened (the first write armed it), commit points, misses, and the
					// rows its PHP transactions undid. Only with REQUEST_FRAMES=on.
					...(env.REQUEST_FRAMES === 'on' && undoLog && frame0 ? (() => { const c = undoLog.counts(); return { frame: { opened: c.opened - frame0.opened, kept: c.kept - frame0.kept, points: c.points - frame0.points, miss: c.miss - frame0.miss, noop: c.noop - frame0.noop, own: c.own - frame0.own, ownTotal: c.own, ...(c.opened > frame0.opened ? { by: undoLog.openedBy(), req: req.headers.get('x-pf-req') || null } : {}) } }; })() : {}),
					// #569: site pack fetches this request (subrequests, the one retry included), KiB, ms,
					// the failed ones (an honest 500 if PHP required the file), the retries, the opens past
					// the hard cap, the distinct packs, and the held high-water (the hot pack not included).
					...(SITE_REMOTE ? { rsN: stats.rsN - remote0.rsN, rsKiB: Math.round((stats.rsBytes - remote0.rsBytes) / 1024), rsMs: stats.rsMs - remote0.rsMs, rsFail: stats.rsFail - remote0.rsFail, rsRetry: stats.rsRetry - remote0.rsRetry, rsCapped: stats.rsCapped - remote0.rsCapped, rsPacks: sitePacks ? sitePacks.lastDistinct() : 0, rsHeldKiB: sitePacks ? Math.round(sitePacks.lastHeldMax() / 1024) : 0 } : {}),
					// #563: remote OPcache pack fetches this request (each one is a subrequest), their KiB and ms,
					// the failed ones (a clean miss: OPcache compiled from source), the opens past the cap, and
					// the high-water of held packs (after LRU eviction; a dropped pack is garbage until V8
					// collects it, which /_headroom measures, not this field), and the DISTINCT packs fetched:
					// rfN minus rfPacks is the refetch count, the held budget thrashing.
					...(OPCACHE_REMOTE ? { rfN: stats.rfN - remote0.rfN, rfKiB: Math.round((stats.rfBytes - remote0.rfBytes) / 1024), rfMs: stats.rfMs - remote0.rfMs, rfFail: stats.rfFail - remote0.rfFail, rfCapped: stats.rfCapped - remote0.rfCapped, rfHeldKiB: remotePacks ? Math.round(remotePacks.lastHeldMax() / 1024) : 0, rfPacks: remotePacks ? remotePacks.lastDistinct() : 0 } : {}),
					...(ledgerActive ? { mem: ledgerSnapshot('end') } : {}), // #394: the isolate memory ledger
					bytes: r.bytes.length,
					httpCalls: stats.httpCalls - start.httpCalls,
					txnOps: stats.txnOps - start.txnOps,
					undoRows: stats.undoRows - start.undoRows,
					ocCalls: stats.ocCalls - start.ocCalls,
					ocHits: stats.ocHits - start.ocHits,
					ocKeys: objectCache.size,
					ocKiB: Math.round(objectCacheBytes / 1024),
					dbTables: ocTables,
					ocGroups: ocGroupStats,
					...(op0 && op1 ? { opHits: op1.hits - op0.hits - 1, opMisses: op1.misses - op0.misses, opCached: op1.cached, opFull: op1.full } : {}),
				};
				out.set('x-perf', JSON.stringify(perf));
				console.log(JSON.stringify({ m: 'perf', id: req.headers.get('x-perf-id'), path: url.pathname, ...perf }));
			} else {
				// #1078: approach A (PHP in the Worker, index-a.js) logs the same timing line, so a tail can time a real suite
				// request: wall, boot, PHP time, and the query count and round-trip total (one bridge call per MySQL query).
				console.log(JSON.stringify(aPerfLine({ id: memIdOf(req, env).id, method: req.method, path: url.pathname, status: r.httpStatusCode, iso: ISOLATE_ID, isoAgeS: Math.round((Date.now() - isolateStart) / 1000), rt: runtimeSerial, rtAgeS: Math.round((Date.now() - runtimeBootAt) / 1000), boot: booted, bootWaitMs, phpMs: phpOnlyMs, dbN: d.calls, dbMs: d.ms, wallMs: Date.now() - tBoot, wasm1MiB: Math.round(wasmBytes / 1048576), recycled: recycleWhy || null, rfN: stats.rfN - remote0.rfN, rfKiB: Math.round((stats.rfBytes - remote0.rfBytes) / 1024), rfMs: stats.rfMs - remote0.rfMs, rfFail: stats.rfFail - remote0.rfFail, rsN: stats.rsN - remote0.rsN, rsKiB: Math.round((stats.rsBytes - remote0.rsBytes) / 1024), rsMs: stats.rsMs - remote0.rsMs, rsFail: stats.rsFail - remote0.rsFail, httpN: stats.httpCalls - start.httpCalls, httpMs: stats.httpMs - (start.httpMs || 0), inflates: stats.inflates - start.inflates, inflateKiB: Math.round((stats.inflateBytes - start.inflateBytes) / 1024), ocCalls: stats.ocCalls - start.ocCalls, ocHits: stats.ocHits - start.ocHits, l2N: stats.l2N - start.l2N, l2Hits: stats.l2Hits - start.l2Hits, l2Misses: (stats.l2N - start.l2N) - (stats.l2Hits - start.l2Hits), l2Ms: stats.l2Ms - start.l2Ms, ...(op0 && op1 ? { opHits: op1.hits - op0.hits - 1, opMisses: op1.misses - op0.misses, opCached: op1.cached, opFull: op1.full } : {}) })));
			}
			const response = new Response(r.bytes, { status: r.httpStatusCode, headers: out });
			// #394 (b): a recycled runtime is RELEASED, not only forgotten. bootPromise = null alone left
			// lastBootedPhp holding the old runtime, WASM memory and all, until the next boot had built a
			// new one: after a post-new.php recycle (115 to 121 MiB) the next request booted with both.
			// The response above is built first, so its bytes are not touched.
			return response;
		} catch (e) {
			// #598: a refused boot ran nothing: not a runtime drop. It is converted once, at handle() (boot() has
			// already dropped the refused promise).
			if (e && e.bootRefused) throw e;
			// #954: a thrown activate is not a finished request. Roll the plugin hold back before end() keeps the frame.
			try { if (undoLog && sqlDb) undoLog.rollbackFrame(sqlDb, sqlStorage); } catch (err) { console.log(JSON.stringify({ m: 'frame-rollback-failed', error: String((err && err.message) || err).slice(0, 160) })); }
			try { if (undoLog) await undoLog.finishCacheDrops(); } catch (err) { console.log(JSON.stringify({ m: 'options-cache-drop-failed', error: String((err && err.message) || err).slice(0, 160) })); }
			if (bootPromise) runtimeDrops++;
			dropRuntime(); // a failed runtime is not reused
			// The stack names internal paths. It goes to the tail log for every caller, never to the body,
			// so a leaked spike token cannot also leak stacks.
			console.error(String((e && e.stack) || e));
			// #569: a SITE_REMOTE boot refusal says why (a fixed code and text; no internal path).
			if (e && e.siteRemoteRefused) return new Response('site unavailable: ' + e.siteRemoteRefused + '\n', { status: 503, headers: { 'x-site-remote-refused': e.siteRemoteRefused, 'cache-control': 'no-store' } });
			return new Response('internal error', { status: 500 });
		}
	}
}
