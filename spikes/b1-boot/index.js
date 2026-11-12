import wasmModule from './node_modules/@php-wasm/web-8-3/jspi/8_3_36/php_8_3.wasm';
import * as loader from './vendor/php_8_3.js';
import { loadPHPRuntime, PHP } from '@php-wasm/universal';

let phpPromise;
let ENV;
let d1Calls = 0;
async function boot() {
  const t0 = Date.now();
  const id = await loadPHPRuntime(loader, {
    instantiateWasm(imports, done) {
      const inst = new WebAssembly.Instance(wasmModule, imports);
      done(inst, wasmModule);
      return inst.exports;
    },
  });
  const php = new PHP(id);
  php.onMessage(async (raw) => {
    const m = JSON.parse(raw);
    d1Calls++;
    try {
      const r = await ENV.DB.prepare(m.sql).bind(...(m.params || [])).all();
      return JSON.stringify({ ok: true, rows: r.results, meta: { changes: r.meta.changes, last_row_id: r.meta.last_row_id } });
    } catch (e) {
      return JSON.stringify({ ok: false, error: String(e.message || e) });
    }
  });
  return { php, bootMs: Date.now() - t0 };
}

export default {
  async fetch(req, env) {
    ENV = env;
    try {
      phpPromise ??= boot();
      const { php, bootMs } = await phpPromise;
      if (new URL(req.url).pathname === '/_ping') return new Response('ok');
      const d1 = new URL(req.url).searchParams.get('d1');
      const code = d1 ? `<?php
        function d1($sql, $params = []) { return json_decode(post_message_to_js(json_encode(['sql'=>$sql,'params'=>$params])), true); }
        $out = [];
        $out[] = d1('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT)');
        $out[] = d1('INSERT INTO t (v) VALUES (?)', ['hello from php']);
        $out[] = d1('SELECT count(*) AS n, max(v) AS v FROM t');
        echo json_encode($out);` : new URL(req.url).searchParams.get('info') ? '<?php phpinfo();' :
        '<?php echo json_encode(["php"=>PHP_VERSION,"pdo"=>PDO::getAvailableDrivers(),"mem"=>memory_get_peak_usage(true),"ext"=>get_loaded_extensions()]);';
      const t1 = Date.now();
      const r = await php.run({ code });
      return new Response(JSON.stringify({ bootMs, runMs: Date.now() - t1, d1Calls, out: r.text, err: r.errors }), { headers: { 'content-type': 'application/json' } });
    } catch (e) {
      // The stack names internal paths; it goes to the tail log, not to the caller.
      console.error(String(e && e.stack || e));
      return new Response('internal error', { status: 500 });
    }
  },
};
