// The headroom probe (#394, /_headroom): allocate 1 MiB ArrayBuffers, each filled and HELD, and stream
// the running count until a step throws or the isolate dies. The last "mib N" a client reads is how far
// this isolate could still grow. Measured first on throwaway Workers (#394 floor rounds 1 to 6): a bare
// isolate reaches 255. Inside the PHP object, 255 minus the reach minus the live wasm heap is what the
// runtime holds outside the wasm heap (the JS heap, inflate copies, strings, retired runtimes).
// A MEASUREMENT that ends the isolate: run it only on a throwaway, where the next request may boot cold.
export function headroomStream({ first, max = 1024, alloc = () => new ArrayBuffer(1048576) }) {
	const cap = Math.min(4096, Math.max(1, Math.trunc(Number(max)) || 1));
	const { readable, writable } = new TransformStream();
	const w = writable.getWriter();
	const enc = new TextEncoder();
	const line = (s) => w.write(enc.encode(s + '\n'));
	const job = (async () => {
		const held = [];
		let mib = 0;
		try {
			await line(first);
			while (mib < cap) {
				const b = alloc();
				new Uint8Array(b).fill(1);
				held.push(b);
				mib++;
				await line('mib ' + mib);
			}
			await line('done ' + mib + ' held ' + held.length);
		} catch (e) {
			try { await line('threw at ' + mib + ' ' + String((e && e.message) || e).slice(0, 120)); } catch {}
		}
		try { await w.close(); } catch {}
	})();
	return { response: new Response(readable, { headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } }), job };
}
