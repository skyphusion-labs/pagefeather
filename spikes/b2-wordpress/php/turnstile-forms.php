<?php
/**
 * Plugin Name: Turnstile forms (b-dosql)
 * Description: A Cloudflare Turnstile bot challenge on the three WordPress forms
 *   that get abused: wp-login.php (credential stuffing), the comment form (spam),
 *   and WooCommerce checkout (card testing and fake orders). The widget ships in
 *   the page with the PUBLIC site key; the token is verified server side before the
 *   action proceeds. Verification runs in the Worker: PHP reads cf-turnstile-response
 *   from the form POST and sends it through the skyphusion_worker_call op bridge
 *   (turnstile op), the Worker calls https://challenges.cloudflare.com/turnstile/v0/siteverify
 *   with the secret, and PHP reads back only { success }. The secret
 *   (TURNSTILE_SECRET) stays in the Worker and never enters PHP, as the AI binding
 *   and the purge token do. The browser never calls siteverify. Issue #250.
 *
 *   Binding based, so no zone is needed and this works on a workers.dev host today,
 *   unlike the WAF (#245) and Access (#246) tracks.
 *
 *   Switches (written by index.js from the bindings):
 *   - SKYPHUSION_TURNSTILE          master on (TURNSTILE=off is the master off switch).
 *   - SKYPHUSION_TURNSTILE_SITEKEY  the public site key for the widget.
 *   - SKYPHUSION_TURNSTILE_LOGIN    the login form gate   (TURNSTILE_LOGIN=off).
 *   - SKYPHUSION_TURNSTILE_COMMENTS the comment form gate (TURNSTILE_COMMENTS=off).
 *   - SKYPHUSION_TURNSTILE_WOO      the checkout gate     (TURNSTILE_WOO=off).
 *   Each form is independent: one off leaves the others on, and the master off
 *   switch restores every form to its unprotected state.
 *
 * Fail closed. A missing or failed token rejects the action, which is the whole
 * point of a bot challenge. If the verifier itself is unreachable (a timeout or a
 * network failure, told apart from a bad token by the error field), the action is
 * still rejected unless the site opts in through the skyphusion_turnstile_failopen
 * filter, so an outage never silently drops the protection.
 */

if ( ! defined( 'SKYPHUSION_TURNSTILE' ) || ! SKYPHUSION_TURNSTILE || ! function_exists( 'skyphusion_worker_call' ) ) {
	return;
}

/** The public Turnstile site key, or '' when none was configured. */
if ( ! function_exists( 'skyphusion_turnstile_sitekey' ) ) {
	function skyphusion_turnstile_sitekey() {
		return defined( 'SKYPHUSION_TURNSTILE_SITEKEY' ) ? (string) SKYPHUSION_TURNSTILE_SITEKEY : '';
	}
}

/**
 * Render the Turnstile widget inside the current form. The api.js script is printed
 * once per page; the cf-turnstile div drops a hidden cf-turnstile-response input into
 * the enclosing form, which the browser submits with the rest of the fields.
 * data-action carries the Spin telemetry marker.
 */
if ( ! function_exists( 'skyphusion_turnstile_widget' ) ) {
	function skyphusion_turnstile_widget() {
		$key = skyphusion_turnstile_sitekey();
		if ( '' === $key ) {
			return;
		}
		static $script_printed = false;
		if ( ! $script_printed ) {
			echo '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>' . "\n";
			$script_printed = true;
		}
		echo '<div class="cf-turnstile" data-sitekey="' . esc_attr( $key ) . '" data-action="turnstile-spin-v1"></div>' . "\n";
	}
}

/** The submitted token from the form POST, or '' when absent. */
if ( ! function_exists( 'skyphusion_turnstile_token' ) ) {
	function skyphusion_turnstile_token() {
		if ( ! isset( $_POST['cf-turnstile-response'] ) ) {
			return '';
		}
		return sanitize_text_field( wp_unslash( $_POST['cf-turnstile-response'] ) );
	}
}

/** The client IP for siteverify (optional). The real client is CF-Connecting-IP. */
if ( ! function_exists( 'skyphusion_turnstile_remoteip' ) ) {
	function skyphusion_turnstile_remoteip() {
		$ip = '';
		if ( ! empty( $_SERVER['HTTP_CF_CONNECTING_IP'] ) ) {
			$ip = (string) $_SERVER['HTTP_CF_CONNECTING_IP'];
		} elseif ( ! empty( $_SERVER['REMOTE_ADDR'] ) ) {
			$ip = (string) $_SERVER['REMOTE_ADDR'];
		}
		$ip = filter_var( $ip, FILTER_VALIDATE_IP );
		return $ip ? $ip : '';
	}
}

/**
 * Verify a token through the Worker op bridge. Returns true only when Cloudflare
 * returns success:true. A missing or bad token is always rejected. The verifier
 * being unreachable (reply has an error field, which a genuinely bad token never
 * sets) is rejected too unless the site opts into fail-open.
 */
if ( ! function_exists( 'skyphusion_turnstile_verify' ) ) {
	function skyphusion_turnstile_verify( $token ) {
		$token = is_string( $token ) ? trim( $token ) : '';
		if ( '' === $token ) {
			return false;
		}
		$reply = json_decode(
			skyphusion_worker_call(
				wp_json_encode(
					array(
						'turnstile' => array(
							'token'    => $token,
							'remoteip' => skyphusion_turnstile_remoteip(),
						),
					)
				)
			),
			true
		);
		if ( is_array( $reply ) && isset( $reply['success'] ) && true === $reply['success'] ) {
			return true;
		}
		$infra = is_array( $reply ) && ! empty( $reply['error'] );
		if ( $infra && apply_filters( 'skyphusion_turnstile_failopen', false, $reply ) ) {
			return true;
		}
		return false;
	}
}

// ---- wp-login.php ----
if ( ! defined( 'SKYPHUSION_TURNSTILE_LOGIN' ) || SKYPHUSION_TURNSTILE_LOGIN ) {
	// The widget, below the password field on the login form.
	add_action( 'login_form', 'skyphusion_turnstile_widget' );

	/**
	 * Block the login POST on a missing or failed token. Runs after the
	 * username/password check (priority 30), and only on a real credential POST from
	 * the login form (the 'log' field), so cookie auth, application passwords and
	 * programmatic sign-in are untouched. A WP_Error stops authentication.
	 */
	if ( ! function_exists( 'skyphusion_turnstile_login_check' ) ) {
		function skyphusion_turnstile_login_check( $user, $username, $password ) {
			$method = isset( $_SERVER['REQUEST_METHOD'] ) ? strtoupper( (string) $_SERVER['REQUEST_METHOD'] ) : '';
			if ( 'POST' !== $method || ! isset( $_POST['log'] ) ) {
				return $user;
			}
			if ( ! skyphusion_turnstile_verify( skyphusion_turnstile_token() ) ) {
				return new WP_Error( 'turnstile_failed', __( 'Please complete the challenge to sign in.' ) );
			}
			return $user;
		}
	}
	add_filter( 'authenticate', 'skyphusion_turnstile_login_check', 30, 3 );
}

// ---- Comment form ----
if ( ! defined( 'SKYPHUSION_TURNSTILE_COMMENTS' ) || SKYPHUSION_TURNSTILE_COMMENTS ) {
	// The widget, before the submit button, for both logged-in and logged-out forms.
	add_action( 'comment_form_after_fields', 'skyphusion_turnstile_widget' );
	add_action( 'comment_form_logged_in_after', 'skyphusion_turnstile_widget' );

	/**
	 * Reject a comment on a missing or failed token. Skips the admin screens and
	 * pingbacks/trackbacks (which carry no widget). A failed token stops the comment
	 * with a 403 and a back link.
	 */
	if ( ! function_exists( 'skyphusion_turnstile_comment_check' ) ) {
		function skyphusion_turnstile_comment_check( $commentdata ) {
			if ( function_exists( 'is_admin' ) && is_admin() ) {
				return $commentdata;
			}
			$type = is_array( $commentdata ) && isset( $commentdata['comment_type'] ) ? $commentdata['comment_type'] : 'comment';
			if ( in_array( $type, array( 'pingback', 'trackback' ), true ) ) {
				return $commentdata;
			}
			if ( ! skyphusion_turnstile_verify( skyphusion_turnstile_token() ) ) {
				wp_die(
					esc_html__( 'Your comment could not be verified. Please go back and try again.' ),
					esc_html__( 'Comment blocked' ),
					array(
						'response'  => 403,
						'back_link' => true,
					)
				);
			}
			return $commentdata;
		}
	}
	add_filter( 'preprocess_comment', 'skyphusion_turnstile_comment_check' );
}

// ---- WooCommerce checkout ----
if ( ! defined( 'SKYPHUSION_TURNSTILE_WOO' ) || SKYPHUSION_TURNSTILE_WOO ) {
	// The widget, before the place-order button on the classic (shortcode) checkout.
	add_action( 'woocommerce_review_order_before_submit', 'skyphusion_turnstile_widget' );

	/**
	 * Fail order placement on a missing or failed token. woocommerce_checkout_process
	 * runs server side while the order is validated; a wc_add_notice error there stops
	 * the order before it is created. The classic shortcode checkout posts the widget
	 * field with the rest of the checkout form.
	 */
	if ( ! function_exists( 'skyphusion_turnstile_woo_check' ) ) {
		function skyphusion_turnstile_woo_check() {
			if ( ! function_exists( 'wc_add_notice' ) ) {
				return;
			}
			if ( ! skyphusion_turnstile_verify( skyphusion_turnstile_token() ) ) {
				wc_add_notice( __( 'Please complete the challenge to place your order.' ), 'error' );
			}
		}
	}
	add_action( 'woocommerce_checkout_process', 'skyphusion_turnstile_woo_check' );
}
