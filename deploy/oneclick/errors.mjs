// What an error may show (#414, CodeQL js/stack-trace-exposure). A BadRequest
// carries text this code wrote for the user, so it is shown as it is. Any other
// error may carry an upstream message (a Cloudflare API answer, a runtime
// exception), so the user sees only "Something went wrong" and a short random
// reference; the reference and the real error go to console.error, which is in
// Workers Logs. The reference joins the two.
import { BadRequest } from '../provision/server-config.mjs';

export function newRef() {
  const a = new Uint8Array(6);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

// Returns { status, message } that is safe to put in a response.
export function shown(e, where = 'request') {
  if (e instanceof BadRequest) return { status: 400, message: e.message };
  const ref = newRef();
  console.error(`pagefeather ${where} failed, reference ${ref}:`, (e && e.stack) || e);
  return { status: 500, message: `Something went wrong (reference ${ref}).` };
}

// Log a detail that is not shown (for example a failed WooCommerce activation),
// and return the reference to show in its place.
export function logged(where, detail) {
  const ref = newRef();
  console.error(`pagefeather ${where}, reference ${ref}:`, detail);
  return ref;
}
