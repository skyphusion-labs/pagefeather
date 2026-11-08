<?php
/**
 * Plugin Name: PDF order invoices (b-dosql)
 * Description: Render a WooCommerce order to a real PDF invoice with the Cloudflare
 *   Browser Rendering binding, store it in R2, and give the customer and admin a
 *   download link. A paid plugin on normal hosting; here it is one binding and zero
 *   config. The PDF is made by the Worker, not in PHP: when an order reaches
 *   "processing", PHP collects the order into a structured invoice payload (store,
 *   billing, line items, totals) and sends a browserRender op to index.js through the
 *   post_message_to_js bridge. The Worker builds the HTML, renders it with env.BROWSER,
 *   stores the PDF under a private invoices/ prefix in the MEDIA bucket, and returns a
 *   signed, expiring download URL. The HTML template and the signing secret live in the
 *   Worker; PHP relays the URL and never holds the secret, exactly as ai-alt-text.php
 *   never holds the AI binding.
 *
 *   b-dosql only (SKYPHUSION_PDF_INVOICE, written by index.js when PHP_IN_DO and
 *   DB_IN_DO are on, the MEDIA binding and the BROWSER binding are present, and
 *   PDF_INVOICE is not "off"). PDF_INVOICE=off disables it.
 *
 * Fail safe. The order must always complete. Generation runs on the order-status
 * transition, never on the checkout critical path, and every step is wrapped: if the
 * render errors, is slow, or returns nothing, no link is stored and the order is
 * untouched. This plugin never throws and never changes the order result.
 */

if ( ! defined( 'SKYPHUSION_PDF_INVOICE' ) || ! SKYPHUSION_PDF_INVOICE || ! function_exists( 'skyphusion_worker_call' ) ) {
	return;
}

/** One line of the store's own address, from the WooCommerce store settings. */
if ( ! function_exists( 'skyphusion_pdf_invoice_store_lines' ) ) {
	function skyphusion_pdf_invoice_store_lines() {
		$lines = array();
		foreach ( array( 'woocommerce_store_address', 'woocommerce_store_address_2' ) as $opt ) {
			$v = get_option( $opt, '' );
			if ( is_string( $v ) && '' !== trim( $v ) ) {
				$lines[] = trim( $v );
			}
		}
		$city     = (string) get_option( 'woocommerce_store_city', '' );
		$postcode = (string) get_option( 'woocommerce_store_postcode', '' );
		$cityline = trim( $city . ( '' !== $postcode ? ' ' . $postcode : '' ) );
		if ( '' !== $cityline ) {
			$lines[] = $cityline;
		}
		return $lines;
	}
}

/**
 * Strip a WooCommerce money/HTML fragment down to plain text. The totals and line
 * subtotals come back wrapped in <span class="amount"> markup; the Worker escapes
 * everything it renders, so hand it plain text, not markup.
 *
 * @param string $html A WooCommerce-formatted price or label.
 * @return string Plain text.
 */
if ( ! function_exists( 'skyphusion_pdf_invoice_plain' ) ) {
	function skyphusion_pdf_invoice_plain( $html ) {
		$text = wp_strip_all_tags( (string) $html );
		$text = html_entity_decode( $text, ENT_QUOTES, 'UTF-8' );
		return trim( preg_replace( '/\s+/', ' ', $text ) );
	}
}

/**
 * Build the structured invoice payload from a WooCommerce order. No markup: the Worker
 * builds and escapes the HTML. Returns an associative array ready for wp_json_encode.
 *
 * @param WC_Order $order The order.
 * @return array The invoice payload.
 */
if ( ! function_exists( 'skyphusion_pdf_invoice_payload' ) ) {
	function skyphusion_pdf_invoice_payload( $order ) {
		$billing_lines = array();
		foreach ( array(
			$order->get_billing_company(),
			$order->get_billing_address_1(),
			$order->get_billing_address_2(),
			trim( $order->get_billing_city() . ' ' . $order->get_billing_state() . ' ' . $order->get_billing_postcode() ),
			$order->get_billing_country(),
		) as $line ) {
			$line = trim( (string) $line );
			if ( '' !== $line ) {
				$billing_lines[] = $line;
			}
		}

		$items = array();
		foreach ( $order->get_items() as $item ) {
			$items[] = array(
				'name'  => $item->get_name(),
				'qty'   => (string) $item->get_quantity(),
				'total' => skyphusion_pdf_invoice_plain( $order->get_formatted_line_subtotal( $item ) ),
			);
		}

		$totals = array();
		foreach ( (array) $order->get_order_item_totals() as $row ) {
			if ( is_array( $row ) && isset( $row['label'] ) ) {
				$totals[] = array(
					'label' => skyphusion_pdf_invoice_plain( $row['label'] ),
					'value' => isset( $row['value'] ) ? skyphusion_pdf_invoice_plain( $row['value'] ) : '',
				);
			}
		}

		$created = $order->get_date_created();

		return array(
			'number'  => $order->get_order_number(),
			'date'    => $created ? $created->date_i18n( get_option( 'date_format', 'Y-m-d' ) ) : '',
			'store'   => array(
				'name'  => get_bloginfo( 'name' ),
				'lines' => skyphusion_pdf_invoice_store_lines(),
				'email' => get_option( 'woocommerce_email_from_address', get_bloginfo( 'admin_email' ) ),
			),
			'billing' => array(
				'name'  => trim( $order->get_formatted_billing_full_name() ),
				'lines' => $billing_lines,
				'email' => $order->get_billing_email(),
				'phone' => $order->get_billing_phone(),
			),
			'items'   => $items,
			'totals'  => $totals,
			'note'    => __( 'Thank you for your order.', 'default' ),
		);
	}
}

/**
 * Generate and store the invoice PDF for an order, once. Asks the Worker to render and
 * store the PDF and to mint a signed download URL; stores the URL and R2 key as order
 * meta. Skips when a link already exists. Never throws.
 *
 * @param int  $order_id The order ID.
 * @param bool $force    Regenerate even if a link exists.
 * @return string|null The download URL, or null on any failure.
 */
if ( ! function_exists( 'skyphusion_pdf_invoice_generate' ) ) {
	function skyphusion_pdf_invoice_generate( $order_id, $force = false ) {
		try {
			if ( ! function_exists( 'wc_get_order' ) ) {
				return null;
			}
			$order = wc_get_order( $order_id );
			if ( ! $order instanceof WC_Order ) {
				return null;
			}
			if ( ! $force ) {
				$existing = $order->get_meta( '_skyphusion_invoice_url' );
				if ( is_string( $existing ) && '' !== $existing ) {
					return $existing;
				}
			}

			$reply = json_decode(
				skyphusion_worker_call(
					wp_json_encode(
						array(
							'browserRender' => array(
								'kind'    => 'invoice',
								'orderId' => (string) $order->get_id(),
								'invoice' => skyphusion_pdf_invoice_payload( $order ),
							),
						)
					)
				),
				true
			);
			if ( ! is_array( $reply ) || empty( $reply['url'] ) || ! is_string( $reply['url'] ) ) {
				return null; // Degraded render: store nothing, show nothing (fail safe).
			}

			$order->update_meta_data( '_skyphusion_invoice_url', $reply['url'] );
			if ( ! empty( $reply['key'] ) && is_string( $reply['key'] ) ) {
				$order->update_meta_data( '_skyphusion_invoice_key', $reply['key'] );
			}
			$order->save();
			return $reply['url'];
		} catch ( Throwable $e ) {
			if ( function_exists( 'error_log' ) ) {
				error_log( 'pdf-invoice: ' . $e->getMessage() );
			}
			return null;
		}
	}
}

/**
 * The absolute, public download URL for an order's stored invoice, or '' if none. The
 * Worker returns a site-relative path (/skyphusion-invoice?...); make it absolute for a
 * link. The signed URL expires (INVOICE_URL_TTL, default 7 days), after which the link
 * 403s and the order can be regenerated.
 *
 * @param WC_Order $order The order.
 * @return string The absolute URL, or ''.
 */
if ( ! function_exists( 'skyphusion_pdf_invoice_link' ) ) {
	function skyphusion_pdf_invoice_link( $order ) {
		$url = $order instanceof WC_Order ? $order->get_meta( '_skyphusion_invoice_url' ) : '';
		if ( ! is_string( $url ) || '' === $url ) {
			return '';
		}
		return 0 === strpos( $url, 'http' ) ? $url : home_url( $url );
	}
}

/*
 * Generate when an order reaches "processing" (payment received) or "completed". These
 * run after checkout, off the critical path. Default priority; generation is guarded
 * and never affects the status change.
 */
foreach ( array( 'woocommerce_order_status_processing', 'woocommerce_order_status_completed' ) as $skyphusion_pdf_hook ) {
	add_action(
		$skyphusion_pdf_hook,
		function ( $order_id ) {
			skyphusion_pdf_invoice_generate( (int) $order_id, false );
		},
		20,
		1
	);
}

/*
 * Show the download link to the customer on the order-details page (My Account) and in
 * the order emails, and to the admin on the order screen. Each surface is guarded and
 * prints nothing when there is no stored invoice.
 */
add_action(
	'woocommerce_order_details_after_order_table',
	function ( $order ) {
		$link = skyphusion_pdf_invoice_link( $order );
		if ( '' !== $link ) {
			echo '<p class="skyphusion-invoice"><a href="' . esc_url( $link ) . '" target="_blank" rel="noopener">'
				. esc_html__( 'Download PDF invoice', 'default' ) . '</a></p>';
		}
	},
	20,
	1
);

add_action(
	'woocommerce_email_after_order_table',
	function ( $order, $sent_to_admin = false, $plain_text = false ) {
		$link = skyphusion_pdf_invoice_link( $order );
		if ( '' === $link ) {
			return;
		}
		if ( $plain_text ) {
			echo "\n" . esc_html__( 'Download PDF invoice:', 'default' ) . ' ' . esc_url_raw( $link ) . "\n";
		} else {
			echo '<p><a href="' . esc_url( $link ) . '">' . esc_html__( 'Download PDF invoice', 'default' ) . '</a></p>';
		}
	},
	20,
	3
);

add_action(
	'woocommerce_admin_order_data_after_order_details',
	function ( $order ) {
		$link = skyphusion_pdf_invoice_link( $order );
		if ( '' !== $link ) {
			echo '<p class="form-field form-field-wide"><a class="button" href="' . esc_url( $link ) . '" target="_blank" rel="noopener">'
				. esc_html__( 'Download PDF invoice', 'default' ) . '</a></p>';
		}
	},
	20,
	1
);
