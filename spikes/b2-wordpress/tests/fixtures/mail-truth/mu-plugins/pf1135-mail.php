<?php
/**
 * Plugin Name: #1135 test fixture: what WordPress hears from a cron-tick wp_mail (TEST BUILDS ONLY)
 * Imported only by tests/mail-truth-e2e.sh; never part of a site build. With the spike token:
 *   ?pf1135=schedule&n=N  schedules the single WP-Cron event pf1135_send (due now) for the Nth send.
 *   ?pf1135=now           wp_mail on the request path to an example.com recipient, answered at once.
 *   ?pf1135=read          answers the recorded results: per send, what wp_mail returned and any wp_mail_failed message.
 */
add_action(
	'pf1135_send',
	static function ( $n ) {
		$GLOBALS['pf1135_failed'] = array();
		// Send 3 goes to an undeliverable domain (#198); send 4 to an address outside the site's MAIL_ALLOWED_TO.
		$to  = 3 === (int) $n ? 'pf1135-test@example.com' : ( 4 === (int) $n ? 'pf1135-other@skyphusion.org' : 'pf1135-test@skyphusion.org' ); // 4: outside MAIL_ALLOWED_TO
		$r   = wp_mail( $to, 'pf1135 send ' . (int) $n, 'body' );
		$all = get_option( 'pf1135_results', array() );
		$all[ (int) $n ] = array( 'returned' => $r, 'failed' => $GLOBALS['pf1135_failed'] );
		update_option( 'pf1135_results', $all, false );
	},
	10,
	1
);
add_action(
	'wp_mail_failed',
	static function ( $e ) {
		$GLOBALS['pf1135_failed'][] = is_wp_error( $e ) ? $e->get_error_message() : 'not a WP_Error';
	}
);
add_action(
	'init',
	static function () {
		if ( ! isset( $_GET['pf1135'] ) ) {
			return;
		}
		$token = getenv( 'SPIKE_TOKEN' ) ?: ( defined( 'SPIKE_TOKEN' ) ? SPIKE_TOKEN : '' );
		$given = isset( $_SERVER['HTTP_X_SPIKE_TOKEN'] ) ? (string) $_SERVER['HTTP_X_SPIKE_TOKEN'] : '';
		if ( '' === $given || ( '' !== $token && ! hash_equals( $token, $given ) ) ) {
			return;
		}
		if ( 'now' === $_GET['pf1135'] ) {
			// #1135: on the REQUEST path (no cron tick), to an undeliverable domain: the pre-check answers inside wp_mail.
			$GLOBALS['pf1135_failed'] = array();
			$r = wp_mail( 'pf1135-now@example.com', 'pf1135 now', 'body' );
			wp_send_json( array( 'returned' => $r, 'failed' => $GLOBALS['pf1135_failed'] ) );
		}
		if ( 'schedule' === $_GET['pf1135'] ) {
			$n = isset( $_GET['n'] ) ? (int) $_GET['n'] : 1;
			wp_schedule_single_event( time() - 600, 'pf1135_send', array( $n ) );
			wp_send_json( array( 'scheduled' => $n ) );
		}
		wp_send_json( (object) get_option( 'pf1135_results', array() ) );
	}
);
