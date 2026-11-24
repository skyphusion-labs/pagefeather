<?php
// php tests/r2-stat-cache-test.php
// Issue #1424 step 2. The request stat map and the 1 MB prefix buffer in php/r2-uploads.php.
// A cached absent value must not skip the approach A fallback head or an exclusive-create head.
// A list marks a missing direct child absent only when truncated is boolean false.
// The map and the prefix buffer die at request end.
// Same in-memory R2 as upload-month-json-test.php. This file does not boot WordPress.

$case = getenv( 'PF_CASE' );
if ( false === $case || '' === $case ) {
	$fail = 0;
	$js   = file_get_contents( dirname( __DIR__ ) . '/index.js' );
	$at   = strpos( $js, "if (op.op === 'list')" );
	$slice = ( false === $at ) ? '' : substr( $js, $at, 700 );
	$passes = str_contains( $slice, 'typeof l.truncated' ) && str_contains( $slice, 'out.truncated = l.truncated' );
	if ( $passes ) {
		echo "ok   worker list passes boolean truncated\n";
	} else {
		$fail++;
		echo "FAIL worker list passes boolean truncated\n";
	}
	foreach ( array( 'omit', 'cut', 'full', 'prefixes', 'reserve', 'exclusive', 'reads', 'hole', 'cap', 'second', 'shutdown', 'putdrop', 'copydest' ) as $c ) {
		echo "== case: $c ==\n";
		passthru( 'PF_CASE=' . $c . ' ' . escapeshellarg( PHP_BINARY ) . ' ' . escapeshellarg( __FILE__ ), $code );
		if ( 0 !== $code ) {
			$fail++;
		}
	}
	echo $fail ? "\n$fail CASE(S) FAILED\n" : "\nALL CASES PASS\n";
	exit( $fail ? 1 : 0 );
}

$fail = 0;
function check( $label, $got, $want ) {
	global $fail;
	if ( $got === $want ) {
		echo "ok   $label\n";
		return;
	}
	$fail++;
	echo "FAIL $label\n  got:  " . var_export( $got, true ) . "\n  want: " . var_export( $want, true ) . "\n";
}

class PfStatWpdb {
	public $options = 'wp_options';
	public $rows    = array();

	public function prepare( $sql, ...$args ) {
		foreach ( $args as $a ) {
			$sql = preg_replace( '/%s/', "'" . $a . "'", $sql, 1 );
		}
		return $sql;
	}

	public function query( $sql ) {
		if ( str_starts_with( $sql, 'INSERT IGNORE' ) && preg_match( "/VALUES \('([^']+)'/", $sql, $m ) ) {
			if ( isset( $this->rows[ $m[1] ] ) ) {
				return 0;
			}
			$this->rows[ $m[1] ] = '1';
			return 1;
		}
		return 0;
	}
}

$GLOBALS['pf_store'] = array();
$GLOBALS['pf_log']   = array();
$GLOBALS['pf_lists'] = array();
$GLOBALS['pf_trunc']      = null;
$GLOBALS['pf_hide']       = array();
$GLOBALS['pf_force_list'] = null;

function post_message_to_js( $json ) {
	return '1';
}

function skyphusion_worker_call( $json ) {
	$op = json_decode( $json, true )['r2'];
	$GLOBALS['pf_log'][] = $op;
	$store               = &$GLOBALS['pf_store'];
	if ( 'head' === $op['op'] ) {
		if ( isset( $store[ $op['key'] ] ) ) {
			return json_encode( array( 'ok' => true, 'found' => true, 'size' => strlen( $store[ $op['key'] ] ), 'mtime' => 1 ) );
		}
		return json_encode( array( 'ok' => true, 'found' => false ) );
	}
	if ( 'list' === $op['op'] ) {
		$keys  = array();
		$prefs = array();
		if ( is_array( $GLOBALS['pf_force_list'] ) ) {
			$keys  = $GLOBALS['pf_force_list']['keys'];
			$prefs = $GLOBALS['pf_force_list']['prefixes'];
		} else {
			foreach ( array_keys( $store ) as $k ) {
				if ( str_starts_with( $k, (string) $op['prefix'] ) && empty( $GLOBALS['pf_hide'][ $k ] ) ) {
					$keys[] = $k;
				}
			}
		}
		$reply = array( 'ok' => true, 'keys' => $keys, 'prefixes' => $prefs );
		if ( null !== $GLOBALS['pf_trunc'] ) {
			$reply['truncated'] = $GLOBALS['pf_trunc'];
		}
		$GLOBALS['pf_lists'][] = array(
			'n'     => count( $keys ),
			'limit' => (int) ( $op['limit'] ?? 1000 ),
			'has'   => array_key_exists( 'truncated', $reply ),
			'bit'   => $reply['truncated'] ?? null,
		);
		return json_encode( $reply );
	}
	if ( 'get' === $op['op'] ) {
		if ( ! isset( $store[ $op['key'] ] ) ) {
			return json_encode( array( 'ok' => true, 'found' => false ) );
		}
		$body = $store[ $op['key'] ];
		if ( isset( $op['length'] ) ) {
			$body = substr( $body, (int) ( $op['offset'] ?? 0 ), (int) $op['length'] );
		}
		return json_encode( array( 'ok' => true, 'found' => true, 'body' => base64_encode( $body ), 'size' => strlen( $store[ $op['key'] ] ), 'mtime' => 1 ) );
	}
	if ( 'put' === $op['op'] ) {
		$store[ $op['key'] ] = base64_decode( $op['body'] );
		return json_encode( array( 'ok' => true ) );
	}
	if ( 'delete' === $op['op'] ) {
		unset( $store[ $op['key'] ] );
		return json_encode( array( 'ok' => true ) );
	}
	if ( 'copy' === $op['op'] ) {
		if ( ! isset( $store[ $op['from'] ] ) ) {
			return json_encode( array( 'ok' => true, 'found' => false ) );
		}
		$store[ $op['to'] ] = $store[ $op['from'] ];
		if ( ! empty( $op['move'] ) ) {
			unset( $store[ $op['from'] ] );
		}
		return json_encode( array( 'ok' => true, 'found' => true ) );
	}
	if ( 'reserve' === $op['op'] ) {
		return json_encode( array( 'ok' => false, 'error' => 'unknown r2 op reserve' ) );
	}
	return json_encode( array( 'ok' => false, 'error' => 'unknown r2 op' ) );
}

function pf_ops_since( $mark, $op, $field = null, $value = null ) {
	$n = 0;
	foreach ( array_slice( $GLOBALS['pf_log'], $mark ) as $e ) {
		if ( ( $e['op'] ?? '' ) !== $op ) {
			continue;
		}
		if ( null !== $field && ( $e[ $field ] ?? null ) !== $value ) {
			continue;
		}
		$n++;
	}
	return $n;
}

function pf_wire_clean() {
	foreach ( $GLOBALS['pf_log'] as $e ) {
		if ( array_key_exists( 'bridge', $e ) ) {
			return false;
		}
	}
	return true;
}

define( 'R2_UPLOADS', true );
define( 'WP_CONTENT_DIR', '/wordpress/wp-content' );
$GLOBALS['filters'] = array();
function add_filter( $hook, $cb, $prio = 10, $args = 1 ) {
	$GLOBALS['filters'][ $hook ][] = array( $cb, $args, $prio );
}
function add_action( $hook, $cb, $prio = 10, $args = 1 ) {
}
function apply_filters( $hook, $value, ...$extra ) {
	foreach ( $GLOBALS['filters'][ $hook ] ?? array() as $f ) {
		$args  = array_merge( array( $value ), array_slice( $extra, 0, max( 0, $f[1] - 1 ) ) );
		$value = call_user_func_array( $f[0], $args );
	}
	return $value;
}
function wp_die( $msg ) {
	fwrite( STDERR, "wp_die: $msg\n" );
	exit( 1 );
}
$GLOBALS['wpdb'] = new PfStatWpdb();
require __DIR__ . '/../php/r2-uploads.php';

$month = 'r2://uploads/2026/11';
$photo = 'uploads/2026/11/photo.png';
$other = 'uploads/2026/11/other.png';

if ( 'omit' === $case || 'cut' === $case ) {
	$GLOBALS['pf_store'] = array( $photo => 'p', $other => 'o' );
	$GLOBALS['pf_hide']  = array( $other => true );
	$GLOBALS['pf_trunc'] = ( 'cut' === $case ) ? true : null;
	$names               = scandir( $month );
	check( "$case: listed name is returned", in_array( 'photo.png', $names, true ), true );
	check( "$case: omitted name is not invented", in_array( 'other.png', $names, true ), false );
	$listed = $GLOBALS['pf_lists'][0];
	check( "$case: the page is under the list limit", $listed['n'] < $listed['limit'], true );
	check( "$case: truncated flag", $listed['has'] ? $listed['bit'] : null, ( 'cut' === $case ) ? true : null );
	$mark = count( $GLOBALS['pf_log'] );
	check( "$case: a real key the page omitted still exists", file_exists( 'r2://' . $other ), true );
	check( "$case: that key was headed", pf_ops_since( $mark, 'head', 'key', $other ) >= 1, true );
	$lists = pf_ops_since( 0, 'list', 'prefix', 'uploads/2026/11/' );
	scandir( $month );
	check( "$case: this page is not a stored scandir", pf_ops_since( 0, 'list', 'prefix', 'uploads/2026/11/' ), $lists + 1 );
	check( "$case: bridge flag stays off the wire", pf_wire_clean(), true );
	exit( $fail ? 1 : 0 );
}

if ( 'full' === $case ) {
	$GLOBALS['pf_store'] = array( $photo => str_repeat( 'Q', 100 ) );
	$GLOBALS['pf_trunc'] = false;
	$names               = scandir( $month );
	check( 'full: scandir returns the file', in_array( 'photo.png', $names, true ), true );
	$mark = count( $GLOBALS['pf_log'] );
	check( 'full: the listed file exists', file_exists( 'r2://' . $photo ), true );
	check( 'full: a missing direct child does not exist', file_exists( $month . '/photo-1.png' ), false );
	check( 'full: the missing child was not headed', pf_ops_since( $mark, 'head', 'key', 'uploads/2026/11/photo-1.png' ), 0 );
	check( 'full: the listed file was not headed', pf_ops_since( $mark, 'head', 'key', $photo ), 0 );
	$lists = pf_ops_since( 0, 'list', 'prefix', 'uploads/2026/11/' );
	$again = scandir( $month );
	check( 'full: scandir reuses the complete page', pf_ops_since( 0, 'list', 'prefix', 'uploads/2026/11/' ), $lists );
	check( 'full: the reused scandir still returns the file', in_array( 'photo.png', $again, true ), true );
	$mark = count( $GLOBALS['pf_log'] );
	check( 'full: a parent directory on the key path exists', file_exists( 'r2://uploads/2026' ), true );
	check( 'full: that directory was not headed', pf_ops_since( $mark, 'head', 'key', 'uploads/2026' ), 0 );
	exit( $fail ? 1 : 0 );
}

if ( 'prefixes' === $case ) {
	$GLOBALS['pf_trunc']      = false;
	$GLOBALS['pf_force_list'] = array(
		'keys'     => array(),
		'prefixes' => array( 'uploads/2026/' ),
	);
	$names = scandir( 'r2://uploads' );
	check( 'prefixes: the listed year is a directory name', in_array( '2026', $names, true ), true );
	$mark = count( $GLOBALS['pf_log'] );
	check( 'prefixes: the year directory exists', file_exists( 'r2://uploads/2026' ), true );
	check( 'prefixes: the year was not headed', pf_ops_since( $mark, 'head', 'key', 'uploads/2026' ), 0 );
	$lists = pf_ops_since( 0, 'list', 'prefix', 'uploads/' );
	scandir( 'r2://uploads' );
	check( 'prefixes: a complete prefix page is reused', pf_ops_since( 0, 'list', 'prefix', 'uploads/' ), $lists );
	exit( $fail ? 1 : 0 );
}

if ( 'reserve' === $case ) {
	$GLOBALS['pf_store'] = array( $photo => 'p' );
	$GLOBALS['pf_trunc'] = false;
	scandir( $month );
	$fresh = 'uploads/2026/11/fresh.jpg';
	$mark  = count( $GLOBALS['pf_log'] );
	check( 'reserve: a missing direct child is absent', file_exists( 'r2://' . $fresh ), false );
	check( 'reserve: that absent mark did not head', pf_ops_since( $mark, 'head', 'key', $fresh ), 0 );
	$GLOBALS['pf_store'][ $fresh ] = 'x';
	$mark = count( $GLOBALS['pf_log'] );
	$name = apply_filters( 'wp_unique_filename', 'fresh.jpg', '.jpg', $month );
	check( 'reserve: the fallback head ran on the bridge', pf_ops_since( $mark, 'head', 'key', $fresh ) >= 1, true );
	check( 'reserve: a cached absent value did not take the live name', $name === 'fresh.jpg', false );
	check( 'reserve: bridge flag stays off the wire', pf_wire_clean(), true );
	exit( $fail ? 1 : 0 );
}

if ( 'exclusive' === $case ) {
	$GLOBALS['pf_trunc'] = null;
	$free                = 'uploads/2026/11/new.png';
	file_exists( 'r2://' . $free );
	$mark = count( $GLOBALS['pf_log'] );
	$h    = @fopen( 'r2://' . $free, 'x' );
	check( 'exclusive: a free name still opens', is_resource( $h ), true );
	if ( is_resource( $h ) ) {
		fclose( $h );
	}
	check( 'exclusive: mode x headed the free name', pf_ops_since( $mark, 'head', 'key', $free ) >= 1, true );
	$late = 'uploads/2026/11/late.png';
	file_exists( 'r2://' . $late );
	$GLOBALS['pf_store'][ $late ] = 'now';
	$mark = count( $GLOBALS['pf_log'] );
	$h    = @fopen( 'r2://' . $late, 'x' );
	check( 'exclusive: mode x does not create over a live object', is_resource( $h ), false );
	check( 'exclusive: mode x headed while the cache said absent', pf_ops_since( $mark, 'head', 'key', $late ) >= 1, true );
	check( 'exclusive: bridge flag stays off the wire', pf_wire_clean(), true );
	exit( $fail ? 1 : 0 );
}

if ( 'reads' === $case ) {
	$body                    = str_repeat( 'A', 100 ) . str_repeat( 'B', 69900 );
	$GLOBALS['pf_store'][ $photo ] = $body;
	$before                  = pf_ops_since( 0, 'get', 'key', $photo );
	for ( $i = 0; $i < 3; $i++ ) {
		$h   = fopen( 'r2://' . $photo, 'r' );
		$got = stream_get_contents( $h );
		fclose( $h );
		check( "reads: open $i returns the object", $got, $body );
	}
	check( 'reads: three opens from byte 0 pay two gets', pf_ops_since( 0, 'get', 'key', $photo ) - $before, 2 );
	exit( $fail ? 1 : 0 );
}

if ( 'hole' === $case ) {
	$body = str_repeat( 'A', 65536 ) . str_repeat( 'C', 100000 );
	$GLOBALS['pf_store'][ $photo ] = $body;
	$h = fopen( 'r2://' . $photo, 'r' );
	check( 'hole: the start is the prefix', fread( $h, 10 ), str_repeat( 'A', 10 ) );
	fseek( $h, 150000 );
	check( 'hole: a gap reads the object', fread( $h, 10 ), substr( $body, 150000, 10 ) );
	fclose( $h );
	$mark = count( $GLOBALS['pf_log'] );
	$h    = fopen( 'r2://' . $photo, 'r' );
	$got  = stream_get_contents( $h );
	fclose( $h );
	check( 'hole: the next open returns the object', $got, $body );
	check( 'hole: the gap was not merged into the prefix', substr( (string) $got, 65536, 10 ), substr( $body, 65536, 10 ) );
	check( 'hole: the next open gets only past the prefix', pf_ops_since( $mark, 'get', 'key', $photo ), 1 );
	exit( $fail ? 1 : 0 );
}

if ( 'cap' === $case ) {
	$body = str_repeat( 'Z', 1048576 + 10 );
	$GLOBALS['pf_store'][ $photo ] = $body;
	$h = fopen( 'r2://' . $photo, 'r' );
	check( 'cap: the first read returns the object', stream_get_contents( $h ), $body );
	fclose( $h );
	$mark = count( $GLOBALS['pf_log'] );
	$h    = fopen( 'r2://' . $photo, 'r' );
	$got  = stream_get_contents( $h );
	fclose( $h );
	check( 'cap: a later read still returns the tail', $got, $body );
	check( 'cap: the tail past 1 MB still calls get', pf_ops_since( $mark, 'get', 'key', $photo ), 1 );
	exit( $fail ? 1 : 0 );
}

if ( 'second' === $case ) {
	$GLOBALS['pf_store'][ $photo ] = 'one';
	check( 'second: the first read is the first body', file_get_contents( 'r2://' . $photo ), 'one' );
	$missing = 'uploads/2026/11/missing.png';
	check( 'second: the missing key is absent', file_exists( 'r2://' . $missing ), false );
	$GLOBALS['pf_store'][ $photo ]   = 'two';
	$GLOBALS['pf_store'][ $missing ] = 'here';
	if ( ! method_exists( 'R2_Uploads_Stream', 'request_clear' ) ) {
		check( 'second: request_clear exists', false, true );
		exit( 1 );
	}
	R2_Uploads_Stream::request_clear();
	check( 'second: the next request does not keep the prefix bytes', file_get_contents( 'r2://' . $photo ), 'two' );
	check( 'second: the next request does not keep the absent mark', file_exists( 'r2://' . $missing ), true );
	exit( $fail ? 1 : 0 );
}

if ( 'shutdown' === $case ) {
	$GLOBALS['pf_store'][ $photo ] = 'one';
	file_get_contents( 'r2://' . $photo );
	$missing = 'uploads/2026/11/missing.png';
	file_exists( 'r2://' . $missing );
	$GLOBALS['pf_store'][ $photo ]   = 'two';
	$GLOBALS['pf_store'][ $missing ] = 'here';
	register_shutdown_function(
		function () use ( $photo, $missing ) {
			global $fail;
			check( 'shutdown: request end drops the prefix bytes', file_get_contents( 'r2://' . $photo ), 'two' );
			check( 'shutdown: request end drops the absent mark', file_exists( 'r2://' . $missing ), true );
			exit( $fail ? 1 : 0 );
		}
	);
	exit( 0 );
}

if ( 'putdrop' === $case ) {
	$GLOBALS['pf_store'][ $photo ] = 'a';
	$stream                        = new R2_Uploads_Stream();
	check( 'putdrop: unlink returns true', $stream->unlink( 'r2://' . $photo ), true );
	$h = fopen( 'r2://' . $photo, 'w' );
	fwrite( $h, 'b' );
	fclose( $h );
	$mark = count( $GLOBALS['pf_log'] );
	check( 'putdrop: the written key exists', file_exists( 'r2://' . $photo ), true );
	check( 'putdrop: the next stat headed', pf_ops_since( $mark, 'head', 'key', $photo ) >= 1, true );
	exit( $fail ? 1 : 0 );
}

if ( 'copydest' === $case ) {
	$GLOBALS['pf_store'][ $photo ] = str_repeat( 'S', 1000 );
	$GLOBALS['pf_store'][ $other ] = str_repeat( 'T', 1000 );
	check( 'copydest: the first read fills the prefix', file_get_contents( 'r2://' . $photo ), str_repeat( 'S', 1000 ) );
	$ok = R2_Uploads_Stream::call( array( 'op' => 'copy', 'from' => $other, 'to' => $photo, 'type' => 'image/png' ) );
	check( 'copydest: copy found the source', ! empty( $ok['found'] ), true );
	check( 'copydest: the dest prefix buffer was dropped', file_get_contents( 'r2://' . $photo ), str_repeat( 'T', 1000 ) );
	exit( $fail ? 1 : 0 );
}

fwrite( STDERR, "unknown case $case\n" );
exit( 1 );
