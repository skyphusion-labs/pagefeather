<?php
/**
 * #1057: Site Health shows the dead-lettered emails (php/mail-retry-health.php).
 * Run: php spikes/b2-wordpress/tests/mail-retry-health-test.php
 */
$fails = 0;
function ok( $label, $cond ) {
	global $fails;
	echo ( $cond ? 'PASS ' : 'FAIL ' ) . $label . "\n";
	if ( ! $cond ) {
		$fails++;
	}
}
$GLOBALS['filters'] = array();
function add_filter( $tag, $cb ) { $GLOBALS['filters'][ $tag ] = $cb; return true; }
function __( $t ) { return $t; }
function esc_html( $t ) { return htmlspecialchars( (string) $t, ENT_QUOTES ); }
function _n( $s, $p, $n ) { return 1 === $n ? $s : $p; }
$GLOBALS['reply'] = '{"ok":true,"dead":0}';
$GLOBALS['sent'] = array();
function post_message_to_js( $m ) { $GLOBALS['sent'][] = $m; return $GLOBALS['reply']; }

ok( 'build.sh copies the mu-plugin', false !== strpos( file_get_contents( dirname( __DIR__ ) . '/build.sh' ), 'php/mail-retry-health.php' ) );
require dirname( __DIR__ ) . '/php/mail-retry-health.php';
ok( 'it registers a Site Health direct test', isset( $GLOBALS['filters']['site_status_tests'] ) );
$tests = call_user_func( $GLOBALS['filters']['site_status_tests'], array( 'direct' => array() ) );
ok( 'the test is pagefeather_mail_dead', isset( $tests['direct']['pagefeather_mail_dead']['test'] ) );
$run = $tests['direct']['pagefeather_mail_dead']['test'];

$r = call_user_func( $run );
ok( 'it asks the Worker for the count (mailDead)', array( '{"mailDead":1}' ) === $GLOBALS['sent'] );
ok( 'no dead mail: good', 'good' === $r['status'] && 'pagefeather_mail_dead' === $r['test'] );

$GLOBALS['reply'] = '{"ok":true,"dead":3}';
$r = call_user_func( $run );
ok( 'dead mail: critical, with the count', 'critical' === $r['status'] && false !== strpos( $r['label'], '3' ) );

$GLOBALS['reply'] = '{"ok":false,"why":"no durable mail store"}';
$r = call_user_func( $run );
ok( 'unknown: recommended (never a silent good)', 'recommended' === $r['status'] );

$GLOBALS['reply'] = 'not json';
$r = call_user_func( $run );
ok( 'a bad answer: recommended', 'recommended' === $r['status'] );

echo $fails . " failing\n";
exit( $fails ? 1 : 0 );
