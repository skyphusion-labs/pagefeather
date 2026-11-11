// The demo gate (#182 Path B): ONE Durable Object that holds the demo rate and
// concurrency counts, so a check and its increment are a single step. KV reads
// can be stale, so parallel requests that each read a KV count can all pass it;
// the gate cannot be raced that way. handleDemo reserves a slot here before it
// provisions, and releases the slot if the provision fails.
//
// One record under one storage key: the current hour, the per-IP and global
// counts for that hour, and the live slots (slot id -> expiry). Every call runs
// through this.queue, one after another, so the read, the check and the write of
// one call never interleave with another call, on Cloudflare and in a test alike.
//
// A plain class with fetch(), so a node test can construct it with a fake
// storage. The binding is DEMO_GATE (wrangler.demo.toml); the worker uses the one
// instance named DEMO_GATE_NAME.
import {
  DEMO_TTL_MS, DEMO_MAX_PER_IP_PER_HOUR, DEMO_MAX_GLOBAL_PER_HOUR, DEMO_MAX_CONCURRENT,
} from './shared.mjs';

export const DEMO_GATE_NAME = 'demo-gate';

export class DemoGate {
  constructor(state, env) {
    this.storage = state.storage;
    this.env = env;
    this.queue = Promise.resolve();
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    let body = {};
    try { body = await request.json(); } catch { body = {}; }
    const run = () => (path === '/release' ? this.release(body) : this.reserve(body));
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    try {
      return Response.json(await p);
    } catch {
      // Fail closed: a storage error admits nothing.
      return Response.json({ ok: false, scope: 'error' }, { status: 500 });
    }
  }

  async load(now) {
    const hour = Math.floor(now / 3600000);
    const prev = (await this.storage.get('state')) || {};
    const s = prev.hour === hour
      ? { hour, ip: prev.ip || {}, global: prev.global || 0, slots: prev.slots || {} }
      : { hour, ip: {}, global: 0, slots: prev.slots || {} };
    for (const [id, exp] of Object.entries(s.slots)) if (!(exp > now)) delete s.slots[id];
    return s;
  }

  // Reserve one demo for ip: refuse at the per-IP or global hourly cap, or when
  // every concurrency slot is taken; otherwise count it and hold a slot until the
  // demo expires.
  async reserve({ ip, ttlMs } = {}) {
    const now = Date.now();
    const s = await this.load(now);
    const key = typeof ip === 'string' && ip ? ip : 'unknown';
    if ((s.ip[key] || 0) >= DEMO_MAX_PER_IP_PER_HOUR) return { ok: false, scope: 'ip' };
    if (s.global >= DEMO_MAX_GLOBAL_PER_HOUR) return { ok: false, scope: 'global' };
    if (Object.keys(s.slots).length >= DEMO_MAX_CONCURRENT) return { ok: false, scope: 'capacity' };
    const slot = crypto.randomUUID();
    s.ip[key] = (s.ip[key] || 0) + 1;
    s.global += 1;
    s.slots[slot] = now + (Number(ttlMs) > 0 ? Number(ttlMs) : DEMO_TTL_MS);
    await this.storage.put('state', s);
    return { ok: true, slot };
  }

  // Free a slot whose demo was never created (the provision failed). The hourly
  // counts stay: an attempt still counts against the rate.
  async release({ slot } = {}) {
    const s = await this.load(Date.now());
    if (typeof slot === 'string' && s.slots[slot]) {
      delete s.slots[slot];
      await this.storage.put('state', s);
      return { ok: true, released: true };
    }
    return { ok: true, released: false };
  }
}

// Call the gate from the worker. Returns the gate's JSON reply; any failure to
// reach it is { ok: false, scope: 'error' } (fail closed).
export async function callDemoGate(env, path, body) {
  try {
    const stub = env.DEMO_GATE.get(env.DEMO_GATE.idFromName(DEMO_GATE_NAME));
    const res = await stub.fetch(`https://demo-gate${path}`, { method: 'POST', body: JSON.stringify(body || {}) });
    const j = await res.json();
    return j && typeof j === 'object' ? j : { ok: false, scope: 'error' };
  } catch {
    return { ok: false, scope: 'error' };
  }
}
