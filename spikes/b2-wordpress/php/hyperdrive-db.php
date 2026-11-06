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

// The R2 Uploads and Edge Cache mu-plugins send their messages through this
// function. Approach B defines it in d1-pdo.php, which A does not load: without
// it R2 uploads stayed off and files were kept in one isolate's memory
// (measured 2026-11-05 with tests/break.py: an upload answered 201, then 404).
if ( ! function_exists( 'skyphusion_worker_call' ) ) {
	function skyphusion_worker_call( $json ) {
		return post_message_to_js( $json );
	}
}

class Hyperdrive_WPDB extends wpdb {
	private $hd_version = null;
	private $hd_columns = array();

	public function db_connect( $allow_bail = true ) {
		$this->dbh           = 'hyperdrive';
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
		$escaped = strtr(
			(string) $data,
			array(
				'\\'   => '\\\\',
				"\0"   => '\\0',
				"\n"   => '\\n',
				"\r"   => '\\r',
				"'"    => "\\'",
				'"'    => '\\"',
				"\x1a" => '\\Z',
			)
		);
		return $this->add_placeholder_escape( $escaped );
	}

	public function db_server_info() {
		if ( null === $this->hd_version ) {
			$reply            = $this->hd_call( 'SELECT VERSION()' );
			$this->hd_version = ( ! empty( $reply['ok'] ) && isset( $reply['rows'][0][0] ) ) ? $reply['rows'][0][0] : '8.0.0';
		}
		return $this->hd_version;
	}

	private function hd_call( $sql ) {
		$msg   = preg_match( '//u', $sql ) ? array( 'mysql' => $sql ) : array( 'mysql_b64' => base64_encode( $sql ) );
		$reply = json_decode( skyphusion_worker_call( json_encode( $msg ) ), true );
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
	private function hd_ddl( $query, $mode ) {
		$begin = $this->hd_call( 'BEGIN' );
		if ( ! empty( $begin['ok'] ) ) {
			$this->hd_call( "SET SESSION sql_mode = '" . $mode . "'" );
		}
		$reply = $this->hd_call( $query );
		if ( ! empty( $begin['ok'] ) ) {
			$this->hd_call( 'COMMIT' );
		}
		return $reply;
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
		$mode = skyphusion_hd_sql_mode();
		if ( null === $mode ) {
			$reply = $this->hd_call( $query );
		} elseif ( skyphusion_hd_is_ddl( $query ) ) {
			$reply = $this->hd_ddl( $query, $mode );
		} else {
			$reply = $this->hd_call( skyphusion_hd_hint( $query, $mode ) );
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
