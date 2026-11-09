// A minimal MySQL text-protocol client for approach A (issue #218), written to
// replace mysql2 on the JS side. The whole reason it exists: mysql2 is a full
// Node client (connection manager, prepared statements, compression, streaming,
// plus iconv-lite/long/named-placeholders/denque/lru-cache/sqlstring and the
// Node built-in polyfills Workers injects for them). All of that lives in the
// Worker isolate's JS/V8 heap, a SEPARATE consumer from the PHP WASM heap, and
// both count against the 128 MiB isolate cap. b-dosql clears a WooCommerce
// write at x-wasm-mib 99; approach A 503s at the SAME wasm level because the
// mysql2 JS heap eats the ~29 MiB headroom (128-99) the Woo spike needs. This
// client speaks only what php/hyperdrive-db.php actually uses: connect, one
// text query at a time (COM_QUERY), text result sets, and close. No prepared
// statements, no pooling (Hyperdrive pools the real connections), no streaming.
//
// Connection is to the Hyperdrive binding's host/port, exactly as mysql2 was.
// Hyperdrive runs adjacent to the Worker in Cloudflare's network, so the hop is
// an internal trusted link; caching_sha2_password full auth sends the password
// over that link the same way Hyperdrive's own documented drivers do.
import { connect } from 'cloudflare:sockets';

// Capability flags we assert.
const CLIENT_LONG_PASSWORD = 0x00000001;
const CLIENT_FOUND_ROWS = 0x00000002; // mysqli/WordPress expects matched-rows semantics off; mysql2 default leaves this off, so we do too.
const CLIENT_LONG_FLAG = 0x00000004;
const CLIENT_CONNECT_WITH_DB = 0x00000008;
const CLIENT_PROTOCOL_41 = 0x00000200;
const CLIENT_TRANSACTIONS = 0x00002000;
const CLIENT_SECURE_CONNECTION = 0x00008000;
const CLIENT_PLUGIN_AUTH = 0x00080000;

const CHARSET_UTF8MB4 = 45; // utf8mb4_general_ci; matches mysql-bridge's charset: 'utf8mb4'.

const td = new TextDecoder('utf8');
const te = new TextEncoder();

async function sha1(bytes) {
	return new Uint8Array(await crypto.subtle.digest('SHA-1', bytes));
}
async function sha256(bytes) {
	return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}
function xor(a, b) {
	const out = new Uint8Array(a.length);
	for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i % b.length];
	return out;
}
function concat(arrs) {
	let n = 0;
	for (const a of arrs) n += a.length;
	const out = new Uint8Array(n);
	let o = 0;
	for (const a of arrs) {
		out.set(a, o);
		o += a.length;
	}
	return out;
}

// mysql_native_password: SHA1(pw) XOR SHA1(salt + SHA1(SHA1(pw))).
async function scrambleNative(password, salt) {
	if (!password) return new Uint8Array(0);
	const pw = te.encode(password);
	const s1 = await sha1(pw);
	const s2 = await sha1(s1);
	const s3 = await sha1(concat([salt, s2]));
	return xor(s1, s3);
}

// caching_sha2_password fast path: SHA256(pw) XOR SHA256(SHA256(SHA256(pw)) + salt).
async function scrambleCachingSha2(password, salt) {
	if (!password) return new Uint8Array(0);
	const pw = te.encode(password);
	const s1 = await sha256(pw);
	const s2 = await sha256(s1);
	const s3 = await sha256(concat([s2, salt]));
	return xor(s1, s3);
}

// A length-encoded integer reader/writer.
function readLenencInt(buf, pos) {
	const first = buf[pos];
	if (first < 0xfb) return [first, pos + 1];
	if (first === 0xfb) return [null, pos + 1]; // NULL in a row context.
	if (first === 0xfc) return [buf[pos + 1] | (buf[pos + 2] << 8), pos + 3];
	if (first === 0xfd) return [buf[pos + 1] | (buf[pos + 2] << 8) | (buf[pos + 3] << 16), pos + 4];
	// 0xfe: 8-byte. JS numbers hold MySQL row/id counts well past any real table.
	let v = 0;
	for (let i = 0; i < 8; i++) v += buf[pos + 1 + i] * Math.pow(2, 8 * i);
	return [v, pos + 9];
}
function lenencIntBytes(n) {
	if (n < 0xfb) return new Uint8Array([n]);
	if (n < 0x10000) return new Uint8Array([0xfc, n & 0xff, (n >> 8) & 0xff]);
	if (n < 0x1000000) return new Uint8Array([0xfd, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff]);
	const out = new Uint8Array(9);
	out[0] = 0xfe;
	let v = n;
	for (let i = 0; i < 8; i++) {
		out[1 + i] = v & 0xff;
		v = Math.floor(v / 256);
	}
	return out;
}
// A length-encoded string: lenenc length, then that many bytes. Returns [Uint8Array, newPos].
function readLenencBytes(buf, pos) {
	const [len, p] = readLenencInt(buf, pos);
	if (len === null) return [null, p];
	return [buf.subarray(p, p + len), p + len];
}

export class LeanMysql {
	constructor(socket) {
		this.socket = socket;
		this.writer = socket.writable.getWriter();
		this.reader = socket.readable.getReader();
		this.inbuf = new Uint8Array(0);
		this.closed = false;
	}

	static async connect({ host, user, password, database, port }) {
		const socket = connect({ hostname: host, port: Number(port) || 3306 });
		const c = new LeanMysql(socket);
		await c.handshake(user, password || '', database || '');
		return c;
	}

	// Pull one full MySQL packet: 3-byte LE length + 1-byte seq, then payload.
	async readPacket() {
		while (true) {
			if (this.inbuf.length >= 4) {
				const len = this.inbuf[0] | (this.inbuf[1] << 8) | (this.inbuf[2] << 16);
				const seq = this.inbuf[3];
				// A payload of exactly 0xffffff is split across continuation packets
				// (MySQL's 16 MiB framing). WordPress/Woo rows this large are rare, and
				// this client does not reassemble them, so fail loudly rather than parse
				// a continuation as the next row (silent stream desync). rollins, PR #233.
				if (len === 0xffffff) throw new Error('mysql-lean: packets >= 16 MiB (0xffffff continuation) are not supported');
				if (this.inbuf.length >= 4 + len) {
					const payload = this.inbuf.subarray(4, 4 + len);
					// Copy out so the retained buffer can shrink without aliasing.
					const out = payload.slice();
					this.inbuf = this.inbuf.subarray(4 + len);
					return { seq, payload: out };
				}
			}
			const { value, done } = await this.reader.read();
			if (done) throw new Error('mysql: socket closed mid-packet');
			this.inbuf = this.inbuf.length ? concat([this.inbuf, value]) : value;
		}
	}

	async writePacket(seq, payload) {
		const header = new Uint8Array(4);
		const len = payload.length;
		header[0] = len & 0xff;
		header[1] = (len >> 8) & 0xff;
		header[2] = (len >> 16) & 0xff;
		header[3] = seq & 0xff;
		await this.writer.write(concat([header, payload]));
	}

	async handshake(user, password, database) {
		const { payload } = await this.readPacket();
		let pos = 0;
		const protocol = payload[pos++];
		if (protocol === 0xff) throw mysqlErr(payload); // server rejected before handshake
		// server version, NUL-terminated
		while (payload[pos] !== 0x00) pos++;
		pos++;
		pos += 4; // connection id
		const salt1 = payload.subarray(pos, pos + 8);
		pos += 8;
		pos++; // filler
		let caps = payload[pos] | (payload[pos + 1] << 8);
		pos += 2;
		let authPluginDataLen = 0;
		let salt2 = new Uint8Array(0);
		let pluginName = 'mysql_native_password';
		if (pos < payload.length) {
			pos++; // charset
			pos += 2; // status flags
			caps |= (payload[pos] | (payload[pos + 1] << 8)) << 16;
			pos += 2;
			authPluginDataLen = payload[pos];
			pos++;
			pos += 10; // reserved
			const salt2len = Math.max(13, authPluginDataLen - 8);
			salt2 = payload.subarray(pos, pos + salt2len);
			pos += salt2len;
			// drop the trailing NUL of part 2
			if (salt2.length && salt2[salt2.length - 1] === 0x00) salt2 = salt2.subarray(0, salt2.length - 1);
			if (caps & CLIENT_PLUGIN_AUTH) {
				let e = pos;
				while (e < payload.length && payload[e] !== 0x00) e++;
				pluginName = td.decode(payload.subarray(pos, e));
			}
		}
		const salt = concat([salt1, salt2]);
		this.serverCaps = caps;

		let authResp;
		if (pluginName === 'caching_sha2_password') authResp = await scrambleCachingSha2(password, salt);
		else authResp = await scrambleNative(password, salt);

		await this.sendHandshakeResponse(user, database, authResp, pluginName);

		// Auth result: OK (0x00), ERR (0xff), AuthSwitchRequest (0xfe), or
		// AuthMoreData (0x01) for caching_sha2_password.
		let resp = await this.readPacket();
		let seq = resp.seq + 1;
		while (true) {
			const p = resp.payload;
			const tag = p[0];
			if (tag === 0x00) return; // OK, authenticated
			if (tag === 0xff) throw mysqlErr(p);
			if (tag === 0xfe) {
				// AuthSwitchRequest: plugin name NUL-terminated, then new salt.
				let e = 1;
				while (p[e] !== 0x00) e++;
				const newPlugin = td.decode(p.subarray(1, e));
				const newSalt0 = p.subarray(e + 1);
				const newSalt = newSalt0.length && newSalt0[newSalt0.length - 1] === 0x00 ? newSalt0.subarray(0, newSalt0.length - 1) : newSalt0;
				let r2;
				if (newPlugin === 'caching_sha2_password') r2 = await scrambleCachingSha2(password, newSalt);
				else if (newPlugin === 'mysql_clear_password') r2 = concat([te.encode(password), new Uint8Array([0])]);
				else r2 = await scrambleNative(password, newSalt);
				await this.writePacket(seq++, r2);
				resp = await this.readPacket();
				seq = resp.seq + 1;
				continue;
			}
			if (tag === 0x01) {
				// AuthMoreData for caching_sha2_password.
				const status = p[1];
				if (status === 0x03) {
					// fast auth success; an OK packet follows.
					resp = await this.readPacket();
					seq = resp.seq + 1;
					continue;
				}
				if (status === 0x04) {
					// full auth. Over Hyperdrive's internal link we send the
					// password as cleartext (NUL-terminated), the same posture
					// Hyperdrive's documented drivers use; no RSA exchange.
					await this.writePacket(seq++, concat([te.encode(password), new Uint8Array([0])]));
					resp = await this.readPacket();
					seq = resp.seq + 1;
					continue;
				}
				throw new Error('mysql: unexpected auth more-data status 0x' + status.toString(16));
			}
			throw new Error('mysql: unexpected auth response tag 0x' + tag.toString(16));
		}
	}

	async sendHandshakeResponse(user, database, authResp, pluginName) {
		let caps = CLIENT_LONG_PASSWORD | CLIENT_LONG_FLAG | CLIENT_PROTOCOL_41 | CLIENT_TRANSACTIONS | CLIENT_SECURE_CONNECTION | CLIENT_PLUGIN_AUTH;
		if (database) caps |= CLIENT_CONNECT_WITH_DB;
		const parts = [];
		const head = new Uint8Array(32);
		head[0] = caps & 0xff;
		head[1] = (caps >> 8) & 0xff;
		head[2] = (caps >> 16) & 0xff;
		head[3] = (caps >> 24) & 0xff;
		// max packet size 16 MiB
		head[4] = 0x00;
		head[5] = 0x00;
		head[6] = 0x00;
		head[7] = 0x01;
		head[8] = CHARSET_UTF8MB4;
		// 23 bytes reserved already zero
		parts.push(head);
		parts.push(te.encode(user), new Uint8Array([0]));
		// CLIENT_SECURE_CONNECTION: 1-byte auth length + data
		parts.push(new Uint8Array([authResp.length]), authResp);
		if (database) parts.push(te.encode(database), new Uint8Array([0]));
		parts.push(te.encode(pluginName), new Uint8Array([0]));
		await this.writePacket(1, concat(parts));
	}

	// Run one text query. Returns either
	//   { kind: 'ok', affectedRows, insertId }  for INSERT/UPDATE/DELETE/DDL, or
	//   { kind: 'result', columns: [{name, characterSet}], rows: [[Uint8Array|null,...]] }
	// Throws a MySQL error (with .errno) on an ERR packet.
	async query(sql) {
		// COM_QUERY = 0x03. Each command resets the sequence to 0.
		await this.writePacket(0, concat([new Uint8Array([0x03]), te.encode(sql)]));
		const first = (await this.readPacket()).payload;
		const tag = first[0];
		if (tag === 0xff) throw mysqlErr(first);
		if (tag === 0x00 || tag === 0xfe) return this.parseOk(first); // OK (0xfe only as short OK, but a column count of 0xfe is impossible here)
		if (tag === 0xfb) throw new Error('mysql: LOCAL INFILE is not supported');

		// tag is the start of a length-encoded column count.
		const [colCount] = readLenencInt(first, 0);
		const columns = [];
		for (let i = 0; i < colCount; i++) {
			const def = (await this.readPacket()).payload;
			columns.push(parseColumnDef(def));
		}
		// EOF after column defs (we did not set CLIENT_DEPRECATE_EOF).
		await this.readPacket();
		const rows = [];
		while (true) {
			const p = (await this.readPacket()).payload;
			if (p[0] === 0xfe && p.length < 9) break; // EOF: end of rows
			if (p[0] === 0xff) throw mysqlErr(p);
			const row = new Array(colCount);
			let pos = 0;
			for (let i = 0; i < colCount; i++) {
				const [val, np] = readLenencBytes(p, pos);
				row[i] = val === null ? null : val.slice(); // detach from the packet buffer
				pos = np;
			}
			rows.push(row);
		}
		return { kind: 'result', columns, rows };
	}

	parseOk(payload) {
		// OK packet: 0x00 header, lenenc affected_rows, lenenc last_insert_id, ...
		let pos = 1;
		let affectedRows, insertId;
		[affectedRows, pos] = readLenencInt(payload, pos);
		[insertId, pos] = readLenencInt(payload, pos);
		return { kind: 'ok', affectedRows: affectedRows || 0, insertId: insertId || 0 };
	}

	async end() {
		if (this.closed) return;
		this.closed = true;
		try {
			// COM_QUIT = 0x01
			await this.writePacket(0, new Uint8Array([0x01]));
		} catch {}
		try {
			this.writer.releaseLock();
		} catch {}
		try {
			this.reader.releaseLock();
		} catch {}
		try {
			await this.socket.close();
		} catch {}
	}
}

function parseColumnDef(buf) {
	// Protocol 41 column definition. Skip catalog/schema/table/org_table, read
	// name, skip org_name, then fixed block: filler lenenc(0x0c), charset(2), ...
	let pos = 0;
	for (let i = 0; i < 4; i++) pos = skipLenenc(buf, pos); // catalog, schema, table, org_table
	let name;
	[name, pos] = readLenencBytes(buf, pos);
	pos = skipLenenc(buf, pos); // org_name
	// next is lenenc length of fixed fields (0x0c), then charset(2), length(4), type(1), flags(2), decimals(1)
	const [, fpos] = readLenencInt(buf, pos);
	pos = fpos;
	const characterSet = buf[pos] | (buf[pos + 1] << 8);
	return { name: name === null ? '' : td.decode(name), characterSet };
}
function skipLenenc(buf, pos) {
	const [len, p] = readLenencInt(buf, pos);
	return len === null ? p : p + len;
}

function mysqlErr(payload) {
	// ERR packet: 0xff, errno(2), optional '#'+sqlstate(5), message.
	const errno = payload[1] | (payload[2] << 8);
	let pos = 3;
	if (payload[pos] === 0x23) pos += 6; // '#' + 5-char sqlstate
	const message = td.decode(payload.subarray(pos));
	const e = new Error(message || ('mysql errno ' + errno));
	e.errno = errno;
	return e;
}
