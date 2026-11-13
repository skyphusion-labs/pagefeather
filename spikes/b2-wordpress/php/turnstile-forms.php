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
 * still rejected, with its own message so the user knows to try again. The login and
 * both checkouts ALWAYS fail closed (#351). Only the comment form may opt into
 * letting an outage through, with the skyphusion_turnstile_failopen filter.
 *
 * On b-dosql the Worker verifies the token in front of the PHP object, before the
 * request reaches it, and the op only reads that answer (#351, turnstile.mjs).
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
 * Check a token through the Worker op bridge. Returns one of:
 *   'ok'           Cloudflare returned success:true for this token.
 *   'failed'       a missing, bad, spent or unverified token.
 *   'unavailable'  the verifier was unreachable (the reply has an error field, which a
 *                  genuinely bad token never sets).
 */
if ( ! function_exists( 'skyphusion_turnstile_result' ) ) {
	function skyphusion_turnstile_result( $token ) {
		$token = is_string( $token ) ? trim( $token ) : '';
		if ( '' === $token ) {
			return 'failed';
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
			return 'ok';
		}
		if ( ! is_array( $reply ) || ! empty( $reply['error'] ) ) {
			$GLOBALS['skyphusion_turnstile_last_reply'] = $reply;
			return 'unavailable';
		}
		return 'failed';
	}
}

/**
 * True only for a passed token. An outage passes only when $allow_failopen is true AND the
 * skyphusion_turnstile_failopen filter says so; only the comment form passes true (#351).
 */
if ( ! function_exists( 'skyphusion_turnstile_verify' ) ) {
	function skyphusion_turnstile_verify( $token, $allow_failopen = false ) {
		$result = skyphusion_turnstile_result( $token );
		if ( 'ok' === $result ) {
			return true;
		}
		if ( 'unavailable' === $result && $allow_failopen ) {
			$reply = isset( $GLOBALS['skyphusion_turnstile_last_reply'] ) ? $GLOBALS['skyphusion_turnstile_last_reply'] : null;
			return (bool) apply_filters( 'skyphusion_turnstile_failopen', false, $reply );
		}
		return false;
	}
}

/** The message for a verifier outage: the user did nothing wrong and can try again. */
if ( ! function_exists( 'skyphusion_turnstile_unavailable_message' ) ) {
	function skyphusion_turnstile_unavailable_message() {
		return __( 'We could not check the challenge just now. Please try again in a moment.' );
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
			$result = skyphusion_turnstile_result( skyphusion_turnstile_token() );
			if ( 'unavailable' === $result ) {
				return new WP_Error( 'turnstile_unavailable', skyphusion_turnstile_unavailable_message() );
			}
			if ( 'ok' !== $result ) {
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
			if ( ! skyphusion_turnstile_verify( skyphusion_turnstile_token(), true ) ) {
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
	// The widget, before the place-order button on the classic (shortcode) checkout. The block
	// checkout has its own widget and gate below.
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
			$result = skyphusion_turnstile_result( skyphusion_turnstile_token() );
			if ( 'unavailable' === $result ) {
				wc_add_notice( skyphusion_turnstile_unavailable_message(), 'error' );
			} elseif ( 'ok' !== $result ) {
				wc_add_notice( __( 'Please complete the challenge to place your order.' ), 'error' );
			}
		}
	}
	add_action( 'woocommerce_checkout_process', 'skyphusion_turnstile_woo_check' );

	// ---- WooCommerce block checkout (issue #308) ----
	//
	// The block checkout is a React app that posts to the Store API (/wc/store/v1/checkout). That
	// route never runs woocommerce_checkout_process, and a form field never reaches it, so the
	// classic gate above cannot see a block order. Three parts close that:
	//   1. The widget box and a script tag for php/turnstile-block-checkout.js are printed AFTER the
	//      checkout block, outside its React root, so React never removes the box. The script sends the token as
	//      Store API extension data: extensions["skyphusion-turnstile"].token.
	//   2. That namespace is registered on the checkout endpoint, so the field is in the schema.
	//   3. The gate runs inside the checkout route, so no other door (the batch route) skips it.

	if ( ! defined( 'SKYPHUSION_TURNSTILE_BLOCK_NS' ) ) {
		define( 'SKYPHUSION_TURNSTILE_BLOCK_NS', 'skyphusion-turnstile' );
	}

	/** The script URL. build.sh ships it as a static file (the PHP side drops every .js). */
	if ( ! function_exists( 'skyphusion_turnstile_block_script_url' ) ) {
		function skyphusion_turnstile_block_script_url() {
			$base = defined( 'WPMU_PLUGIN_URL' ) ? WPMU_PLUGIN_URL : content_url( 'mu-plugins' );
			return rtrim( (string) $base, '/' ) . '/turnstile-forms/block-checkout.js?ver=308.1';
		}
	}

	/**
	 * The widget box and the scripts, after the first woocommerce/checkout block on the page. Other
	 * blocks are returned unchanged. The order matters: the config, then block-checkout.js (a
	 * blocking script, so it has defined the onload callback), then api.js (async).
	 */
	if ( ! function_exists( 'skyphusion_turnstile_block_checkout_widget' ) ) {
		function skyphusion_turnstile_block_checkout_widget( $content, $block ) {
			if ( ! is_array( $block ) || ! isset( $block['blockName'] ) || 'woocommerce/checkout' !== $block['blockName'] ) {
				return $content;
			}
			$key = skyphusion_turnstile_sitekey();
			if ( '' === $key ) {
				return $content;
			}
			static $printed = false;
			if ( $printed ) {
				return $content;
			}
			$printed = true;
			$cfg     = array(
				'sitekey'   => $key,
				'namespace' => SKYPHUSION_TURNSTILE_BLOCK_NS,
				'action'    => 'turnstile-spin-v1',
			);
			return $content
				. "\n" . '<div id="skyphusion-turnstile-block" class="skyphusion-turnstile-block" style="margin:1em 0"></div>' . "\n"
				. '<script>window.skyphusionTurnstileBlock = ' . wp_json_encode( $cfg ) . ";</script>\n"
				. '<script src="' . esc_attr( skyphusion_turnstile_block_script_url() ) . '"></script>' . "\n"
				. '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&amp;onload=skyphusionTurnstileBlockReady" async defer></script>' . "\n";
		}
	}
	add_filter( 'render_block', 'skyphusion_turnstile_block_checkout_widget', 10, 2 );

	/** The token field in the checkout endpoint's extension schema. */
	if ( ! function_exists( 'skyphusion_turnstile_block_schema' ) ) {
		function skyphusion_turnstile_block_schema() {
			return array(
				'token' => array(
					'description' => 'Cloudflare Turnstile token for this checkout.',
					'type'        => array( 'string', 'null' ),
					'context'     => array(),
				),
			);
		}
	}
	if ( ! function_exists( 'skyphusion_turnstile_block_register' ) ) {
		function skyphusion_turnstile_block_register() {
			if ( ! function_exists( 'woocommerce_store_api_register_endpoint_data' ) ) {
				return;
			}
			woocommerce_store_api_register_endpoint_data(
				array(
					'endpoint'        => 'checkout',
					'namespace'       => SKYPHUSION_TURNSTILE_BLOCK_NS,
					'schema_callback' => 'skyphusion_turnstile_block_schema',
					'schema_type'     => ARRAY_A,
				)
			);
		}
	}
	add_action( 'woocommerce_blocks_loaded', 'skyphusion_turnstile_block_register' );

	/** The token from the Store API request, or '' when absent. */
	if ( ! function_exists( 'skyphusion_turnstile_block_token' ) ) {
		function skyphusion_turnstile_block_token( $request ) {
			$ext = is_object( $request ) && method_exists( $request, 'get_param' ) ? $request->get_param( 'extensions' ) : null;
			if ( ! is_array( $ext ) || ! isset( $ext[ SKYPHUSION_TURNSTILE_BLOCK_NS ] ) || ! is_array( $ext[ SKYPHUSION_TURNSTILE_BLOCK_NS ] ) ) {
				return '';
			}
			$token = isset( $ext[ SKYPHUSION_TURNSTILE_BLOCK_NS ]['token'] ) ? $ext[ SKYPHUSION_TURNSTILE_BLOCK_NS ]['token'] : '';
			return is_string( $token ) ? sanitize_text_field( $token ) : '';
		}
	}

	/**
	 * The Store API gate. woocommerce_store_api_checkout_update_order_from_request fires inside the
	 * checkout route, before stock is held and before payment. It also fires for the PUT and PATCH
	 * draft updates the checkout sends while the shopper types, which carry no token, so only the
	 * POST (place order) is gated. A RouteException becomes a 400 Store API error that the block
	 * shows as a notice; WooCommerce then releases held stock and coupons. A verifier outage is a 503
	 * skyphusion_turnstile_unavailable instead, which the shopper may retry. If that class is missing
	 * (an older WooCommerce), a plain exception still stops the order (a 500), so the gate never
	 * fails open.
	 */
	if ( ! function_exists( 'skyphusion_turnstile_store_api_check' ) ) {
		function skyphusion_turnstile_store_api_check( $order, $request ) {
			$method = is_object( $request ) && method_exists( $request, 'get_method' ) ? strtoupper( (string) $request->get_method() ) : '';
			if ( 'POST' !== $method ) {
				return;
			}
			$result = skyphusion_turnstile_result( skyphusion_turnstile_block_token( $request ) );
			if ( 'ok' === $result ) {
				return;
			}
			// An outage is a 503 the shopper may retry (the Worker adds Retry-After, #351); a failed
			// token is a 400. Neither places the order.
			$down    = 'unavailable' === $result;
			$message = $down ? skyphusion_turnstile_unavailable_message() : __( 'Please complete the challenge to place your order.' );
			$route   = '\Automattic\WooCommerce\StoreApi\Exceptions\RouteException';
			if ( class_exists( $route ) ) {
				throw new $route( $down ? 'skyphusion_turnstile_unavailable' : 'skyphusion_turnstile_failed', $message, $down ? 503 : 400 );
			}
			throw new Exception( $message );
		}
	}
	add_action( 'woocommerce_store_api_checkout_update_order_from_request', 'skyphusion_turnstile_store_api_check', 10, 2 );
}
