<?php
/**
 * D1_PDO: a PDO stand-in that sends SQLite statements to Cloudflare D1.
 *
 * The SQLite driver (sqlite-database-integration) takes a PDO instance through
 * the `sqlite_pdo` option. This class is that instance. Each statement goes to
 * the Worker through post_message_to_js(); the Worker runs it on the D1 binding
 * and the JSPI build pauses PHP until D1 answers.
 *
 * Limits, on purpose:
 * - D1 has no SQL transactions. BEGIN, COMMIT, SAVEPOINT and RELEASE are
 *   accepted and not sent. A ROLLBACK cannot undo anything; it is counted.
 * - D1 cannot run PHP functions. createFunction() records the name only. A
 *   statement that calls one fails on D1 and is recorded.
 */

/**
 * One message to the Worker, one JSON reply.
 *
 * In the Worker, PHP calls JavaScript directly (post_message_to_js). In the
 * checkout Container, PHP posts to http://worker.internal/, which a Container
 * outbound handler answers with the same message handler, inside the Workers
 * runtime on the same machine. The bindings (D1, R2, Images) stay in the Worker.
 */
if ( ! function_exists( 'skyphusion_worker_call' ) ) {
	function skyphusion_worker_call( $json ) {
		if ( function_exists( 'post_message_to_js' ) ) {
			return post_message_to_js( $json );
		}
		static $ch = null;
		if ( null === $ch ) {
			$ch = curl_init( 'http://worker.internal/' );
			curl_setopt_array(
				$ch,
				array(
					CURLOPT_POST           => true,
					CURLOPT_RETURNTRANSFER => true,
					CURLOPT_HTTPHEADER     => array( 'Content-Type: application/json' ),
					CURLOPT_TIMEOUT        => 60,
				)
			);
		}
		curl_setopt( $ch, CURLOPT_POSTFIELDS, $json );
		$reply = curl_exec( $ch );
		return false === $reply ? '' : $reply;
	}
}

class D1_PDO extends PDO {
	/** @var array<string,mixed> */
	private $attributes = array(
		PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
		PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_BOTH,
		PDO::ATTR_STRINGIFY_FETCHES  => false,
	);

	/** @var bool */
	private $in_transaction = false;

	/** @var string */
	public $last_insert_id = '0';

	/** @var array<string> Names passed to createFunction(). */
	public static $functions = array();

	/** @var array<array{sql:string,error:string}> Statements D1 rejected. */
	public static $failures = array();

	/** @var int */
	public static $calls = 0;

	/** @var int Reads answered from the request cache. */
	public static $cache_hits = 0;

	/** @var int */
	public static $rollbacks = 0;

	/**
	 * D1 refuses sqlite_version() ("not authorized to use function"), so the
	 * driver's version check gets this fixed answer. D1 supports STRICT tables,
	 * which is what the driver's minimum version guards.
	 */
	const SQLITE_VERSION = '3.45.0';

	public function __construct() {
		// No parent::__construct(): there is no local database file.
	}

	/**
	 * Send one statement to D1.
	 *
	 * @param string $sql
	 * @param array  $params Positional parameters.
	 * @return array{columns:array<string>,rows:array<array>,changes:int,last_row_id:int}
	 */
	/**
	 * Reads of the driver's schema tables (_wp_sqlite_mysql_information_schema_*),
	 * cached for the request. Each D1 call is a network round trip (measured
	 * 2026-11-04: about 48 ms from the checkout Container), and the driver looks
	 * up the columns of a table before many statements (about 150 of 750 calls in
	 * a checkout). They change only with the schema: DDL or a write to those
	 * tables clears the cache.
	 *
	 * Ordinary reads are NOT cached. A general read cache made a request that
	 * waits for another request's write (a lock) loop forever in the Container,
	 * which runs requests in parallel (measured 2026-11-04).
	 */
	private static $schema_cache = array();

	public function d1( $sql, array $params = array() ) {
		$is_select = 1 === preg_match( '/^\s*SELECT\b/i', $sql );
		$schema    = false !== stripos( $sql, '_wp_sqlite_mysql_information_schema_' );
		$cacheable = $is_select && 0 === preg_match( '/random\(|\'now\'|current_(timestamp|date|time)|last_insert_rowid|changes\(/i', $sql );
		$key       = $sql . "\0" . json_encode( $params );
		if ( $cacheable && $schema && isset( self::$schema_cache[ $key ] ) ) {
			++self::$cache_hits;
			return self::$schema_cache[ $key ];
		}
		if ( ! $is_select && ( $schema || preg_match( '/^\s*(CREATE|ALTER|DROP|RENAME)\b/i', $sql ) ) ) {
			self::$schema_cache = array();
		}
		++self::$calls;
		$reply = json_decode(
			skyphusion_worker_call( json_encode( array( 'sql' => $sql, 'params' => $params ) ) ),
			true
		);
		if ( ! is_array( $reply ) || empty( $reply['ok'] ) ) {
			$error            = is_array( $reply ) && isset( $reply['error'] ) ? $reply['error'] : 'no reply from the Worker';
			self::$failures[] = array( 'sql' => $sql, 'error' => $error );
			throw new PDOException( 'D1: ' . $error );
		}
		if ( ! empty( $reply['last_row_id'] ) ) {
			$this->last_insert_id = (string) $reply['last_row_id'];
		}
		if ( $cacheable && $schema && count( $reply['rows'] ) <= 500 && count( self::$schema_cache ) < 2000 ) {
			self::$schema_cache[ $key ] = $reply;
		}
		return $reply;
	}

	/**
	 * Answer a statement locally when D1 must not or cannot see it.
	 *
	 * @param string $sql
	 * @return array|null A reply in d1() form, or null to send the statement.
	 */
	public function local_reply( $sql ) {
		$s = strtoupper( ltrim( $sql ) );
		// The driver checks for a TEMPORARY table before many statements. D1 has
		// no temporary tables (each statement may run on another connection), so
		// the answer is always no. About 145 of 750 calls in a checkout.
		if ( preg_match( '/^SELECT\s+1\s+FROM\s+SQLITE_TEMP_MASTER\b/', $s ) ) {
			return array( 'columns' => array( '1' ), 'rows' => array(), 'changes' => 0, 'last_row_id' => 0 );
		}
		if ( preg_match( '/^(BEGIN|COMMIT|END|SAVEPOINT|RELEASE)\b/', $s ) ) {
			$this->in_transaction = 0 === strpos( $s, 'BEGIN' ) || 0 === strpos( $s, 'SAVEPOINT' ) ? true : ( 0 === strpos( $s, 'RELEASE' ) ? $this->in_transaction : false );
			return array( 'columns' => array(), 'rows' => array(), 'changes' => 0, 'last_row_id' => 0 );
		}
		if ( 0 === strpos( $s, 'ROLLBACK' ) ) {
			++self::$rollbacks;
			if ( false === strpos( $s, ' TO ' ) ) {
				$this->in_transaction = false;
			}
			return array( 'columns' => array(), 'rows' => array(), 'changes' => 0, 'last_row_id' => 0 );
		}
		// D1 keeps its own tables (_cf_*) in the schema and refuses access to them.
		// The driver makes an empty result with an unknown pragma; D1 refuses it.
		if ( 0 === strpos( $s, 'PRAGMA' ) && ( false !== strpos( $s, '_CF_' ) || false !== strpos( $s, '_WP_SQLITE_' ) ) ) {
			return array( 'columns' => array(), 'rows' => array(), 'changes' => 0, 'last_row_id' => 0 );
		}
		if ( preg_match( '/^SELECT\s+SQLITE_VERSION\s*\(\s*\)\s*;?\s*$/', $s ) ) {
			return array( 'columns' => array( 'sqlite_version()' ), 'rows' => array( array( self::SQLITE_VERSION ) ), 'changes' => 0, 'last_row_id' => 0 );
		}
		if ( preg_match( '/^PRAGMA\s+(BUSY_TIMEOUT|JOURNAL_MODE|SYNCHRONOUS)\s*(=\s*(\S+))?/', $s, $m ) ) {
			$value = isset( $m[3] ) ? strtolower( trim( $m[3], "'\"; " ) ) : 'wal';
			return array( 'columns' => array( strtolower( $m[1] ) ), 'rows' => array( array( $value ) ), 'changes' => 0, 'last_row_id' => 0 );
		}
		return null;
	}

	/** Tell the Worker about a statement that never reached D1. */
	public function report_failure( $sql, $error ) {
		skyphusion_worker_call( json_encode( array( 'report' => true, 'sql' => $sql, 'error' => $error ) ) );
	}

	public function prepare( string $query, array $options = array() ): PDOStatement|false {
		return new D1_PDOStatement( $this, $query, $this->attributes[ PDO::ATTR_DEFAULT_FETCH_MODE ] );
	}

	public function query( string $query, ?int $fetchMode = null, mixed ...$fetchModeArgs ): PDOStatement|false {
		$stmt = $this->prepare( $query );
		$stmt->execute();
		if ( null !== $fetchMode ) {
			$stmt->setFetchMode( $fetchMode, ...$fetchModeArgs );
		}
		return $stmt;
	}

	public function exec( string $statement ): int|false {
		$stmt = $this->prepare( $statement );
		$stmt->execute();
		return $stmt->rowCount();
	}

	public function lastInsertId( ?string $name = null ): string|false {
		return $this->last_insert_id;
	}

	public function quote( string $string, int $type = PDO::PARAM_STR ): string|false {
		return "'" . str_replace( "'", "''", $string ) . "'";
	}

	public function setAttribute( int $attribute, mixed $value ): bool {
		$this->attributes[ $attribute ] = $value;
		return true;
	}

	public function getAttribute( int $attribute ): mixed {
		if ( PDO::ATTR_DRIVER_NAME === $attribute ) {
			return 'sqlite';
		}
		if ( PDO::ATTR_SERVER_VERSION === $attribute || PDO::ATTR_CLIENT_VERSION === $attribute ) {
			return self::SQLITE_VERSION;
		}
		return isset( $this->attributes[ $attribute ] ) ? $this->attributes[ $attribute ] : null;
	}

	public function beginTransaction(): bool {
		$this->in_transaction = true;
		return true;
	}

	public function commit(): bool {
		$this->in_transaction = false;
		return true;
	}

	public function rollBack(): bool {
		++self::$rollbacks;
		$this->in_transaction = false;
		return true;
	}

	public function inTransaction(): bool {
		return $this->in_transaction;
	}

	public function createFunction( string $function_name, callable $callback, int $num_args = -1, int $flags = 0 ): bool {
		self::$functions[] = $function_name;
		return true;
	}

	public function sqliteCreateFunction( $function_name, $callback, $num_args = -1, $flags = 0 ) {
		self::$functions[] = $function_name;
		return true;
	}

	public function errorCode(): ?string {
		return '00000';
	}

	public function errorInfo(): array {
		return array( '00000', null, null );
	}
}

class D1_PDOStatement extends PDOStatement {
	/** @var D1_PDO */
	private $pdo;
	/** @var string */
	private $sql;
	/** @var array<int|string,mixed> */
	private $bound = array();
	/** @var array<string> */
	private $columns = array();
	/** @var array<array> */
	private $rows = array();
	/** @var int */
	private $cursor = 0;
	/** @var int */
	private $changes = 0;
	/** @var int */
	private $fetch_mode;
	/** @var array */
	private $fetch_args = array();

	public function __construct( D1_PDO $pdo, string $sql, int $fetch_mode ) {
		$this->pdo        = $pdo;
		$this->sql        = $sql;
		$this->fetch_mode = $fetch_mode;
	}

	public function bindValue( int|string $param, mixed $value, int $type = PDO::PARAM_STR ): bool {
		$this->bound[ $param ] = $value;
		return true;
	}

	public function bindParam( int|string $param, mixed &$var, int $type = PDO::PARAM_STR, int $maxLength = 0, mixed $driverOptions = null ): bool {
		$this->bound[ $param ] = &$var;
		return true;
	}

	/**
	 * Turn named or 1-based parameters into a positional list for D1.
	 *
	 * @param array $params
	 * @return array{0:string,1:array}
	 */
	private function positional( array $params ) {
		if ( ! $params ) {
			return array( $this->sql, array() );
		}
		$named = false;
		foreach ( array_keys( $params ) as $k ) {
			if ( is_string( $k ) ) {
				$named = true;
				break;
			}
		}
		$norm = function ( $v ) {
			return is_bool( $v ) ? (int) $v : $v;
		};
		if ( ! $named ) {
			ksort( $params );
			return array( $this->sql, array_map( $norm, array_values( $params ) ) );
		}
		// Replace :name outside quotes with ?, in order of appearance.
		$out  = '';
		$list = array();
		$len  = strlen( $this->sql );
		for ( $i = 0; $i < $len; $i++ ) {
			$c = $this->sql[ $i ];
			if ( "'" === $c || '"' === $c || '`' === $c ) {
				$j = $i + 1;
				while ( $j < $len ) {
					if ( $this->sql[ $j ] === $c ) {
						if ( $j + 1 < $len && $this->sql[ $j + 1 ] === $c ) {
							$j += 2;
							continue;
						}
						break;
					}
					++$j;
				}
				$out .= substr( $this->sql, $i, $j - $i + 1 );
				$i    = $j;
				continue;
			}
			if ( ':' === $c && $i + 1 < $len && preg_match( '/[A-Za-z_]/', $this->sql[ $i + 1 ] ) ) {
				preg_match( '/^:([A-Za-z_][A-Za-z0-9_]*)/', substr( $this->sql, $i ), $m );
				$key = array_key_exists( ':' . $m[1], $params ) ? ':' . $m[1] : $m[1];
				$list[] = $norm( $params[ $key ] );
				$out   .= '?';
				$i     += strlen( $m[0] ) - 1;
				continue;
			}
			$out .= $c;
		}
		return array( $out, $list );
	}

	public function execute( ?array $params = null ): bool {
		$local = $this->pdo->local_reply( $this->sql );
		if ( null === $local ) {
			list( $sql, $list ) = $this->positional( null !== $params ? $params : $this->bound );
			$pdo                = $this->pdo;
			try {
				list( $sql, $list ) = D1_Dialect::rewrite(
					$sql,
					$list,
					function ( $q, $p ) use ( $pdo ) {
						return $pdo->d1( $q, $p );
					}
				);
			} catch ( D1_Dialect_Unsupported $e ) {
				D1_PDO::$failures[] = array( 'sql' => $sql, 'error' => 'dialect: ' . $e->getMessage() );
				$pdo->report_failure( $sql, 'dialect: ' . $e->getMessage() );
				throw new PDOException( 'D1 dialect: ' . $e->getMessage() );
			}
			$local = $this->pdo->d1( $sql, $list );
		}
		$this->columns = $local['columns'];
		$this->rows    = $local['rows'];
		if ( $this->rows && preg_match( '/\bsqlite_(master|schema)\b/i', $this->sql ) ) {
			$this->rows = array_values(
				array_filter(
					$this->rows,
					function ( $row ) {
						foreach ( $row as $v ) {
							if ( is_string( $v ) && ( 0 === stripos( $v, '_cf_' ) || 0 === stripos( $v, '_r2_' ) ) ) {
								return false;
							}
						}
						return true;
					}
				)
			);
		}
		$this->changes = (int) $local['changes'];
		$this->cursor  = 0;
		return true;
	}

	private function stringify( array $row ) {
		if ( ! $this->pdo->getAttribute( PDO::ATTR_STRINGIFY_FETCHES ) ) {
			return $row;
		}
		return array_map(
			function ( $v ) {
				return null === $v ? null : ( is_scalar( $v ) ? (string) $v : $v );
			},
			$row
		);
	}

	private function shape( array $row, int $mode, array $args ) {
		$row = $this->stringify( $row );
		switch ( $mode ) {
			case PDO::FETCH_NUM:
				return $row;
			case PDO::FETCH_ASSOC:
				return array_combine( $this->columns, $row );
			case PDO::FETCH_OBJ:
				return (object) array_combine( $this->columns, $row );
			case PDO::FETCH_COLUMN:
				return $row[ isset( $args[0] ) ? $args[0] : 0 ];
			case PDO::FETCH_BOTH:
			case PDO::FETCH_DEFAULT:
			default:
				$both = array();
				foreach ( $row as $i => $v ) {
					$both[ $this->columns[ $i ] ] = $v;
					$both[ $i ]                   = $v;
				}
				return $both;
		}
	}

	#[\ReturnTypeWillChange]
	public function setFetchMode( int $mode, mixed ...$args ): bool {
		$this->fetch_mode = $mode;
		$this->fetch_args = $args;
		return true;
	}

	public function fetch( int $mode = PDO::FETCH_DEFAULT, int $cursorOrientation = PDO::FETCH_ORI_NEXT, int $cursorOffset = 0 ): mixed {
		if ( $this->cursor >= count( $this->rows ) ) {
			return false;
		}
		$mode = PDO::FETCH_DEFAULT === $mode ? $this->fetch_mode : $mode;
		return $this->shape( $this->rows[ $this->cursor++ ], $mode, $this->fetch_args );
	}

	public function fetchAll( int $mode = PDO::FETCH_DEFAULT, mixed ...$args ): array {
		$mode = PDO::FETCH_DEFAULT === $mode ? $this->fetch_mode : $mode;
		$args = $args ? $args : $this->fetch_args;
		$out  = array();
		if ( PDO::FETCH_KEY_PAIR === $mode ) {
			while ( $this->cursor < count( $this->rows ) ) {
				$r            = $this->stringify( $this->rows[ $this->cursor++ ] );
				$out[ $r[0] ] = $r[1];
			}
			return $out;
		}
		while ( $this->cursor < count( $this->rows ) ) {
			$out[] = $this->shape( $this->rows[ $this->cursor++ ], $mode, $args );
		}
		return $out;
	}

	public function fetchColumn( int $column = 0 ): mixed {
		if ( $this->cursor >= count( $this->rows ) ) {
			return false;
		}
		$row = $this->stringify( $this->rows[ $this->cursor++ ] );
		return $row[ $column ];
	}

	public function fetchObject( ?string $class = 'stdClass', array $constructorArgs = array() ): object|false {
		$row = $this->fetch( PDO::FETCH_ASSOC );
		if ( false === $row ) {
			return false;
		}
		$obj = new $class( ...$constructorArgs );
		foreach ( $row as $k => $v ) {
			$obj->$k = $v;
		}
		return $obj;
	}

	public function rowCount(): int {
		return $this->changes;
	}

	public function columnCount(): int {
		return count( $this->columns );
	}

	public function getColumnMeta( int $column ): array|false {
		if ( ! isset( $this->columns[ $column ] ) ) {
			return false;
		}
		$type = 'null';
		foreach ( $this->rows as $r ) {
			$v = $r[ $column ];
			if ( null === $v ) {
				continue;
			}
			$type = is_int( $v ) ? 'integer' : ( is_float( $v ) ? 'double' : 'string' );
			break;
		}
		return array(
			'name'        => $this->columns[ $column ],
			'native_type' => $type,
			'table'       => '',
			'flags'       => array(),
			'len'         => -1,
			'precision'   => 0,
			'pdo_type'    => PDO::PARAM_STR,
		);
	}

	public function closeCursor(): bool {
		$this->cursor = count( $this->rows );
		return true;
	}

	public function errorCode(): ?string {
		return '00000';
	}

	public function errorInfo(): array {
		return array( '00000', null, null );
	}
}
