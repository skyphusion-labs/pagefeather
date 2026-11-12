// A stand-in Cloudflare API for the golden render test (#328 PR 0). It answers every call the
// provisioning core makes for a new site, and records each call: the method, the path, and the
// body. A secret_text value is replaced with "<redacted>", so a golden never holds a secret
// value. Request headers (the API token, the x-spike-token) are not recorded.
const CF_API = 'https://api.cloudflare.com/client/v4';

function res(status, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: async () => text, json: async () => JSON.parse(text) };
}

function redact(bindings) {
  return (bindings || []).map((b) => (b && b.type === 'secret_text' ? { ...b, text: '<redacted>' } : b));
}

async function bodyOf(body) {
  if (body === undefined || body === null) return null;
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    const meta = JSON.parse(await body.get('metadata').text());
    meta.bindings = redact(meta.bindings);
    const modules = [];
    for (const [k, v] of body.entries()) {
      if (k !== 'metadata') modules.push({ name: k, type: v.type });
    }
    return { metadata: meta, modules };
  }
  if (typeof body === 'string') {
    try { return JSON.parse(body); } catch { return body; }
  }
  return String(body);
}

export function makeRecorder() {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    const method = init.method || 'GET';
    calls.push({ method, path: u.startsWith(CF_API) ? u.slice(CF_API.length) : u, body: await bodyOf(init.body) });
    if (method === 'POST' && u.endsWith('/_install')) return res(200, { out: '{"installed":true,"user_id":1}', ms: 5 });
    if (method === 'POST' && /\/storage\/kv\/namespaces$/.test(u)) return res(200, { success: true, result: { id: 'kv-namespace-test-id', title: 'test' } });
    if (method === 'POST' && /\/vectorize\/v2\/indexes$/.test(u)) return res(200, { success: true, result: { name: JSON.parse(init.body).name } });
    if (method === 'POST' && /\/queues$/.test(u)) return res(200, { success: true, result: { queue_id: 'queue-test-id', queue_name: 'test' } });
    if (method === 'GET' && /\/storage\/kv\/namespaces\/[^/]+\/values\//.test(u)) return res(404, { success: false, errors: [{ code: 10009, message: 'key not found' }] });
    if (method === 'GET' && /\/scripts\/[^/]+$/.test(u)) return res(404, { success: false, errors: [{ code: 10090 }] });
    return res(200, { success: true, result: {} });
  };
  return { calls, fetchImpl };
}

// The one script upload in a capture: the namespace PUT of site-<name>.
export function uploadOf(calls) {
  return calls.find((c) => c.method === 'PUT' && /\/workers\/dispatch\/namespaces\/[^/]+\/scripts\/[^/]+$/.test(c.path));
}

export function stable(x) {
  return JSON.stringify(x, null, 2) + '\n';
}
