// Compare two operator tokens without returning at the first different byte (#1431).
// Both sides are hashed with SHA-256. The 32-byte digests are XOR-compared, so the
// compare does not depend on where the strings differ or on their lengths. An empty
// value, or a non-string, never matches.

export async function tokensEqual(given, want) {
	if (typeof given !== 'string' || typeof want !== 'string' || given.length === 0 || want.length === 0) return false;
	const enc = new TextEncoder();
	const [da, db] = await Promise.all([
		crypto.subtle.digest('SHA-256', enc.encode(given)),
		crypto.subtle.digest('SHA-256', enc.encode(want)),
	]);
	const x = new Uint8Array(da);
	const y = new Uint8Array(db);
	let diff = 0;
	for (let i = 0; i < 32; i++) diff |= x[i] ^ y[i];
	return diff === 0;
}
