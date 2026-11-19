// Upload name reservation (_r2_reserved). One insert owns a name.
// A delete of that object releases the name. A row whose object is
// already gone is free for the next upload. Issue #946. Issue #952.

export const RESERVE_DDL = 'CREATE TABLE IF NOT EXISTS _r2_reserved (key TEXT PRIMARY KEY, at INTEGER NOT NULL)';
export const RESERVE_INSERT = 'INSERT OR IGNORE INTO _r2_reserved (key, at) VALUES (?, ?)';
export const RESERVE_DELETE = 'DELETE FROM _r2_reserved WHERE key = ?';

function missingTable(e) {
	return /no such table/i.test(String((e && e.message) || e));
}

/** Drop one reserved name. A missing table means nothing was reserved. */
export function releaseReservedName(db, key) {
	try {
		db.exec(RESERVE_DELETE, key);
	} catch (e) {
		if (!missingTable(e)) throw e;
	}
}

/** D1 form of the same release. */
export async function releaseReservedD1(db, key) {
	try {
		await db.prepare(RESERVE_DELETE).bind(key).run();
	} catch (e) {
		if (!missingTable(e)) throw e;
	}
}

/**
 * Reserve key unless the object is still in R2.
 * changes(db, run) is index.js sqlChanges: 1 when the insert wrote a row.
 * A row with no object is not a live upload. This object runs one PHP
 * request at a time, so that row is an orphan. Drop it and take the name.
 * Returns true when this caller owns the name.
 */
export function tryReserveName(db, key, objectExists, now, changes) {
	db.exec(RESERVE_DDL);
	if (objectExists) return false;
	if (changes(db, () => db.exec(RESERVE_INSERT, key, now)) === 1) return true;
	releaseReservedName(db, key);
	return changes(db, () => db.exec(RESERVE_INSERT, key, now)) === 1;
}
