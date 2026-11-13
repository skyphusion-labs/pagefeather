// Zip a plugin or theme directory without holding the whole unpacked tree in memory (#449).
//
// The first code store (#433) read every file of the directory into one object, then zipped it:
// the peak was the whole unpacked tree plus the zip. On pft1a (Gate 2 tier 1, 2026-11-13) every
// install whose unpacked tree was about 15 MB or more reset the isolate at the store step. Here
// each file is read only when the zip needs it and is let go after it is compressed, so the peak is
// the zip so far plus one file.
import { Zip, ZipDeflate } from 'fflate';

/**
 * entries: an iterable of { name, read } (read() returns the file's bytes, called once).
 * maxRaw: refuse (throw) once the unpacked total passes it, before any more is read.
 * Returns { zip: Uint8Array, raw, files }.
 */
export function zipStream(entries, { maxRaw = Infinity, level = 6 } = {}) {
	const chunks = [];
	let size = 0;
	let failure = null;
	const z = new Zip((err, chunk) => {
		if (err) failure = err;
		else if (chunk && chunk.length) {
			chunks.push(chunk);
			size += chunk.length;
		}
	});
	let raw = 0;
	let files = 0;
	for (const e of entries) {
		const data = e.read();
		raw += data.length;
		if (raw > maxRaw) {
			z.terminate();
			throw new Error('it is larger than ' + Math.round(maxRaw / 1048576) + ' MB unpacked');
		}
		const f = new ZipDeflate(e.name, { level });
		z.add(f);
		f.push(data, true);
		files++;
		if (failure) throw failure;
	}
	z.end();
	if (failure) throw failure;
	const zip = new Uint8Array(size);
	let at = 0;
	for (const c of chunks) {
		zip.set(c, at);
		at += c.length;
	}
	return { zip, raw, files };
}
