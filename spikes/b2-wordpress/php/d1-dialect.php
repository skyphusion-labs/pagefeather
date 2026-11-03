<?php
/**
 * D1_Dialect: rewrite the SQLite the driver writes so D1 can run it.
 *
 * The SQLite driver registers PHP functions inside SQLite (YEAR, REGEXP, ...).
 * D1 cannot run PHP. This class rewrites each call before the statement goes
 * to D1:
 *
 * 1. A function SQLite can express becomes plain SQLite (YEAR -> substr).
 * 2. A function SQLite cannot express, with constant arguments (literals or
 *    bound parameters), is computed in PHP and inlined as a literal.
 * 3. `x REGEXP p` on a single table becomes two steps: read rowid and x,
 *    match in PHP, then filter by rowid.
 *
 * Anything else throws D1_Dialect_Unsupported with the function name.
 */

class D1_Dialect_Unsupported extends RuntimeException {}

class D1_Dialect {
	/** Functions computed in PHP when every argument is constant. */
	const PHP_ONLY = array( 'md5', 'reverse', 'from_base64', 'to_base64', 'inet_ntoa', 'inet_aton', '_helper_like_to_glob_pattern', 'from_unixtime' );

	/** All function names the driver registers. */
	const DRIVER_FUNCTIONS = array( 'throw', 'month', 'monthnum', 'year', 'day', 'hour', 'minute', 'second', 'week', 'weekday', 'dayofweek', 'dayofmonth', 'unix_timestamp', 'now', 'md5', 'curdate', 'rand', 'from_unixtime', 'localtime', 'localtimestamp', 'isnull', 'regexp', 'field', 'log', 'least', 'greatest', 'get_lock', 'release_lock', 'ucase', 'lcase', 'unhex', 'from_base64', 'to_base64', 'inet_ntoa', 'inet_aton', 'datediff', 'locate', 'utc_date', 'utc_time', 'utc_timestamp', 'version', 'reverse', '_helper_like_to_glob_pattern' );

	/** @var array<string,int> Rewrites done, by name. Read by tests and stats. */
	public static $counts = array();

	/**
	 * @param string   $sql
	 * @param array    $params Positional parameters.
	 * @param callable $run    function( string $sql, array $params ): array{columns,rows}
	 * @return array{0:string,1:array}
	 */
	public static function rewrite( $sql, array $params, callable $run ) {
		if ( ! preg_match( '/\b(' . implode( '|', self::DRIVER_FUNCTIONS ) . ')\b/i', $sql ) ) {
			return array( $sql, $params );
		}
		$tokens = self::tokenize( $sql );
		// Bind each ? to its parameter so constant arguments can be computed.
		$p = 0;
		foreach ( $tokens as $i => $t ) {
			if ( 'param' === $t['type'] ) {
				$tokens[ $i ]['value'] = array_key_exists( $p, $params ) ? $params[ $p ] : null;
				++$p;
			}
		}
		$tokens = self::rewrite_regexp( $tokens, $run );
		$tokens = self::rewrite_calls( $tokens );
		return self::render( $tokens );
	}

	/** @return array<array{type:string,text:string}> */
	public static function tokenize( $sql ) {
		$out = array();
		$len = strlen( $sql );
		$i   = 0;
		while ( $i < $len ) {
			$c = $sql[ $i ];
			if ( ctype_space( $c ) ) {
				$j = $i;
				while ( $j < $len && ctype_space( $sql[ $j ] ) ) {
					++$j;
				}
				$out[] = array( 'type' => 'ws', 'text' => substr( $sql, $i, $j - $i ) );
				$i     = $j;
				continue;
			}
			if ( '-' === $c && '-' === ( $sql[ $i + 1 ] ?? '' ) ) {
				$j     = strpos( $sql, "\n", $i );
				$j     = false === $j ? $len : $j;
				$out[] = array( 'type' => 'ws', 'text' => substr( $sql, $i, $j - $i ) );
				$i     = $j;
				continue;
			}
			if ( '/' === $c && '*' === ( $sql[ $i + 1 ] ?? '' ) ) {
				$j     = strpos( $sql, '*/', $i + 2 );
				$j     = false === $j ? $len : $j + 2;
				$out[] = array( 'type' => 'ws', 'text' => substr( $sql, $i, $j - $i ) );
				$i     = $j;
				continue;
			}
			if ( "'" === $c || '"' === $c || '`' === $c || '[' === $c ) {
				$close = '[' === $c ? ']' : $c;
				$j     = $i + 1;
				while ( $j < $len ) {
					if ( $sql[ $j ] === $close ) {
						if ( '[' !== $c && ( $sql[ $j + 1 ] ?? '' ) === $close ) {
							$j += 2;
							continue;
						}
						break;
					}
					++$j;
				}
				$text  = substr( $sql, $i, $j - $i + 1 );
				$out[] = array( 'type' => "'" === $c ? 'string' : 'ident', 'text' => $text );
				$i     = $j + 1;
				continue;
			}
			if ( '?' === $c ) {
				$j = $i + 1;
				while ( $j < $len && ctype_digit( $sql[ $j ] ) ) {
					++$j;
				}
				$out[] = array( 'type' => 'param', 'text' => '?' );
				$i     = $j;
				continue;
			}
			if ( ctype_alpha( $c ) || '_' === $c ) {
				preg_match( '/[A-Za-z_][A-Za-z0-9_$]*/A', $sql, $m, 0, $i );
				$out[] = array( 'type' => 'word', 'text' => $m[0] );
				$i    += strlen( $m[0] );
				continue;
			}
			if ( ctype_digit( $c ) || ( '.' === $c && ctype_digit( $sql[ $i + 1 ] ?? '' ) ) ) {
				preg_match( '/(0x[0-9A-Fa-f]+|\d*\.?\d+(?:[eE][+-]?\d+)?)/A', $sql, $m, 0, $i );
				$out[] = array( 'type' => 'number', 'text' => $m[0] );
				$i    += strlen( $m[0] );
				continue;
			}
			$two = substr( $sql, $i, 2 );
			if ( in_array( $two, array( '<=', '>=', '!=', '<>', '==', '||', '<<', '>>' ), true ) ) {
				$out[] = array( 'type' => 'op', 'text' => $two );
				$i    += 2;
				continue;
			}
			$out[] = array( 'type' => 'op', 'text' => $c );
			++$i;
		}
		return $out;
	}

	private static function name( array $t ) {
		if ( 'word' === $t['type'] ) {
			return strtolower( $t['text'] );
		}
		if ( 'ident' === $t['type'] && '`' === $t['text'][0] ) {
			return strtolower( str_replace( '``', '`', substr( $t['text'], 1, -1 ) ) );
		}
		return null;
	}

	private static function next_index( array $tokens, $i ) {
		for ( $j = $i + 1, $n = count( $tokens ); $j < $n; $j++ ) {
			if ( 'ws' !== $tokens[ $j ]['type'] ) {
				return $j;
			}
		}
		return null;
	}

	private static function prev_index( array $tokens, $i ) {
		for ( $j = $i - 1; $j >= 0; $j-- ) {
			if ( 'ws' !== $tokens[ $j ]['type'] ) {
				return $j;
			}
		}
		return null;
	}

	/**
	 * Find the matching close paren for the open paren at $open.
	 *
	 * @return array{0:int,1:array<array>} Close index and the argument token lists.
	 */
	private static function args( array $tokens, $open ) {
		$depth = 0;
		$args  = array( array() );
		for ( $j = $open, $n = count( $tokens ); $j < $n; $j++ ) {
			$t = $tokens[ $j ];
			if ( '(' === $t['text'] && 'op' === $t['type'] ) {
				++$depth;
				if ( 1 === $depth ) {
					continue;
				}
			} elseif ( ')' === $t['text'] && 'op' === $t['type'] ) {
				--$depth;
				if ( 0 === $depth ) {
					$args = array_values(
						array_filter(
							$args,
							function ( $a ) {
								foreach ( $a as $x ) {
									if ( 'ws' !== $x['type'] ) {
										return true;
									}
								}
								return false;
							}
						)
					);
					return array( $j, $args );
				}
			} elseif ( ',' === $t['text'] && 'op' === $t['type'] && 1 === $depth ) {
				$args[] = array();
				continue;
			}
			$args[ count( $args ) - 1 ][] = $t;
		}
		throw new D1_Dialect_Unsupported( 'unbalanced parentheses' );
	}

	/** Render tokens back to SQL plus the positional parameter list. */
	public static function render( array $tokens ) {
		$sql    = '';
		$params = array();
		foreach ( $tokens as $t ) {
			if ( 'param' === $t['type'] ) {
				$params[] = $t['value'];
				$sql     .= '?';
				continue;
			}
			$sql .= $t['text'];
		}
		return array( $sql, $params );
	}

	/** SQL text of an argument, with its parameters kept as tokens. */
	private static function arg_tokens( array $arg ) {
		return array_merge( array( array( 'type' => 'op', 'text' => '(' ) ), $arg, array( array( 'type' => 'op', 'text' => ')' ) ) );
	}

	/**
	 * The constant value of an argument, or a miss.
	 *
	 * @return array{0:bool,1:mixed}
	 */
	private static function constant( array $arg ) {
		$arg = array_values(
			array_filter(
				$arg,
				function ( $t ) {
					return 'ws' !== $t['type'];
				}
			)
		);
		if ( 1 !== count( $arg ) ) {
			return array( false, null );
		}
		$t = $arg[0];
		if ( 'param' === $t['type'] ) {
			return array( true, $t['value'] );
		}
		if ( 'string' === $t['type'] ) {
			return array( true, str_replace( "''", "'", substr( $t['text'], 1, -1 ) ) );
		}
		if ( 'number' === $t['type'] ) {
			return array( true, $t['text'] + 0 );
		}
		if ( 'word' === $t['type'] && 'null' === strtolower( $t['text'] ) ) {
			return array( true, null );
		}
		return array( false, null );
	}

	private static function literal( $v ) {
		if ( null === $v ) {
			return array( 'type' => 'word', 'text' => 'NULL' );
		}
		if ( is_int( $v ) || is_float( $v ) ) {
			return array( 'type' => 'number', 'text' => (string) $v );
		}
		if ( is_bool( $v ) ) {
			return array( 'type' => 'number', 'text' => $v ? '1' : '0' );
		}
		return array( 'type' => 'string', 'text' => "'" . str_replace( "'", "''", (string) $v ) . "'" );
	}

	/** Build a token list from a template with {0}, {1} ... argument slots. */
	private static function template( $template, array $args ) {
		$out   = array();
		$parts = preg_split( '/(\{\d+\})/', $template, -1, PREG_SPLIT_DELIM_CAPTURE );
		foreach ( $parts as $part ) {
			if ( preg_match( '/^\{(\d+)\}$/', $part, $m ) ) {
				$out = array_merge( $out, self::arg_tokens( $args[ (int) $m[1] ] ) );
			} elseif ( '' !== $part ) {
				$out[] = array( 'type' => 'raw', 'text' => $part );
			}
		}
		return $out;
	}

	private static function count_rewrite( $name ) {
		self::$counts[ $name ] = ( self::$counts[ $name ] ?? 0 ) + 1;
	}

	/** Rewrite driver function calls. Works from the end so indexes stay valid. */
	private static function rewrite_calls( array $tokens ) {
		for ( $i = count( $tokens ) - 1; $i >= 0; $i-- ) {
			$name = self::name( $tokens[ $i ] );
			if ( null === $name || ! in_array( $name, self::DRIVER_FUNCTIONS, true ) || 'regexp' === $name ) {
				continue;
			}
			$open = self::next_index( $tokens, $i );
			if ( null === $open || '(' !== $tokens[ $open ]['text'] ) {
				continue;
			}
			// A column or table named like a function, e.g. `t`.`year`.
			$prev = self::prev_index( $tokens, $i );
			if ( null !== $prev && '.' === $tokens[ $prev ]['text'] ) {
				continue;
			}
			list( $close, $args ) = self::args( $tokens, $open );
			$args                 = array_map( array( __CLASS__, 'rewrite_calls' ), $args );
			$replacement          = self::replacement( $name, $args );
			self::count_rewrite( $name );
			array_splice( $tokens, $i, $close - $i + 1, $replacement );
		}
		return $tokens;
	}

	private static function replacement( $name, array $args ) {
		$n = count( $args );
		switch ( $name ) {
			case 'year':
				return self::template( "CAST(substr({0}, 1, 4) AS INTEGER)", $args );
			case 'month':
			case 'monthnum':
				return self::template( "CAST(substr({0}, 6, 2) AS INTEGER)", $args );
			case 'day':
			case 'dayofmonth':
				return self::template( "CAST(substr({0}, 9, 2) AS INTEGER)", $args );
			case 'hour':
				return self::template( "CAST(strftime('%H', {0}) AS INTEGER)", $args );
			case 'minute':
				return self::template( "CAST(strftime('%M', {0}) AS INTEGER)", $args );
			case 'second':
				return self::template( "CAST(strftime('%S', {0}) AS INTEGER)", $args );
			case 'week':
				return self::template( "CAST(strftime('%W', {0}) AS INTEGER)", $args );
			case 'weekday':
				return self::template( "((CAST(strftime('%w', {0}) AS INTEGER) + 6) % 7)", $args );
			case 'dayofweek':
				return self::template( "(CAST(strftime('%w', {0}) AS INTEGER) + 1)", $args );
			case 'unix_timestamp':
				return 0 === $n ? self::template( "CAST(strftime('%s', 'now') AS INTEGER)", $args ) : self::template( "CAST(strftime('%s', {0}) AS INTEGER)", $args );
			case 'now':
			case 'localtime':
			case 'localtimestamp':
			case 'utc_timestamp':
				return self::template( "datetime('now')", $args );
			case 'curdate':
			case 'utc_date':
				return self::template( "date('now')", $args );
			case 'utc_time':
				return self::template( "time('now')", $args );
			case 'rand':
				// A seed is ignored: D1 has no seeded random.
				return self::template( '(abs(random()) / 9223372036854775807.0)', $args );
			case 'isnull':
				return self::template( '({0} IS NULL)', $args );
			case 'field':
				if ( $n < 2 ) {
					return self::template( '0', $args );
				}
				$t = 'CASE WHEN {0} IS NULL THEN 0';
				for ( $k = 1; $k < $n; $k++ ) {
					$t .= " WHEN lower({0}) = lower({{$k}}) THEN $k";
				}
				return self::template( $t . ' ELSE 0 END', $args );
			case 'log':
				return 1 === $n ? self::template( 'ln({0})', $args ) : self::template( '(ln({0}) / ln({1}))', $args );
			case 'least':
				return self::template( 'min(' . implode( ', ', array_map( function ( $k ) { return '{' . $k . '}'; }, array_keys( $args ) ) ) . ')', $args );
			case 'greatest':
				return self::template( 'max(' . implode( ', ', array_map( function ( $k ) { return '{' . $k . '}'; }, array_keys( $args ) ) ) . ')', $args );
			case 'get_lock':
			case 'release_lock':
				return self::template( '1', $args );
			case 'ucase':
				return self::template( 'upper({0})', $args );
			case 'lcase':
				return self::template( 'lower({0})', $args );
			case 'unhex':
				return self::template( 'unhex({0})', $args );
			case 'datediff':
				return self::template( 'CAST(julianday(date({0})) - julianday(date({1})) AS INTEGER)', $args );
			case 'locate':
				if ( 2 === $n ) {
					return self::template( 'instr({1}, {0})', $args );
				}
				return self::template( 'CASE WHEN instr(substr({1}, {2}), {0}) > 0 THEN instr(substr({1}, {2}), {0}) + {2} - 1 ELSE 0 END', $args );
			case 'version':
				return array( self::literal( '5.5' ) );
			case 'throw':
				// Integer overflow is a runtime error in SQLite; the message is lost.
				return self::template( 'abs(-9223372036854775807 - 1)', $args );
		}
		if ( in_array( $name, self::PHP_ONLY, true ) ) {
			$values = array();
			foreach ( $args as $a ) {
				list( $ok, $v ) = self::constant( $a );
				if ( ! $ok ) {
					throw new D1_Dialect_Unsupported( "$name() with a non-constant argument" );
				}
				$values[] = $v;
			}
			$udf = new WP_SQLite_PDO_User_Defined_Functions();
			return array( self::literal( $udf->$name( ...$values ) ) );
		}
		throw new D1_Dialect_Unsupported( "$name()" );
	}

	/**
	 * Rewrite `x [NOT] REGEXP p` for a statement on one table.
	 */
	private static function rewrite_regexp( array $tokens, callable $run ) {
		for ( $i = count( $tokens ) - 1; $i >= 0; $i-- ) {
			if ( 'regexp' !== self::name( $tokens[ $i ] ) || 'word' !== $tokens[ $i ]['type'] ) {
				continue;
			}
			$pat_i = self::next_index( $tokens, $i );
			$lhs_i = self::prev_index( $tokens, $i );
			$not   = false;
			if ( null !== $lhs_i && 'not' === self::name( $tokens[ $lhs_i ] ) ) {
				$not   = true;
				$lhs_i = self::prev_index( $tokens, $lhs_i );
			}
			if ( null === $pat_i || null === $lhs_i || 'ident' !== $tokens[ $lhs_i ]['type'] && 'word' !== $tokens[ $lhs_i ]['type'] ) {
				throw new D1_Dialect_Unsupported( 'REGEXP with a complex left side' );
			}
			list( $ok, $pattern ) = self::constant( array( $tokens[ $pat_i ] ) );
			if ( ! $ok ) {
				throw new D1_Dialect_Unsupported( 'REGEXP with a non-constant pattern' );
			}
			$table = self::single_table( $tokens );
			if ( null === $table ) {
				throw new D1_Dialect_Unsupported( 'REGEXP on more than one table' );
			}
			$column = $tokens[ $lhs_i ]['text'];
			$r      = $run( "SELECT rowid, $column FROM $table", array() );
			$udf    = new WP_SQLite_PDO_User_Defined_Functions();
			$ids    = array();
			foreach ( $r['rows'] as $row ) {
				if ( null !== $row[1] && $udf->regexp( $pattern, (string) $row[1] ) ) {
					$ids[] = (int) $row[0];
				}
			}
			$in = $ids ? 'rowid ' . ( $not ? 'NOT ' : '' ) . 'IN (' . implode( ',', $ids ) . ')' : ( $not ? '1' : '0' );
			self::count_rewrite( 'regexp' );
			array_splice( $tokens, $lhs_i, $pat_i - $lhs_i + 1, array( array( 'type' => 'raw', 'text' => $in ) ) );
			$i = $lhs_i;
		}
		return $tokens;
	}

	/** The one table a SELECT, UPDATE or DELETE reads, or null. */
	private static function single_table( array $tokens ) {
		$words = array();
		foreach ( $tokens as $t ) {
			if ( 'ws' !== $t['type'] ) {
				$words[] = $t;
			}
		}
		$first = self::name( $words[0] );
		foreach ( $words as $t ) {
			if ( in_array( self::name( $t ), array( 'join', 'union' ), true ) ) {
				return null;
			}
		}
		$at = null;
		if ( 'update' === $first ) {
			$at = 1;
		} else {
			foreach ( $words as $k => $t ) {
				if ( 'from' === self::name( $t ) ) {
					$at = $k + 1;
					break;
				}
			}
		}
		if ( null === $at || ! isset( $words[ $at ] ) ) {
			return null;
		}
		if ( isset( $words[ $at + 1 ] ) && ',' === $words[ $at + 1 ]['text'] ) {
			return null;
		}
		return $words[ $at ]['text'];
	}
}
