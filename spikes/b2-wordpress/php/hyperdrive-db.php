<?php
/**
 * wp-content/db.php for approach A: WordPress on MySQL through Hyperdrive.
 *
 * PHP in WebAssembly has no sockets in a Worker, so PHP cannot open a MySQL
 * connection. Each query goes to the Worker (post_message_to_js), which runs
 * it with mysql2 on the Hyperdrive binding and sends back the rows. The SQL
 * is WordPress's own MySQL; nothing is translated (approach B translates to
 * SQLite for D1). Values come back as strings, as mysqli returns them.
 *
 * Prior art: HostlessWP replaces wpdb the same way (docs/prior-art.md).
 *
 * A strict server (PlanetScale): with HYPERDRIVE_SQL_MODE set, every statement
 * carries WordPress's relaxed sql_mode itself (hyperdrive-sql-mode.php), because
 * Hyperdrive does not keep a SET between statements.
 */

require_once __DIR__ . '/hyperdrive-sql-mode.php';
// The escape, and SQL that is not UTF-8 as hex literals for the bridge (issue #79).
require_once __DIR__ . '/hyperdrive-literals.php';
// A mysqli for plugins that call mysqli_* on $wpdb->dbh (issue #29).
require_once __DIR__ . '/hyperdrive-mysqli.php';

// The R2 Uploads and Edge Cache mu-plugins send their messages through this
// function. Approach B defines it in d1-pdo.php, which A does not load: without
// it R2 uploads stayed off and files were kept in one isolate's memory
// (measured 2026-11-05 with tests/break.py: an upload answered 201, then 404).
if ( ! function_exists( 'skyphusion_worker_call' ) ) {
	function skyphusion_worker_call( $json ) {
		return post_message_to_js( $json );
	}
}

/** One statement on the Worker bridge: {ok, columns, rows} or {ok, affected, insert_id} or {ok: false, error, errno}. */
function skyphusion_hd_call( $sql ) {
	// The bridge carries JSON text: string literals that are not UTF-8 go as hex literals (issue #79).
	$text = skyphusion_hd_sql_for_bridge( $sql );
	if ( null === $text ) {
		return array(
			'ok'    => false,
			'error' => 'SQL has bytes that are not UTF-8 outside a string literal; the Worker bridge cannot carry it',
			'errno' => 2000,
		);
	}
	$reply = json_decode( skyphusion_worker_call( json_encode( array( 'mysql' => $text ) ) ), true );
	return is_array( $reply ) ? $reply : array(
		'ok'    => false,
		'error' => 'no reply from the Worker',
	);
}

/**
 * DDL in WordPress's relaxed sql_mode: SET inside a transaction holds for the
 * DDL (tests/a2/probe E2), where a hint cannot go. Three extra round trips;
 * DDL is rare (install, plugin activation, upgrades). The DDL's own reply is
 * returned. COMMIT is sent whenever BEGIN ran.
 */
function skyphusion_hd_ddl( $query, $mode ) {
	$begin = skyphusion_hd_call( 'BEGIN' );
	if ( ! empty( $begin['ok'] ) ) {
		skyphusion_hd_call( "SET SESSION sql_mode = '" . $mode . "'" );
	}
	$reply = skyphusion_hd_call( $query );
	if ( ! empty( $begin['ok'] ) ) {
		skyphusion_hd_call( 'COMMIT' );
	}
	return $reply;
}

/** A statement as wpdb runs it: with WordPress's sql_mode on a strict server (HYPERDRIVE_SQL_MODE). Also used by mysqli. */
function skyphusion_hd_run( $query ) {
	$mode = skyphusion_hd_sql_mode();
	if ( null === $mode ) {
		return skyphusion_hd_call( $query );
	}
	if ( skyphusion_hd_is_ddl( $query ) ) {
		return skyphusion_hd_ddl( $query, $mode );
	}
	return skyphusion_hd_call( skyphusion_hd_hint( $query, $mode ) );
}

class Hyperdrive_WPDB extends wpdb {
	private $hd_version = null;
	private $hd_columns = array();
	// #498: session state Hyperdrive does not keep between statements. It pools to the origin in
	// transaction mode and resets the session after each statement (tests/a2 probe E1), so a
	// SELECT FOUND_ROWS() or SELECT LAST_INSERT_ID() sent on its own can run on another origin
	// connection and read its state (X-WP-Total 0 in 4 of 16 reads on wp-a-lean). The pair is kept
	// on one connection instead, and the second statement is answered from what the first produced.
	/** @var int|null FOUND_ROWS() of the SQL_CALC_FOUND_ROWS query just run, read on its own connection. */
	private $hd_found_rows = null;
	/** @var int|null The insert id of the write just run (its OK packet): LAST_INSERT_ID() right after it. */
	private $hd_last_insert = null;
	/** @var string|null What the previous statement was: 'calc', 'write' or null. */
	private $hd_prev = null;
	/** @var bool A transaction WordPress or a plugin opened (START TRANSACTION / BEGIN) is open. */
	private $hd_in_tx = false;

	public function db_connect( $allow_bail = true ) {
		// As wpdb::db_connect() does: failed queries return false, not an exception.
		// Plugins that call mysqli_* on $wpdb->dbh expect that.
		if ( function_exists( 'mysqli_report' ) ) {
			mysqli_report( MYSQLI_REPORT_OFF );
		}
		// A mysqli object on the bridge (hyperdrive-mysqli.php), so a plugin can
		// call mysqli_* on $wpdb->dbh. Without the userland one: a placeholder.
		$this->dbh           = defined( 'SKYPHUSION_USERLAND_MYSQLI' ) ? new mysqli() : 'hyperdrive';
		$this->has_connected = true;
		$this->ready         = true;
		$this->set_charset( $this->dbh );
		return true;
	}

	public function check_connection( $allow_bail = true ) {
		return true;
	}

	public function select( $db, $dbh = null ) {}

	// Hyperdrive pools connections and resets the session after each statement
	// (measured, tests/a2/probe E1), so a session setting (SET NAMES, sql_mode)
	// does not hold. The database is created utf8mb4. For sql_mode on a strict
	// server, see HYPERDRIVE_SQL_MODE (query() and hyperdrive-sql-mode.php).
	public function set_charset( $dbh, $charset = null, $collate = null ) {}

	public function set_sql_mode( $modes = array() ) {}

	public function close() {
		return true;
	}

	/** The escaping of mysqli_real_escape_string() for utf8mb4. */
	public function _real_escape( $data ) {
		if ( ! is_scalar( $data ) ) {
			return '';
		}
		return $this->add_placeholder_escape( skyphusion_mysql_escape( $data ) );
	}

	/**
	 * #498: a SELECT SQL_CALC_FOUND_ROWS and its FOUND_ROWS() on ONE origin connection. A transaction pins
	 * the connection in Hyperdrive (the DDL path relies on the same, tests/a2 probe E2). Inside a transaction
	 * already open (a plugin's START TRANSACTION), no BEGIN is sent: a second BEGIN would COMMIT theirs.
	 */
	private function hd_calc_found_rows( $query ) {
		$own = ! $this->hd_in_tx;
		if ( $own ) {
			$begin = skyphusion_hd_call( 'BEGIN' );
			$own   = ! empty( $begin['ok'] );
		}
		$reply = skyphusion_hd_run( $query );
		$found = null;
		if ( ! empty( $reply['ok'] ) && ( $own || $this->hd_in_tx ) ) {
			$f = skyphusion_hd_call( 'SELECT FOUND_ROWS()' );
			if ( ! empty( $f['ok'] ) && isset( $f['rows'][0][0] ) ) {
				$v     = $f['rows'][0][0];
				$v     = ( is_array( $v ) && isset( $v['$b'] ) ) ? base64_decode( $v['$b'] ) : $v;
				$found = is_numeric( $v ) ? (int) $v : null;
			}
		}
		if ( $own ) {
			skyphusion_hd_call( 'COMMIT' );
		}
		$this->hd_found_rows = $found;
		return $reply;
	}

	public function db_server_info() {
		if ( null === $this->hd_version ) {
			$reply            = skyphusion_hd_call( 'SELECT VERSION()' );
			$this->hd_version = ( ! empty( $reply['ok'] ) && isset( $reply['rows'][0][0] ) ) ? $reply['rows'][0][0] : '8.0.0';
		}
		return $this->hd_version;
	}

	public function query( $query ) {
		if ( ! $this->ready ) {
			return false;
		}
		$query = apply_filters( 'query', $query );
		if ( ! $query ) {
			$this->insert_id = 0;
			return false;
		}
		$this->flush();
		$this->func_call  = "\$db->query(\"$query\")";
		$this->last_query = $query;
		if ( defined( 'SAVEQUERIES' ) && SAVEQUERIES ) {
			$this->timer_start();
		}
		// #498: keep session state that spans two statements on one connection (see hd_calc_found_rows).
		$q    = ltrim( $query );
		$prev = $this->hd_prev;
		$this->hd_prev = null;
		if ( preg_match( '/^(START\s+TRANSACTION|BEGIN)\b/i', $q ) ) {
			$this->hd_in_tx = true;
		} elseif ( preg_match( '/^(COMMIT|ROLLBACK)\b/i', $q ) && ! preg_match( '/^ROLLBACK\s+TO\b/i', $q ) ) {
			$this->hd_in_tx = false;
		}
		if ( 'calc' === $prev && null !== $this->hd_found_rows && preg_match( '/^SELECT\s+FOUND_ROWS\(\s*\)\s*;?\s*$/i', $q ) ) {
			$reply = array( 'ok' => true, 'columns' => array( 'FOUND_ROWS()' ), 'rows' => array( array( (string) $this->hd_found_rows ) ) );
		} elseif ( 'write' === $prev && null !== $this->hd_last_insert && preg_match( '/^SELECT\s+LAST_INSERT_ID\(\s*\)\s*;?\s*$/i', $q ) ) {
			$reply = array( 'ok' => true, 'columns' => array( 'LAST_INSERT_ID()' ), 'rows' => array( array( (string) $this->hd_last_insert ) ) );
		} elseif ( preg_match( '/^SELECT\s+SQL_CALC_FOUND_ROWS\b/i', $q ) ) {
			$reply = $this->hd_calc_found_rows( $query );
			$this->hd_prev = empty( $reply['ok'] ) ? null : 'calc';
		} else {
			$reply = skyphusion_hd_run( $query );
			if ( ! empty( $reply['ok'] ) && preg_match( '/^(INSERT|REPLACE|UPDATE)\b/i', $q ) ) {
				// The OK packet's insert id: LAST_INSERT_ID() right after this write, LAST_INSERT_ID(expr) included.
				$this->hd_last_insert = isset( $reply['insert_id'] ) ? (int) $reply['insert_id'] : null;
				$this->hd_prev        = null === $this->hd_last_insert ? null : 'write';
			}
		}
		++$this->num_queries;
		if ( defined( 'SAVEQUERIES' ) && SAVEQUERIES ) {
			$this->log_query( $query, $this->timer_stop(), $this->get_caller(), $this->time_start, array() );
		}
		if ( empty( $reply['ok'] ) ) {
			$this->last_error = isset( $reply['error'] ) ? $reply['error'] : 'unknown error';
			if ( $this->insert_id && preg_match( '/^\s*(insert|replace)\s/i', $query ) ) {
				$this->insert_id = 0;
			}
			// print_error() with no argument calls mysqli_error(), which needs a real mysqli link.
			$this->print_error( $this->last_error );
			return false;
		}
		$this->last_error = '';
		if ( preg_match( '/^\s*(create|alter|truncate|drop)\s/i', $query ) ) {
			$this->result = true;
			return true;
		}
		if ( preg_match( '/^\s*(insert|delete|update|replace)\s/i', $query ) ) {
			$this->rows_affected = (int) $reply['affected'];
			if ( preg_match( '/^\s*(insert|replace)\s/i', $query ) ) {
				$this->insert_id = (int) $reply['insert_id'];
			}
			return $this->rows_affected;
		}
		$columns          = isset( $reply['columns'] ) ? $reply['columns'] : array();
		$this->hd_columns = $columns;
		$num_rows         = 0;
		foreach ( isset( $reply['rows'] ) ? $reply['rows'] : array() as $values ) {
			$row = new stdClass();
			foreach ( $columns as $i => $name ) {
				$v = $values[ $i ];
				if ( is_array( $v ) && isset( $v['$b'] ) ) {
					$v = base64_decode( $v['$b'] );
				}
				$row->$name = $v;
			}
			$this->last_result[ $num_rows ] = $row;
			++$num_rows;
		}
		$this->num_rows = $num_rows;
		return $num_rows;
	}

	protected function load_col_info() {
		if ( $this->col_info ) {
			return;
		}
		$this->col_info = array();
		foreach ( $this->hd_columns as $i => $name ) {
			$this->col_info[ $i ] = (object) array(
				'name'  => $name,
				'table' => '',
			);
		}
	}
}

$wpdb = new Hyperdrive_WPDB( DB_USER, DB_PASSWORD, DB_NAME, DB_HOST );
