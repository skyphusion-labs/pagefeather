<?php
/**
 * Issue #946. The C1 fallback stores a reserved name in wp_options.
 * Deleting the file must delete that row, so the next upload keeps the name.
 * The worker reserve op answers failure here, which is the fallback path.
 * Run: php spikes/b2-wordpress/tests/r2-reserve-release-test.php
 */

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

class ReserveWpdb {
	public $options = 'wp_options';
	public $rows = array();

	public function prepare( $sql, ...$args ) {
		foreach ( $args as $a ) {
			$sql = preg_replace( '/%s/', "'" . $a . "'", $sql, 1 );
		}
		return $sql;
	}

	public function query( $sql ) {
		if ( str_starts_with( $sql, 'INSERT IGNORE' ) ) {
			if ( ! preg_match( "/VALUES \('([^']+)', '([^']*)', 'off'\)/", $sql, $m ) ) {
				throw new RuntimeException( 'bad insert ' . $sql );
			}
			if ( isset( $this->rows[ $m[1] ] ) ) {
				return 0;
			}
			$this->rows[ $m[1] ] = $m[2];
			return 1;
		}
		if ( str_starts_with( $sql, 'DELETE FROM' ) ) {
			if ( ! preg_match( "/option_name = '([^']+)'/", $sql, $m ) ) {
				throw new RuntimeException( 'bad delete ' . $sql );
			}
			$had = isset( $this->rows[ $m[1] ] );
			unset( $this->rows[ $m[1] ] );
			return $had ? 1 : 0;
		}
		throw new RuntimeException( 'unexpected sql ' . $sql );
	}
}

function skyphusion_worker_call( $json ) {
	$op = json_decode( $json, true )['r2'];
	if ( 'reserve' === $op['op'] ) {
		return json_encode( array( 'ok' => false, 'error' => 'unknown r2 op reserve' ) );
	}
	if ( 'head' === $op['op'] ) {
		return json_encode( array( 'ok' => true, 'found' => false ) );
	}
	if ( 'delete' === $op['op'] ) {
		return json_encode( array( 'ok' => true ) );
	}
	if ( 'copy' === $op['op'] ) {
		return json_encode( array( 'ok' => true, 'found' => ! empty( $op['move'] ) ) );
	}
	return json_encode( array( 'ok' => false, 'error' => 'unknown r2 op' ) );
}

define( 'R2_UPLOADS', true );
define( 'WP_CONTENT_DIR', '/wordpress/wp-content' );
$GLOBALS['filters'] = array();
function add_filter( $hook, $cb, $prio = 10, $args = 1 ) {
	$GLOBALS['filters'][ $hook ][] = array( $cb, $args, $prio, count( $GLOBALS['filters'][ $hook ] ?? array() ) );
}
function add_action( $hook, $cb, $prio = 10, $args = 1 ) {
}
function apply_filters( $hook, $value, ...$extra ) {
	$filters = $GLOBALS['filters'][ $hook ] ?? array();
	usort(
		$filters,
		function ( $a, $b ) {
			if ( $a[2] === $b[2] ) {
				return $a[3] <=> $b[3];
			}
			return $a[2] <=> $b[2];
		}
	);
	foreach ( $filters as $f ) {
		$args  = array_merge( array( $value ), array_slice( $extra, 0, max( 0, $f[1] - 1 ) ) );
		$value = call_user_func_array( $f[0], $args );
	}
	return $value;
}
function wp_die( $msg ) {
	fwrite( STDERR, "wp_die: $msg\n" );
	exit( 1 );
}

$GLOBALS['wpdb'] = new ReserveWpdb();
require __DIR__ . '/../php/r2-uploads.php';

function unique_name( $filename, $ext ) {
	return apply_filters( 'wp_unique_filename', $filename, $ext, 'r2://uploads/2026/11' );
}

$dir = 'r2://uploads/2026/11';
check( 'the first upload keeps image-01.jpg', unique_name( 'image-01.jpg', '.jpg' ), 'image-01.jpg' );
check( 'the name stays reserved', unique_name( 'image-01.jpg', '.jpg' ), 'image-01-1.jpg' );
check( 'a second file keeps its own name', unique_name( 'image-02.png', '.png' ), 'image-02.png' );

$stream = new R2_Uploads_Stream();
check( 'unlink of the deleted file returns true', $stream->unlink( $dir . '/image-01.jpg' ), true );
check( 'delete frees image-01.jpg', unique_name( 'image-01.jpg', '.jpg' ), 'image-01.jpg' );
check( 'image-02.png stays reserved', unique_name( 'image-02.png', '.png' ), 'image-02-1.png' );

check( 'a moved file keeps its old name reserved until the move', unique_name( 'old.jpg', '.jpg' ), 'old.jpg' );
check( 'rename of that file returns true', $stream->rename( $dir . '/old.jpg', $dir . '/new.jpg' ), true );
check( 'the old name is free after the move', unique_name( 'old.jpg', '.jpg' ), 'old.jpg' );

$ours = $GLOBALS['filters']['wp_unique_filename'][0];
check( 'the reserve filter runs after the WordPress 7.1 sub-size filter', $ours[2], 100 );

add_filter(
	'wp_unique_filename',
	function ( $filename ) {
		if ( 'shot-150x150-1.jpg' === $filename ) {
			return 'shot-150x150.jpg';
		}
		return $filename;
	},
	10,
	1
);
$before = array_keys( $GLOBALS['wpdb']->rows );
check( 'a sub-size name is the name WordPress keeps', unique_name( 'shot-150x150-1.jpg', '.jpg' ), 'shot-150x150.jpg' );
$added = array_values( array_diff( array_keys( $GLOBALS['wpdb']->rows ), $before ) );
$want  = R2_Uploads_Stream::reserved_option( 'uploads/2026/11/shot-150x150.jpg' );
$wrong = R2_Uploads_Stream::reserved_option( 'uploads/2026/11/shot-150x150-1.jpg' );
check( 'the reserved row is that kept name', $added, array( $want ) );
check( 'the rewritten -1 name is not reserved', in_array( $wrong, $added, true ), false );

echo $fail ? "\n$fail CASE(S) FAILED\n" : "\nALL CASES PASS\n";
exit( $fail ? 1 : 0 );
