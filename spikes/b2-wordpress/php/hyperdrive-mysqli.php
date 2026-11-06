<?php
/**
 * A userland mysqli for approach A (issue #29). Loaded by php/hyperdrive-db.php.
 *
 * Our php-wasm build has no mysqli extension (probed 2026-11-06: extension,
 * classes and functions absent). Some plugins call mysqli_* on $wpdb->dbh
 * themselves; All-in-One WP Migration does it on every admin page, so with a
 * placeholder dbh every wp-admin request was a 500. This file gives $wpdb->dbh
 * a mysqli object and the mysqli_* functions, on the same Worker bridge as
 * Hyperdrive_WPDB (skyphusion_hd_run()): one query, one round trip, rows back
 * as strings or null, as mysqli returns them.
 *
 * Covered: connect (a no-op: the Worker holds the connection), query,
 * real_query, store_result, use_result (both buffered: the bridge returns all
 * rows), escaping, errno and error, affected rows, insert id, the result
 * fetch functions, fields (name only), data_seek, mysqli_report (default
 * ERROR|STRICT as in PHP 8.1, so a failure throws mysqli_sql_exception unless
 * the caller turned reporting off, as wpdb does).
 * Not covered: prepared statements (prepare returns false with an error),
 * multi_query, field types and lengths, async queries.
 *
 * Prior art: HostlessWP's runtime/php/hostlesswp-mysqli.php (docs/prior-art.md).
 */

// Everything is declared inside this block, so it is declared at run time and
// only when the extension is absent. A build (or a php -l) with the real
// extension uses it, and does not see a second mysqli.
if ( ! class_exists( 'mysqli', false ) ) :

define( 'SKYPHUSION_USERLAND_MYSQLI', true );

foreach ( array(
	'MYSQLI_ASSOC'                   => 1,
	'MYSQLI_NUM'                     => 2,
	'MYSQLI_BOTH'                    => 3,
	'MYSQLI_STORE_RESULT'            => 0,
	'MYSQLI_USE_RESULT'              => 1,
	'MYSQLI_STORE_RESULT_COPY_DATA'  => 16,
	'MYSQLI_REPORT_OFF'              => 0,
	'MYSQLI_REPORT_ERROR'            => 1,
	'MYSQLI_REPORT_STRICT'           => 2,
	'MYSQLI_REPORT_INDEX'            => 4,
	'MYSQLI_REPORT_ALL'              => 255,
	'MYSQLI_CLIENT_COMPRESS'         => 32,
	'MYSQLI_CLIENT_SSL'              => 2048,
	'MYSQLI_OPT_CONNECT_TIMEOUT'     => 0,
	'MYSQLI_OPT_READ_TIMEOUT'        => 11,
	'MYSQLI_INIT_COMMAND'            => 3,
	'MYSQLI_SET_CHARSET_NAME'        => 7,
	'MYSQLI_OPT_INT_AND_FLOAT_NATIVE' => 201,
) as $skyphusion_mysqli_name => $skyphusion_mysqli_value ) {
	if ( ! defined( $skyphusion_mysqli_name ) ) {
		define( $skyphusion_mysqli_name, $skyphusion_mysqli_value );
	}
}

class mysqli_sql_exception extends RuntimeException {
	protected $sqlstate = 'HY000';
	public function getSqlState() {
		return $this->sqlstate;
	}
}

/** mysqli_report() state, as in PHP 8.1: errors throw unless turned off. */
function skyphusion_mysqli_report( $flags = null ) {
	static $current = 3; // MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT
	if ( null !== $flags ) {
		$current = (int) $flags;
	}
	return $current;
}

class mysqli_result {
	public $num_rows    = 0;
	public $field_count = 0;
	public $current_field = 0;
	public $lengths     = null;
	private $rows;
	private $columns;
	private $at = 0;

	public function __construct( $columns, $rows ) {
		$this->columns     = array_values( $columns );
		$this->rows        = array_values( $rows );
		$this->num_rows    = count( $this->rows );
		$this->field_count = count( $this->columns );
	}

	private function next() {
		if ( $this->at >= $this->num_rows ) {
			$this->lengths = null;
			return null;
		}
		$row           = $this->rows[ $this->at++ ];
		$this->lengths = array_map(
			function ( $v ) {
				return null === $v ? 0 : strlen( $v );
			},
			$row
		);
		return $row;
	}

	public function fetch_row() {
		return $this->next();
	}

	public function fetch_assoc() {
		$row = $this->next();
		return null === $row ? null : array_combine( $this->columns, $row );
	}

	public function fetch_array( $mode = MYSQLI_BOTH ) {
		$row = $this->next();
		if ( null === $row ) {
			return null;
		}
		if ( MYSQLI_NUM === $mode ) {
			return $row;
		}
		$assoc = array_combine( $this->columns, $row );
		if ( MYSQLI_ASSOC === $mode ) {
			return $assoc;
		}
		$both = array();
		foreach ( $row as $i => $v ) {
			$both[ $i ]                   = $v;
			$both[ $this->columns[ $i ] ] = $v;
		}
		return $both;
	}

	public function fetch_object( $class = 'stdClass', $args = array() ) {
		$assoc = $this->fetch_assoc();
		if ( null === $assoc ) {
			return null;
		}
		$o = 'stdClass' === $class ? new stdClass() : new $class( ...$args );
		foreach ( $assoc as $k => $v ) {
			$o->$k = $v;
		}
		return $o;
	}

	public function fetch_all( $mode = MYSQLI_NUM ) {
		$out = array();
		while ( null !== ( $row = $this->fetch_array( $mode ) ) ) {
			$out[] = $row;
		}
		return $out;
	}

	private function field( $i ) {
		return (object) array(
			'name'     => $this->columns[ $i ],
			'orgname'  => $this->columns[ $i ],
			'table'    => '',
			'orgtable' => '',
			'def'      => '',
			'db'       => '',
			'catalog'  => 'def',
			'max_length' => 0,
			'length'   => 0,
			'charsetnr' => 255,
			'flags'    => 0,
			'type'     => 253, // MYSQLI_TYPE_VAR_STRING: the bridge sends no types
			'decimals' => 0,
		);
	}

	public function fetch_field() {
		if ( $this->current_field >= $this->field_count ) {
			return false;
		}
		return $this->field( $this->current_field++ );
	}

	public function fetch_fields() {
		$out = array();
		for ( $i = 0; $i < $this->field_count; $i++ ) {
			$out[] = $this->field( $i );
		}
		return $out;
	}

	public function fetch_field_direct( $i ) {
		return ( $i >= 0 && $i < $this->field_count ) ? $this->field( $i ) : false;
	}

	public function field_seek( $i ) {
		if ( $i < 0 || $i >= $this->field_count ) {
			return false;
		}
		$this->current_field = $i;
		return true;
	}

	public function data_seek( $offset ) {
		if ( $offset < 0 || $offset >= $this->num_rows ) {
			return false;
		}
		$this->at = (int) $offset;
		return true;
	}

	public function free() {
		$this->rows     = array();
		$this->num_rows = 0;
	}

	public function close() {
		$this->free();
	}

	public function free_result() {
		$this->free();
	}
}

class mysqli {
	public $errno         = 0;
	public $error         = '';
	public $sqlstate      = '00000';
	public $affected_rows = 0;
	public $insert_id     = 0;
	public $field_count   = 0;
	public $warning_count = 0;
	public $info          = '';
	public $thread_id     = 0;
	public $protocol_version = 10;
	public $host_info     = 'Hyperdrive via the Worker';
	public $client_info   = 'userland mysqli (Worker bridge)';
	public $client_version = 80000;
	public $connect_errno = 0;
	public $connect_error = null;
	private $pending      = null;
	private $server       = null;
	private $charset      = 'utf8mb4';

	public function __construct( $host = null, $user = null, $pass = null, $db = null, $port = null, $socket = null ) {}

	public function __get( $name ) {
		if ( 'server_info' === $name ) {
			return $this->get_server_info();
		}
		if ( 'server_version' === $name ) {
			$p = explode( '.', preg_replace( '/[^0-9.].*$/', '', $this->get_server_info() ) );
			return (int) $p[0] * 10000 + (int) ( $p[1] ?? 0 ) * 100 + (int) ( $p[2] ?? 0 );
		}
		return null;
	}

	public function real_connect( $host = null, $user = null, $pass = null, $db = null, $port = null, $socket = null, $flags = 0 ) {
		return true; // The Worker holds the connection (Hyperdrive).
	}

	private function fail( $error, $errno ) {
		$this->error         = (string) $error;
		$this->errno         = $errno ? (int) $errno : 2000;
		$this->sqlstate      = 'HY000';
		$this->affected_rows = -1;
		$this->pending       = null;
		$this->field_count   = 0;
		if ( skyphusion_mysqli_report() & MYSQLI_REPORT_STRICT ) {
			throw new mysqli_sql_exception( $this->error, $this->errno );
		}
		return false;
	}

	public function real_query( $sql ) {
		$this->pending = null;
		$reply         = skyphusion_hd_run( (string) $sql );
		if ( empty( $reply['ok'] ) ) {
			return $this->fail( isset( $reply['error'] ) ? $reply['error'] : 'no reply from the Worker', isset( $reply['errno'] ) ? $reply['errno'] : 2006 );
		}
		$this->errno    = 0;
		$this->error    = '';
		$this->sqlstate = '00000';
		if ( isset( $reply['columns'] ) ) {
			$rows = array();
			foreach ( isset( $reply['rows'] ) ? $reply['rows'] : array() as $values ) {
				foreach ( $values as $i => $v ) {
					if ( is_array( $v ) && isset( $v['$b'] ) ) {
						$values[ $i ] = base64_decode( $v['$b'] );
					}
				}
				$rows[] = $values;
			}
			$this->pending       = array( $reply['columns'], $rows );
			$this->field_count   = count( $reply['columns'] );
			$this->affected_rows = count( $rows );
		} else {
			$this->field_count   = 0;
			$this->affected_rows = isset( $reply['affected'] ) ? (int) $reply['affected'] : 0;
			if ( ! empty( $reply['insert_id'] ) ) {
				$this->insert_id = (int) $reply['insert_id'];
			}
		}
		return true;
	}

	public function store_result( $mode = 0 ) {
		if ( null === $this->pending ) {
			return false; // No result set (not an error: errno stays 0).
		}
		list( $columns, $rows ) = $this->pending;
		$this->pending          = null;
		return new mysqli_result( $columns, $rows );
	}

	public function use_result() {
		return $this->store_result();
	}

	public function query( $sql, $mode = MYSQLI_STORE_RESULT ) {
		if ( ! $this->real_query( $sql ) ) {
			return false;
		}
		$r = $this->store_result();
		return false === $r ? true : $r;
	}

	public function multi_query( $sql ) {
		return $this->fail( 'multi_query is not supported by the Worker bridge', 2000 );
	}

	public function more_results() {
		return false;
	}

	public function next_result() {
		return false;
	}

	public function prepare( $sql ) {
		return $this->fail( 'prepared statements are not supported by the Worker bridge', 2000 );
	}

	public function real_escape_string( $s ) {
		return skyphusion_mysql_escape( $s );
	}

	public function escape_string( $s ) {
		return skyphusion_mysql_escape( $s );
	}

	public function set_charset( $charset ) {
		$this->charset = (string) $charset;
		return true; // The database is utf8mb4; Hyperdrive resets the session per statement.
	}

	public function character_set_name() {
		return $this->charset;
	}

	public function select_db( $db ) {
		if ( defined( 'DB_NAME' ) && (string) $db !== DB_NAME ) {
			return $this->fail( 'the Hyperdrive binding is bound to one database', 1049 );
		}
		return true;
	}

	public function get_server_info() {
		if ( null === $this->server ) {
			$reply        = skyphusion_hd_run( 'SELECT VERSION()' );
			$this->server = ( ! empty( $reply['ok'] ) && isset( $reply['rows'][0][0] ) ) ? (string) $reply['rows'][0][0] : '8.0.0';
		}
		return $this->server;
	}

	public function ping() {
		return true;
	}

	public function options( $option, $value ) {
		return true;
	}

	public function ssl_set( $key, $cert, $ca, $capath, $cipher ) {
		return true;
	}

	public function autocommit( $on ) {
		return $this->real_query( $on ? 'SET autocommit = 1' : 'SET autocommit = 0' );
	}

	public function begin_transaction( $flags = 0, $name = null ) {
		return $this->real_query( 'START TRANSACTION' );
	}

	public function commit( $flags = 0, $name = null ) {
		return $this->real_query( 'COMMIT' );
	}

	public function rollback( $flags = 0, $name = null ) {
		return $this->real_query( 'ROLLBACK' );
	}

	public function stat() {
		return 'Hyperdrive via the Worker';
	}

	public function close() {
		return true;
	}
}

function mysqli_report( $flags ) { skyphusion_mysqli_report( $flags ); return true; }
function mysqli_init() { return new mysqli(); }
function mysqli_connect( $host = null, $user = null, $pass = null, $db = null, $port = null, $socket = null ) { return new mysqli(); }
function mysqli_real_connect( $m, $host = null, $user = null, $pass = null, $db = null, $port = null, $socket = null, $flags = 0 ) { return $m->real_connect(); }
function mysqli_connect_errno() { return 0; }
function mysqli_connect_error() { return null; }
function mysqli_query( $m, $sql, $mode = MYSQLI_STORE_RESULT ) { return $m->query( $sql, $mode ); }
function mysqli_real_query( $m, $sql ) { return $m->real_query( $sql ); }
function mysqli_multi_query( $m, $sql ) { return $m->multi_query( $sql ); }
function mysqli_store_result( $m, $mode = 0 ) { return $m->store_result( $mode ); }
function mysqli_use_result( $m ) { return $m->use_result(); }
function mysqli_more_results( $m ) { return $m->more_results(); }
function mysqli_next_result( $m ) { return $m->next_result(); }
function mysqli_prepare( $m, $sql ) { return $m->prepare( $sql ); }
function mysqli_errno( $m ) { return $m->errno; }
function mysqli_error( $m ) { return $m->error; }
function mysqli_sqlstate( $m ) { return $m->sqlstate; }
function mysqli_affected_rows( $m ) { return $m->affected_rows; }
function mysqli_insert_id( $m ) { return $m->insert_id; }
function mysqli_field_count( $m ) { return $m->field_count; }
function mysqli_warning_count( $m ) { return $m->warning_count; }
function mysqli_info( $m ) { return $m->info; }
function mysqli_real_escape_string( $m, $s ) { return $m->real_escape_string( $s ); }
function mysqli_escape_string( $m, $s ) { return $m->real_escape_string( $s ); }
function mysqli_set_charset( $m, $charset ) { return $m->set_charset( $charset ); }
function mysqli_character_set_name( $m ) { return $m->character_set_name(); }
function mysqli_select_db( $m, $db ) { return $m->select_db( $db ); }
function mysqli_ping( $m ) { return $m->ping(); }
function mysqli_close( $m ) { return $m->close(); }
function mysqli_options( $m, $option, $value ) { return $m->options( $option, $value ); }
function mysqli_ssl_set( $m, $key, $cert, $ca, $capath, $cipher ) { return $m->ssl_set( $key, $cert, $ca, $capath, $cipher ); }
function mysqli_autocommit( $m, $on ) { return $m->autocommit( $on ); }
function mysqli_begin_transaction( $m, $flags = 0, $name = null ) { return $m->begin_transaction( $flags, $name ); }
function mysqli_commit( $m, $flags = 0, $name = null ) { return $m->commit( $flags, $name ); }
function mysqli_rollback( $m, $flags = 0, $name = null ) { return $m->rollback( $flags, $name ); }
function mysqli_get_server_info( $m ) { return $m->get_server_info(); }
function mysqli_get_server_version( $m ) { return $m->server_version; }
function mysqli_get_client_info( $m = null ) { return 'userland mysqli (Worker bridge)'; }
function mysqli_get_client_version() { return 80000; }
function mysqli_get_host_info( $m ) { return $m->host_info; }
function mysqli_get_proto_info( $m ) { return $m->protocol_version; }
function mysqli_thread_id( $m ) { return $m->thread_id; }
function mysqli_stat( $m ) { return $m->stat(); }
function mysqli_num_rows( $r ) { return $r->num_rows; }
function mysqli_num_fields( $r ) { return $r->field_count; }
function mysqli_fetch_row( $r ) { return $r->fetch_row(); }
function mysqli_fetch_assoc( $r ) { return $r->fetch_assoc(); }
function mysqli_fetch_array( $r, $mode = MYSQLI_BOTH ) { return $r->fetch_array( $mode ); }
function mysqli_fetch_object( $r, $class = 'stdClass', $args = array() ) { return $r->fetch_object( $class, $args ); }
function mysqli_fetch_all( $r, $mode = MYSQLI_NUM ) { return $r->fetch_all( $mode ); }
function mysqli_fetch_field( $r ) { return $r->fetch_field(); }
function mysqli_fetch_fields( $r ) { return $r->fetch_fields(); }
function mysqli_fetch_field_direct( $r, $i ) { return $r->fetch_field_direct( $i ); }
function mysqli_fetch_lengths( $r ) { return $r->lengths; }
function mysqli_field_seek( $r, $i ) { return $r->field_seek( $i ); }
function mysqli_data_seek( $r, $offset ) { return $r->data_seek( $offset ); }
function mysqli_free_result( $r ) { if ( $r instanceof mysqli_result ) { $r->free(); } }

endif;
