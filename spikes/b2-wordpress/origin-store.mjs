// The site origin the object keeps for its cron alarm (issue #391).
//
// Every request used to put ORIGIN_KEY, also when the value was the same. A put holds the
// Durable Object's output gate: the response does not leave until the write is confirmed, and
// the confirmation needs a free turn of the event loop. A PHP render never yields (DB_IN_DO), so
// in a burst every response waited for the whole burst and left at the end (measured on
// shed1113a, 2026-11-13: N=16, all 16 answers within 0.2 s of each other at about 16 s; N=48 and
// up, memory resets at about 33 s). A plain GET that writes nothing must release its response at
// once. So the put runs only when the stored value differs. The read is cached by the object, and
// a read does not hold the output gate.

export const ORIGIN_KEY = 'skyphusion-origin';

/**
 * Store origin unless it is already stored. `cached` is what this isolate last stored or read (a
 * module variable). Returns true when it wrote. The write keeps its full durability: it is a
 * normal put, never allowUnconfirmed.
 */
export async function storeOriginIfChanged(storage, origin, cached) {
	if (cached === origin) return false;
	if ((await storage.get(ORIGIN_KEY)) === origin) return false;
	await storage.put(ORIGIN_KEY, origin);
	return true;
}
