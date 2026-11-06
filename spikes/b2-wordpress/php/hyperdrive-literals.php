<?php
/**
 * SQL for approach A's Worker bridge (issue #79). Loaded by php/hyperdrive-db.php.
 * No side effects and no WordPress: tests/a/literals-test.php runs it with the PHP CLI.
 *
 * The bridge carries SQL as JSON text, so it must be valid UTF-8. A string
 * literal that holds other bytes (a raw hash, a packed IP address, serialized
 * binary) is rewritten as a hex literal, X'...', which MySQL reads as the same
 * bytes. Before this, such SQL went as {mysql_b64}, the Worker decoded it as
 * latin1 and mysql2 sent it as utf8mb4: every byte above 0x7F was stored as
 * two (measured on MariaDB 11.4, docs/approach-a.md).
 *
 * Literals are read as MySQL reads them without NO_BACKSLASH_ESCAPES, which
 * is how wpdb escapes: '...' or "...", backslash escapes, a doubled quote.
 * \% and \_ keep their backslash, as in MySQL. Backticked names and comments
 * (-- , #, slash-star) are copied as they are. A literal that is valid UTF-8
 * is not changed. After a charset introducer (_binary'...') a space is put
 * before X'...'.
 *
 * Prior art: HostlessWP hostlesswp_sql_for_bridge() (docs/prior-art.md).
 */

if ( ! function_exists( 'skyphusion_hd_sql_for_bridge' ) ) {
	/**
	 * @return string|null The SQL as valid UTF-8, or null when bytes that are
	 *                     not UTF-8 are outside any string literal.
	 */
	function skyphusion_hd_sql_for_bridge( $sql ) {
		$sql = (string) $sql;
		if ( preg_match( '//u', $sql ) ) {
			return $sql;
		}
		$unescape = array( '0' => "\0", "'" => "'", '"' => '"', 'b' => "\x08", 'n' => "\n", 'r' => "\r", 't' => "\t", 'Z' => "\x1a", '\\' => '\\' );
		$out      = '';
		$len      = strlen( $sql );
		$i        = 0;
		while ( $i < $len ) {
			$c = $sql[ $i ];
			// A backticked name: copy to the closing backtick (a doubled one is part of the name).
			if ( '`' === $c ) {
				$j = $i + 1;
				while ( $j < $len ) {
					if ( '`' === $sql[ $j ] ) {
						if ( $j + 1 < $len && '`' === $sql[ $j + 1 ] ) {
							$j += 2;
							continue;
						}
						break;
					}
					++$j;
				}
				$out .= substr( $sql, $i, $j + 1 - $i );
				$i    = $j + 1;
				continue;
			}
			// Comments: to the end of the line, or to the closing star-slash.
			if ( '#' === $c || ( '-' === $c && '-' === ( $sql[ $i + 1 ] ?? '' ) && preg_match( '/\s/', $sql[ $i + 2 ] ?? ' ' ) ) ) {
				$j    = strpos( $sql, "\n", $i );
				$j    = false === $j ? $len : $j;
				$out .= substr( $sql, $i, $j - $i );
				$i    = $j;
				continue;
			}
			if ( '/' === $c && '*' === ( $sql[ $i + 1 ] ?? '' ) ) {
				$j    = strpos( $sql, '*/', $i + 2 );
				$j    = false === $j ? $len : $j + 2;
				$out .= substr( $sql, $i, $j - $i );
				$i    = $j;
				continue;
			}
			if ( "'" !== $c && '"' !== $c ) {
				$out .= $c;
				++$i;
				continue;
			}
			// A string literal: read its value as MySQL does.
			$quote = $c;
			$value = '';
			$j     = $i + 1;
			$open  = true;
			while ( $j < $len ) {
				$d = $sql[ $j ];
				if ( '\\' === $d && $j + 1 < $len ) {
					$e      = $sql[ $j + 1 ];
					$value .= isset( $unescape[ $e ] ) ? $unescape[ $e ] : ( '%' === $e || '_' === $e ? '\\' . $e : $e );
					$j     += 2;
					continue;
				}
				if ( $d === $quote ) {
					if ( $j + 1 < $len && $sql[ $j + 1 ] === $quote ) {
						$value .= $quote;
						$j     += 2;
						continue;
					}
					$open = false;
					break;
				}
				$value .= $d;
				++$j;
			}
			$literal = substr( $sql, $i, $j + 1 - $i );
			if ( $open || preg_match( '//u', $value ) ) {
				$out .= $literal; // Unterminated (MySQL reports it), or valid UTF-8: as it was.
			} else {
				$space = ( '' !== $out && preg_match( '/[A-Za-z0-9_]$/', $out ) ) ? ' ' : '';
				$out  .= $space . ( '' === $value ? "''" : "X'" . bin2hex( $value ) . "'" );
			}
			$i = $j + 1;
		}
		return preg_match( '//u', $out ) ? $out : null;
	}
}

if ( ! function_exists( 'skyphusion_mysql_escape' ) ) {
	/** The escaping of mysqli_real_escape_string() for utf8mb4. */
	function skyphusion_mysql_escape( $data ) {
		return strtr(
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
	}
}
