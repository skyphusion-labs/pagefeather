<?php
// php spikes/b2-wordpress/tests/mem-trace-hooks-test.php <wp-includes dir>   (#504)
//
// The x-mem-trace: hooks mode of php/mem-trace.php, run against WordPress's OWN hook code
// (wp-includes/plugin.php and class-wp-hook.php of the pinned WordPress), not a stub: the priority
// sweep adds callbacks to a hook while it runs, which is WP_Hook's behaviour to get right.
// It checks, in a child process per mode:
//   hooks:   one p:<hook>@<priority> mark per registered priority, each AFTER that priority's
//            callbacks; owner names only (a value passed to the hook never reaches a message);
//            inc:<slug> per plugin include; WooCommerce files counted by subtree;
//   default: no hooks-mode mark and every mark the same 5 fields as before.
// Exit 0 on pass.

$wpinc = isset( $argv[1] ) ? rtrim( $argv[1], '/' ) : __DIR__ . '/../build/wordpress/wp-includes';
$mode  = isset( $argv[2] ) ? $argv[2] : null;
$fails = 0;
function check( $ok, $what ) {
	global $fails;
	echo ( $ok ? '  ok   ' : '  FAIL ' ) . $what . "\n";
	if ( ! $ok ) {
		++$fails;
	}
}

if ( null === $mode ) {
	// Parent: run each mode in its own process (the trace is set up at file scope, once).
	foreach ( array( 'hooks', 'default' ) as $m ) {
		passthru( escapeshellarg( PHP_BINARY ) . ' ' . escapeshellarg( __FILE__ ) . ' ' . escapeshellarg( $wpinc ) . ' ' . $m, $rc );
		check( 0 === $rc, "mode $m" );
	}
	echo $fails ? "FAIL\n" : "PASS\n";
	exit( $fails ? 1 : 0 );
}

// ---- child --------------------------------------------------------------------------------------
$GLOBALS['msgs'] = array();
$GLOBALS['ran']  = array(); // execution order: callbacks and marks
function post_message_to_js( $json ) {
	$GLOBALS['msgs'][] = $json;
	$m = json_decode( $json, true );
	if ( isset( $m['memMark'] ) ) {
		$GLOBALS['ran'][] = 'mark:' . $m['memMark'][0];
	}
	return isset( $m['probeMem'] ) ? json_encode( array( 'wasm' => 1048576 ) ) : '1';
}
require $wpinc . '/plugin.php';
$_SERVER['HTTP_X_MEM_TRACE'] = 'hooks' === $mode ? 'hooks' : '1';
require __DIR__ . '/../php/mem-trace.php';

class TClass {
	public static function b() { $GLOBALS['ran'][] = 'cb:TClass::b'; }
}
class TObj {
	public function c() { $GLOBALS['ran'][] = 'cb:TObj::c'; }
}
function tfn_a() { $GLOBALS['ran'][] = 'cb:tfn_a'; }
add_action( 'init', 'tfn_a', 0 );
add_action( 'init', array( 'TClass', 'b' ), 5 );
add_action( 'init', function () { $GLOBALS['ran'][] = 'cb:closure'; }, 10 );
add_action( 'init', array( new TObj(), 'c' ), 10 );
// Adjacent priority: a mark placed one priority late would land after this callback.
function tfn_11() { $GLOBALS['ran'][] = 'cb:tfn_11'; }
add_action( 'init', 'tfn_11', 11 );

// A fake WooCommerce file, so the subtree count has something to count.
$tmp = sys_get_temp_dir() . '/memtrace-' . getmypid() . '/plugins/woocommerce/src/Blocks';
@mkdir( $tmp, 0700, true );
file_put_contents( $tmp . '/Fake.php', "<?php\n" );
require $tmp . '/Fake.php';

do_action( 'muplugins_loaded' );
do_action( 'plugin_loaded', '/srv/wp-content/plugins/woocommerce/woocommerce.php' );
do_action( 'plugin_loaded', '/srv/wp-content/plugins/hello.php' );
do_action( 'init', 'SECRET-VALUE-504' );

$marks = array();
foreach ( $GLOBALS['msgs'] as $j ) {
	$m = json_decode( $j, true );
	if ( isset( $m['memMark'] ) ) {
		$marks[ $m['memMark'][0] ][] = $m['memMark'];
	}
}
$secret = false;
foreach ( $GLOBALS['msgs'] as $j ) {
	$secret = $secret || false !== strpos( $j, 'SECRET-VALUE-504' );
}
check( ! $secret, "$mode: a value passed to the hook never reaches a message" );

if ( 'hooks' === $mode ) {
	foreach ( array( 'p:init@0', 'p:init@5', 'p:init@10' ) as $l ) {
		check( isset( $marks[ $l ] ) && 1 === count( $marks[ $l ] ), "$l marked exactly once" );
	}
	$pos = array_flip( $GLOBALS['ran'] );
	check( isset( $pos['cb:tfn_a'], $pos['mark:p:init@0'] ) && $pos['cb:tfn_a'] < $pos['mark:p:init@0'], 'p:init@0 comes after its callback' );
	check( isset( $pos['mark:p:init@0'], $pos['cb:TClass::b'] ) && $pos['mark:p:init@0'] < $pos['cb:TClass::b'], 'p:init@0 comes before the next priority' );
	check( isset( $pos['cb:TClass::b'], $pos['mark:p:init@5'] ) && $pos['cb:TClass::b'] < $pos['mark:p:init@5'], 'p:init@5 comes after its callback' );
	check( isset( $pos['cb:TObj::c'], $pos['cb:closure'], $pos['mark:p:init@10'] ) && max( $pos['cb:TObj::c'], $pos['cb:closure'] ) < $pos['mark:p:init@10'], 'p:init@10 comes after both its callbacks' );
	check( isset( $pos['mark:p:init@10'], $pos['cb:tfn_11'] ) && $pos['mark:p:init@10'] < $pos['cb:tfn_11'], 'p:init@10 comes before the adjacent priority 11' );
	check( isset( $marks['p:init@11'] ) && 1 === count( $marks['p:init@11'] ), 'p:init@11 marked exactly once' );
	check( isset( $pos['mark:init_start'], $pos['mark:init_end'], $pos['mark:p:init@10'] ) && $pos['mark:init_start'] < $pos['cb:tfn_a'] && $pos['mark:p:init@10'] < $pos['mark:init_end'], 'the sweep sits inside init_start and init_end' );
	$e5  = $marks['p:init@5'][0][6];
	$e10 = $marks['p:init@10'][0][6];
	check( array( 'n' => 1, 'woo' => 0, 'o' => array( 'TClass::b' ) ) === $e5, 'p:init@5 names its owner, and only that' );
	check( 2 === $e10['n'] && in_array( 'TObj::c', $e10['o'], true ) && in_array( 'closure@' . basename( __FILE__ ), $e10['o'], true ), 'p:init@10 names a method and a closure by file name' );
	check( ! isset( $marks['p:init@' . PHP_INT_MIN] ) && ! isset( $marks['p:init@' . PHP_INT_MAX] ), "the trace's own priorities are not swept" );
	check( isset( $marks['inc:woocommerce'], $marks['inc:hello'], $marks['mu_done'] ), 'inc:<slug> per plugin and mu_done' );
	check( 7 === count( $marks['p:init@5'][0] ) && array( 'src/Blocks' => 1 ) === $marks['p:init@5'][0][5], 'hooks marks carry the WooCommerce subtree counts' );
} else {
	$extra = false;
	$shape = true;
	foreach ( $marks as $name => $list ) {
		$extra = $extra || 0 === strpos( $name, 'p:' ) || 0 === strpos( $name, 'inc:' ) || 'mu_done' === $name;
		foreach ( $list as $mk ) {
			$shape = $shape && 5 === count( $mk );
		}
	}
	check( ! $extra, 'default: no hooks-mode mark' );
	check( $shape && isset( $marks['init_start'], $marks['init_end'] ), 'default: every mark keeps its 5 fields' );
}
@unlink( $tmp . '/Fake.php' );
exit( $fails ? 1 : 0 );
