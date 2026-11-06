<?php
// Test of php/c1-mail.php (issue #104): the wp_mail() mapping and the loud
// failure, with the few WordPress functions it uses stubbed and a fake
// skyphusion_worker_call() that records the payload and returns a set reply.
// Run: php spikes/c1-woo-container/tests/mail-test.php [another c1-mail.php]
// Exit 0 only when every check passes.
$log = tempnam( sys_get_temp_dir(), 'c1mail' );
putenv( 'C1_MAIL_LOG=' . $log );

class WP_Error {
	public $code, $message, $data;
	function __construct( $code = '', $message = '', $data = '' ) { $this->code = $code; $this->message = $message; $this->data = $data; }
	function get_error_code() { return $this->code; }
	function get_error_message() { return $this->message; }
	function get_error_data() { return $this->data; }
}
$GLOBALS['filters'] = array();
$GLOBALS['actions'] = array();
function add_filter( $tag, $fn, $prio = 10, $args = 1 ) { $GLOBALS['filters'][ $tag ][] = $fn; }
function apply_filters( $tag, $value ) { return $value; }
function do_action( $tag, $arg ) { $GLOBALS['actions'][] = array( $tag, $arg ); }
function is_wp_error( $x ) { return $x instanceof WP_Error; }
function wp_json_encode( $x ) { return json_encode( $x ); }
function wp_strip_all_tags( $s ) { return strip_tags( $s ); }
function wp_parse_url( $u, $c = -1 ) { return parse_url( $u, $c ); }
function network_home_url() { return 'https://shop.example.workers.dev/'; }
$GLOBALS['reply'] = '';
$GLOBALS['sent'] = array();
function skyphusion_worker_call( $json ) { $GLOBALS['sent'][] = json_decode( $json, true ); return $GLOBALS['reply']; }

require $argv[1] ?? __DIR__ . '/../php/c1-mail.php';

$fails = 0;
function check( $name, $ok, $extra = '' ) {
	global $fails;
	if ( ! $ok ) { $fails++; }
	echo ( $ok ? 'PASS ' : 'FAIL ' ) . $name . ( $extra ? "  $extra" : '' ) . "\n";
}
function run( $atts, $reply ) {
	$GLOBALS['reply'] = $reply;
	$GLOBALS['sent'] = array();
	$GLOBALS['actions'] = array();
	return c1_mail_pre_wp_mail( null, $atts );
}
$ok = json_encode( array( 'ok' => true, 'messageId' => 'm1' ) );
// The c1_code of the first wp_mail_failed, or '' when none fired.
function failed_code() {
	$a = $GLOBALS['actions'][0][1] ?? null;
	return $a instanceof WP_Error ? (string) ( $a->get_error_data()['c1_code'] ?? '' ) : '';
}

check( 'the filter is on pre_wp_mail', isset( $GLOBALS['filters']['pre_wp_mail'] ) );

// 1. Plain text to one recipient: one call, text only, true.
$r = run( array( 'to' => 'Ann <ann@example.org>', 'subject' => 'Hi', 'message' => 'Hello', 'headers' => '', 'attachments' => array() ), $ok );
$m = $GLOBALS['sent'][0]['mail'] ?? array();
check( 'plain text: true and one call', true === $r && 1 === count( $GLOBALS['sent'] ) );
check( 'plain text: to, subject, text, no html', array( 'ann@example.org' ) === $m['to'] && 'Hi' === $m['subject'] && 'Hello' === $m['text'] && ! isset( $m['html'] ) );
check( 'plain text: the WordPress default From', 'wordpress@shop.example.workers.dev' === $m['from']['email'] && 'WordPress' === $m['from']['name'] );

// 2. Headers: Cc, Bcc, Reply-To, From, HTML.
$r = run( array( 'to' => array( 'a@example.org', 'b@example.org' ), 'subject' => 'Order', 'message' => '<p>Your <b>order</b></p>',
	'headers' => "From: Shop <shop@other.org>\r\nCc: c@example.org\r\nBcc: Dee <d@example.org>, e@example.org\r\nReply-To: help@other.org\r\nContent-Type: text/html; charset=UTF-8", 'attachments' => array() ), $ok );
$m = $GLOBALS['sent'][0]['mail'] ?? array();
check( 'headers: to, cc, bcc', array( 'a@example.org', 'b@example.org' ) === $m['to'] && array( 'c@example.org' ) === $m['cc'] && array( 'd@example.org', 'e@example.org' ) === $m['bcc'] );
check( 'headers: From and Reply-To', 'shop@other.org' === $m['from']['email'] && 'Shop' === $m['from']['name'] && 'help@other.org' === $m['replyTo']['email'] );
check( 'headers: HTML with a text part', '<p>Your <b>order</b></p>' === $m['html'] && 'Your order' === $m['text'] );

// 3. The Worker refuses: false, wp_mail_failed with the code, a log line.
$r = run( array( 'to' => 'ann@example.org', 'subject' => 'S', 'message' => 'x' ), json_encode( array( 'ok' => false, 'code' => 'E_SENDER_NOT_VERIFIED', 'error' => 'no' ) ) );
$a = $GLOBALS['actions'][0] ?? null;
check( 'an error reply: false', false === $r );
check( 'an error reply: wp_mail_failed with the code', $a && 'wp_mail_failed' === $a[0] && 'E_SENDER_NOT_VERIFIED' === failed_code() );

// 4. No answer, and an answer that is not exactly ok: true.
$r = run( array( 'to' => 'ann@example.org', 'subject' => 'S', 'message' => 'x' ), '' );
check( 'no answer: false, c1_mail_no_answer', false === $r && 'c1_mail_no_answer' === failed_code() );
$r = run( array( 'to' => 'ann@example.org', 'subject' => 'S', 'message' => 'x' ), json_encode( array( 'ok' => 'yes' ) ) );
check( 'ok "yes" is not ok true: false', false === $r );
$r = run( array( 'to' => 'ann@example.org', 'subject' => 'S', 'message' => 'x' ), json_encode( array( 'ok' => false, 'code' => 'c1_mail_not_configured', 'error' => 'not set up' ) ) );
check( 'not configured: false, the code', false === $r && 'c1_mail_not_configured' === failed_code() );

// 5. Refused before the Worker: no recipient, more than 50, an unreadable attachment.
$many = array();
for ( $i = 0; $i < 51; $i++ ) { $many[] = "u$i@example.org"; }
$r = run( array( 'to' => $many, 'subject' => 'S', 'message' => 'x' ), $ok );
check( '51 recipients: false, no call', false === $r && 0 === count( $GLOBALS['sent'] ) && 'c1_mail_too_many_recipients' === failed_code() );
$r = run( array( 'to' => 'not an address', 'subject' => 'S', 'message' => 'x' ), $ok );
check( 'no valid recipient: false, no call', false === $r && 0 === count( $GLOBALS['sent'] ) );
$r = run( array( 'to' => 'ann@example.org', 'subject' => 'S', 'message' => 'x', 'attachments' => array( '/no/such/file.pdf' ) ), $ok );
check( 'unreadable attachment: false, no call', false === $r && 0 === count( $GLOBALS['sent'] ) );

// 6. An attachment goes as base64 with its name.
$f = tempnam( sys_get_temp_dir(), 'c1att' );
file_put_contents( $f, "a,b\n1,2\n" );
$r = run( array( 'to' => 'ann@example.org', 'subject' => 'S', 'message' => 'x', 'attachments' => array( $f ) ), $ok );
$att = $GLOBALS['sent'][0]['mail']['attachments'][0] ?? array();
check( 'attachment: base64 and name', true === $r && "a,b\n1,2\n" === base64_decode( $att['content'] ?? '' ) && basename( $f ) === ( $att['filename'] ?? '' ) );
unlink( $f );

// 7. Another filter answered first: passed through, no call.
$GLOBALS['sent'] = array();
check( 'an earlier answer passes through', false === c1_mail_pre_wp_mail( false, array( 'to' => 'ann@example.org' ) ) && 0 === count( $GLOBALS['sent'] ) );

// 8. The log: one line a send, no address, no body.
$lines = file( $log, FILE_IGNORE_NEW_LINES );
check( 'the log has a line for each send', count( $lines ) >= 9, count( $lines ) . ' lines' );
check( 'the log holds no address and no body', ! preg_grep( '/@|Hello|order/', $lines ) );
check( 'the log names the result and the code', (bool) preg_grep( '/ failed example\.org [0-9a-f]{8} E_SENDER_NOT_VERIFIED$/', $lines ) && (bool) preg_grep( '/ sent example\.org [0-9a-f]{8} -$/', $lines ) );
unlink( $log );

echo $fails ? "$fails failing check(s)\n" : "all PASS\n";
exit( $fails ? 1 : 0 );
