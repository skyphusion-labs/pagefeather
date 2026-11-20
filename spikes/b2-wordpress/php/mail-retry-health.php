<?php
/**
 * Plugin Name: Dead-lettered email in Site Health (#1057)
 * Description: A wp_mail send the platform rejected is retried with backoff from the site's durable store
 *   (email-retry.mjs). One that still fails after the last try is dead-lettered: kept, with an email-dead event.
 *   This Site Health test shows how many are dead, so an order email or a password reset that never went out
 *   is seen, not silent. The count comes from the Worker (the mailDead bridge op).
 */

if ( ! function_exists( 'post_message_to_js' ) ) {
	return;
}

if ( ! function_exists( 'skyphusion_mail_dead_test' ) ) {
	/** The Site Health result for the dead-lettered emails. */
	function skyphusion_mail_dead_test() {
		$reply = json_decode( (string) post_message_to_js( json_encode( array( 'mailDead' => 1 ) ) ), true );
		$base  = array(
			'test'  => 'pagefeather_mail_dead',
			'badge' => array( 'label' => __( 'Email' ), 'color' => 'blue' ),
		);
		if ( ! is_array( $reply ) || empty( $reply['ok'] ) || ! isset( $reply['dead'] ) ) {
			return $base + array(
				'status'      => 'recommended',
				'label'       => __( 'The count of undelivered emails could not be read' ),
				'description' => '<p>' . esc_html( is_array( $reply ) && isset( $reply['why'] ) ? (string) $reply['why'] : __( 'No answer from the Worker.' ) ) . '</p>',
			);
		}
		$n = (int) $reply['dead'];
		if ( 0 === $n ) {
			return $base + array(
				'status'      => 'good',
				'label'       => __( 'No email has failed for good' ),
				'description' => '<p>' . __( 'Emails the platform refused were retried, and none ran out of tries.' ) . '</p>',
			);
		}
		return $base + array(
			'status'      => 'critical',
			/* translators: %d: the number of emails */
			'label'       => sprintf( _n( '%d email was never delivered', '%d emails were never delivered', $n ), $n ),
			'description' => '<p>' . __( 'Each was refused by the email service on every try (the first send and 6 retries over about 4 hours). Order emails and password resets among them did not reach the customer. Each one is in the logs as an email-dead event.' ) . '</p>',
		);
	}
}

add_filter(
	'site_status_tests',
	static function ( $tests ) {
		$tests['direct']['pagefeather_mail_dead'] = array(
			'label' => __( 'Undelivered email' ),
			'test'  => 'skyphusion_mail_dead_test',
		);
		return $tests;
	}
);
