<?php
/**
 * Plugin Name: c1 mail
 * Description: wp_mail() through the Worker and its Cloudflare Email Service binding (issue #104).
 *
 * The container has no mail transport. WordPress would call
 * /usr/sbin/sendmail, which is not there, and the mail was lost with no error
 * a WordPress caller could see. This filter answers wp_mail() itself
 * (pre_wp_mail, WordPress 5.7 and later): it sends one message to the Worker
 * through the outbound path (http://worker.internal/, 00-worker-call.php),
 * and the Worker sends it with its send_email binding. The Worker decides the
 * sender (MAIL_FROM); this file only maps the wp_mail() arguments.
 *
 * A send is a success only when the Worker answers ok: true. Anything else
 * (an error code, no answer, mail not set up) returns false to wp_mail() and
 * fires wp_mail_failed, as core does when PHPMailer fails. Each send writes
 * one line to /tmp/c1-mail.log (time, result, recipient domains, a hash of the
 * subject, the code): no address and no body. /_stats.php?what=mail reads it.
 */

define( 'C1_MAIL_LOG', getenv( 'C1_MAIL_LOG' ) ? getenv( 'C1_MAIL_LOG' ) : '/tmp/c1-mail.log' ); // the test sets another path
const C1_MAIL_MAX_RECIPIENTS  = 50;               // to + cc + bcc (Email Service limit)
const C1_MAIL_MAX_ATTACHMENTS = 32;
const C1_MAIL_MAX_BYTES       = 25 * 1024 * 1024; // the whole message, attachments included

add_filter( 'pre_wp_mail', 'c1_mail_pre_wp_mail', 10, 2 );

function c1_mail_pre_wp_mail( $return, $atts ) {
	if ( null !== $return ) {
		return $return; // another filter answered first
	}
	$msg = c1_mail_message( $atts );
	if ( is_wp_error( $msg ) ) {
		return c1_mail_failed( $atts, $msg->get_error_code(), $msg->get_error_message(), array() );
	}
	$raw   = skyphusion_worker_call( wp_json_encode( array( 'mail' => $msg ) ) );
	$reply = json_decode( (string) $raw, true );
	if ( is_array( $reply ) && true === ( $reply['ok'] ?? null ) ) {
		c1_mail_log( 'sent', $msg, '' );
		return true;
	}
	if ( ! is_array( $reply ) ) {
		return c1_mail_failed( $atts, 'c1_mail_no_answer', 'no answer from the Worker (http://worker.internal/)', $msg );
	}
	return c1_mail_failed( $atts, (string) ( $reply['code'] ?? 'c1_mail_error' ), (string) ( $reply['error'] ?? 'the Worker did not send the mail' ), $msg );
}

// The message for the Worker: {to, cc, bcc, from {email, name}, replyTo,
// subject, text, html, attachments [{filename, type, content (base64)}]}.
function c1_mail_message( $atts ) {
	$to      = c1_mail_addresses( $atts['to'] ?? array() );
	$cc      = array();
	$bcc     = array();
	$reply   = '';
	$from    = '';
	$ctype   = '';
	$headers = $atts['headers'] ?? array();
	if ( ! is_array( $headers ) ) {
		$headers = explode( "\n", str_replace( "\r\n", "\n", (string) $headers ) );
	}
	foreach ( $headers as $h ) {
		if ( false === strpos( (string) $h, ':' ) ) {
			continue;
		}
		list( $name, $value ) = explode( ':', (string) $h, 2 );
		$value                = trim( $value );
		switch ( strtolower( trim( $name ) ) ) {
			case 'cc':
				$cc = array_merge( $cc, c1_mail_addresses( $value ) );
				break;
			case 'bcc':
				$bcc = array_merge( $bcc, c1_mail_addresses( $value ) );
				break;
			case 'reply-to':
				$reply = $value;
				break;
			case 'from':
				$from = $value;
				break;
			case 'content-type':
				$ctype = strtolower( trim( explode( ';', $value )[0] ) );
				break;
		}
	}
	if ( ! $to ) {
		return new WP_Error( 'c1_mail_no_recipient', 'no valid recipient' );
	}
	if ( count( $to ) + count( $cc ) + count( $bcc ) > C1_MAIL_MAX_RECIPIENTS ) {
		return new WP_Error( 'c1_mail_too_many_recipients', 'more than ' . C1_MAIL_MAX_RECIPIENTS . ' recipients (to, cc and bcc together)' );
	}
	// The sender as WordPress would set it; the Worker sends from MAIL_FROM and
	// keeps this one as the Reply-To when it differs.
	$f          = c1_mail_address( $from );
	$from_email = apply_filters( 'wp_mail_from', $f['email'] ? $f['email'] : 'wordpress@' . c1_mail_site_host() );
	$from_name  = apply_filters( 'wp_mail_from_name', $f['name'] ? $f['name'] : 'WordPress' );
	$ctype      = apply_filters( 'wp_mail_content_type', $ctype ? $ctype : 'text/plain' );
	$message    = (string) ( $atts['message'] ?? '' );
	$msg        = array(
		'to'      => $to,
		'subject' => (string) ( $atts['subject'] ?? '' ),
		'from'    => array(
			'email' => (string) $from_email,
			'name'  => (string) $from_name,
		),
	);
	if ( $cc ) {
		$msg['cc'] = $cc;
	}
	if ( $bcc ) {
		$msg['bcc'] = $bcc;
	}
	if ( $reply ) {
		$r = c1_mail_address( $reply );
		if ( $r['email'] ) {
			$msg['replyTo'] = $r;
		}
	}
	if ( 'text/html' === $ctype ) {
		$msg['html'] = $message;
		$msg['text'] = trim( wp_strip_all_tags( $message ) ); // both parts help delivery
	} else {
		$msg['text'] = $message;
	}
	$files = $atts['attachments'] ?? array();
	if ( ! is_array( $files ) ) {
		$files = array_filter( explode( "\n", str_replace( "\r\n", "\n", (string) $files ) ) );
	}
	$files = array_values( array_filter( $files ) );
	if ( count( $files ) > C1_MAIL_MAX_ATTACHMENTS ) {
		return new WP_Error( 'c1_mail_too_many_attachments', 'more than ' . C1_MAIL_MAX_ATTACHMENTS . ' attachments' );
	}
	$size = strlen( $message );
	foreach ( $files as $path ) {
		if ( ! is_readable( $path ) ) {
			return new WP_Error( 'c1_mail_attachment_unreadable', 'an attachment cannot be read: ' . basename( (string) $path ) );
		}
		$size += filesize( $path );
		if ( $size > C1_MAIL_MAX_BYTES ) {
			return new WP_Error( 'c1_mail_too_large', 'the message is larger than 25 MiB' );
		}
		$type                   = function_exists( 'mime_content_type' ) ? mime_content_type( $path ) : '';
		$msg['attachments'][] = array(
			'filename' => basename( $path ),
			'type'     => $type ? $type : 'application/octet-stream',
			'content'  => base64_encode( file_get_contents( $path ) ),
		);
	}
	return $msg;
}

// "a@x.org, Name <b@y.org>" (or an array of them) -> the addresses only.
function c1_mail_addresses( $list ) {
	$out = array();
	foreach ( (array) ( is_array( $list ) ? $list : explode( ',', (string) $list ) ) as $one ) {
		$a = c1_mail_address( (string) $one );
		if ( $a['email'] ) {
			$out[] = $a['email'];
		}
	}
	return $out;
}

// "Name <a@x.org>" or "a@x.org" -> {email, name}; email '' when not valid.
function c1_mail_address( $s ) {
	$s = trim( (string) $s );
	$name = '';
	if ( preg_match( '/^(.*)<([^>]+)>\s*$/', $s, $m ) ) {
		$name = trim( trim( $m[1] ), '"' );
		$s    = trim( $m[2] );
	}
	$email = filter_var( $s, FILTER_VALIDATE_EMAIL ) ? $s : '';
	return array(
		'email' => $email,
		'name'  => $name,
	);
}

function c1_mail_site_host() {
	$h = function_exists( 'network_home_url' ) ? wp_parse_url( network_home_url(), PHP_URL_HOST ) : '';
	return $h ? strtolower( preg_replace( '/^www\./', '', $h ) ) : 'localhost';
}

// Fire wp_mail_failed (core's contract) and log; returns false for wp_mail().
function c1_mail_failed( $atts, $code, $error, $msg ) {
	$data = array(
		'to'          => $atts['to'] ?? '',
		'subject'     => $atts['subject'] ?? '',
		'message'     => $atts['message'] ?? '',
		'headers'     => $atts['headers'] ?? array(),
		'attachments' => $atts['attachments'] ?? array(),
		'c1_code'     => $code,
	);
	do_action( 'wp_mail_failed', new WP_Error( 'wp_mail_failed', $code . ': ' . $error, $data ) );
	c1_mail_log( 'failed', $msg ? $msg : array( 'to' => c1_mail_addresses( $atts['to'] ?? array() ), 'subject' => (string) ( $atts['subject'] ?? '' ) ), $code );
	return false;
}

function c1_mail_log( $result, $msg, $code ) {
	$domains = array();
	foreach ( array_merge( (array) ( $msg['to'] ?? array() ), (array) ( $msg['cc'] ?? array() ), (array) ( $msg['bcc'] ?? array() ) ) as $a ) {
		$domains[ strtolower( substr( strrchr( (string) $a, '@' ), 1 ) ) ] = true;
	}
	$ok = @file_put_contents(
		C1_MAIL_LOG,
		sprintf( "%.3f %s %s %s %s\n", microtime( true ), $result, implode( ',', array_keys( $domains ) ) ?: '-', substr( md5( (string) ( $msg['subject'] ?? '' ) ), 0, 8 ), $code ? $code : '-' ),
		FILE_APPEND | LOCK_EX
	);
	// A log that cannot be written is said once, not lost in silence (issue
	// #104: a root-owned log took every line of the PHP-FPM children).
	static $said = false;
	if ( false === $ok && ! $said ) {
		$said = true;
		error_log( 'c1-mail: cannot write ' . C1_MAIL_LOG . ': the mail log loses its lines (the counters in /_store-info still count)' );
	}
}
