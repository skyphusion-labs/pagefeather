<?php
/**
 * The database size in SHOW TABLE STATUS on b-dosql (#780).
 *
 * WordPress's Site Health sizes (WP_Debug_Data::get_database_size(), behind GET /wp-site-health/v1/directory-sizes)
 * sum Data_length + Index_length over SHOW TABLE STATUS. The SQLite integration answers that from its emulated
 * information schema, where every size is 0, so Site Health has no database size, makes no total, and the endpoint
 * answers 500 not_available. The database is the PHP object's Durable Object SQLite, which reports only its WHOLE
 * size (sql.databaseSize; it has no dbstat table and refuses PRAGMA page_count, measured on #780). So the Worker
 * answers {"dbSize":1} with that size, and this puts it on the FIRST row's Data_length; every other size stays 0.
 * The sum over the rows, which is all Site Health reads, is then the real database size. Per-table sizes are not
 * available on Durable Object SQLite, and every row but the first says 0 (documented, not a measurement of it).
 * Any reply without a positive size leaves the rows as they are (D1, or no database in the object).
 *
 * Only an UNFILTERED SHOW TABLE STATUS (optionally FROM or IN a database) gets the size. A filtered one (LIKE or
 * WHERE) names some tables, and the whole database's size is not theirs: it says 0 (unknown) for every row and asks
 * the Worker nothing (the lead's review of #780).
 */
if ( ! function_exists( 'skyphusion_table_status_size' ) ) {
	/**
	 * @param string   $query The MySQL query wpdb ran.
	 * @param array    $rows  Its result rows (objects), as wpdb's last_result holds them.
	 * @param callable $call  One message to the Worker, one JSON reply (skyphusion_worker_call).
	 * @return array The rows, with the database size on the first row when the query is SHOW TABLE STATUS.
	 */
	function skyphusion_table_status_size( $query, $rows, $call ) {
		if ( ! is_string( $query ) || ! preg_match( '/^\s*SHOW\s+TABLE\s+STATUS(\s|$)/i', $query ) || empty( $rows ) || ! is_array( $rows ) ) {
			return $rows;
		}
		$zero = function ( $rows ) {
			foreach ( $rows as $row ) {
				if ( is_object( $row ) ) {
					$row->Data_length  = '0';
					$row->Index_length = '0';
				}
			}
			return $rows;
		};
		if ( ! preg_match( '/^\s*SHOW\s+TABLE\s+STATUS(\s+(FROM|IN)\s+[`"]?[\w$]+[`"]?)?\s*;?\s*$/i', $query ) ) {
			return $zero( $rows ); // filtered: per-table sizes are not available
		}
		$reply = json_decode( (string) call_user_func( $call, '{"dbSize":1}' ), true );
		$bytes = is_array( $reply ) && ! empty( $reply['ok'] ) && isset( $reply['bytes'] ) ? (int) $reply['bytes'] : 0;
		if ( $bytes <= 0 ) {
			return $rows;
		}
		foreach ( $rows as $i => $row ) {
			if ( is_object( $row ) ) {
				$row->Data_length  = 0 === $i ? (string) $bytes : '0';
				$row->Index_length = '0';
			}
		}
		return $rows;
	}
}
