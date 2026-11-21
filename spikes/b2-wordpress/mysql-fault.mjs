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
// #1179 CodeQL: the SQL's identifier tokens, lowercased: backtick-quoted (any characters, `` as one backtick) or bare
// ([A-Za-z0-9_$]+); string literals are skipped. Names are compared as tokens, never built into a RegExp.
export function sqlIdentifiers(sql) {
	const out = [];
	const re = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`((?:[^`]|``)*)`|([A-Za-z0-9_$]+)/g;
	let m;
	while ((m = re.exec(String(sql || '')))) {
		if (m[1] !== undefined) out.push(m[1].replace(/``/g, '`').toLowerCase());
		else if (m[2] !== undefined) out.push(m[2].toLowerCase());
	}
	return out;
}

// The table a CREATE TEMPORARY TABLE names, lowercased (backtick-quoted or bare), or null.
export function tempTableName(sql) {
	const m = /^\s*CREATE\s+TEMPORARY\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:`((?:[^`]|``)+)`|([A-Za-z0-9_$]+))/i.exec(String(sql || ''));
	if (!m) return null;
	return (m[1] !== undefined ? m[1].replace(/``/g, '`') : m[2]).toLowerCase();
}

export function retryableRead(sql, tempTables = null) {
	const s = String(sql || '');
	const bare = s.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, "''");
	if (/(^|[^@\w`$])@[A-Za-z_$][\w$]*/.test(bare)) return false;
	if (tempTables && tempTables.size && sqlIdentifiers(s).some((id) => tempTables.has(id))) return false;
	if (!/^\s*\(?\s*(SELECT|SHOW|DESCRIBE|DESC|EXPLAIN|WITH)\b/i.test(s)) return false;
	return !/FOUND_ROWS\s*\(|LAST_INSERT_ID\s*\(|GET_LOCK\s*\(|RELEASE_LOCK\s*\(|IS_FREE_LOCK\s*\(|\bFOR\s+UPDATE\b|\bLOCK\s+IN\s+SHARE\s+MODE\b|\bFOR\s+SHARE\b|\bINTO\b/i.test(s);
}
