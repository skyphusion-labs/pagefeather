// #1178: a CONNECTION fault, as opposed to an error in the statement. The lean client's socket closed mid-packet on a warm
// isolate (cf759hl), and the request treated 5 failed statements as the statements' own errors.
export const CONNECTION_FAULT = /socket closed|mid-packet|connection (?:lost|reset|closed|refused)|network connection lost|ECONNRESET|EPIPE|broken pipe|stream (?:was )?(?:closed|cancelled|canceled)|lost earlier in this run/i;

export function isConnectionFault(error) {
	return CONNECTION_FAULT.test(String(error || ''));
}

// A write, or any statement whose effect is not a pure read: never retried blind (it may have been applied).
export function isWriteSql(sql) {
	return /^\s*\(?\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|TRUNCATE|RENAME|LOCK|UNLOCK|CALL|DO|LOAD|GRANT|REVOKE|SET|START|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(String(sql || ''));
}

// A read that a new connection answers the same: a plain SELECT, SHOW, DESCRIBE or EXPLAIN with no session state.
// FOUND_ROWS and LAST_INSERT_ID read the previous statement's connection; GET_LOCK, RELEASE_LOCK, FOR UPDATE,
// LOCK IN SHARE MODE and INTO change state; a user @variable lives in the session (#1179 review). String literals
// are blanked first, so an @ inside one (an email address) is not a variable. tempTables: the TEMPORARY tables this
// run created (a new connection does not have them).
export function retryableRead(sql, tempTables = null) {
	const s = String(sql || '');
	const bare = s.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, "''");
	if (/(^|[^@\w`$])@[A-Za-z_$][\w$]*/.test(bare)) return false;
	if (tempTables && tempTables.size) for (const t of tempTables) if (new RegExp('(^|[^\\w$])`?' + t.replace(/[$]/g, '\\$') + '`?($|[^\\w$])', 'i').test(bare)) return false;
	if (!/^\s*\(?\s*(SELECT|SHOW|DESCRIBE|DESC|EXPLAIN|WITH)\b/i.test(s)) return false;
	return !/FOUND_ROWS\s*\(|LAST_INSERT_ID\s*\(|GET_LOCK\s*\(|RELEASE_LOCK\s*\(|IS_FREE_LOCK\s*\(|\bFOR\s+UPDATE\b|\bLOCK\s+IN\s+SHARE\s+MODE\b|\bFOR\s+SHARE\b|\bINTO\b/i.test(s);
}
