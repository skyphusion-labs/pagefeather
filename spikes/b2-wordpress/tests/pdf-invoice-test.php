<?php
// php tests/pdf-invoice-test.php
// Unit test for php/pdf-invoice.php with minimal WordPress + WooCommerce stubs. Checks
// the structured invoice payload (billing lines, plain-text items and totals), that
// generation stores the signed URL and key as order meta, that it is skipped when a
// link already exists, that a degraded render stores nothing, and that the surfaces
// print the link only when one is stored. Browser Rendering itself is the Worker's job
// (a live Paid run); here the worker call is stubbed.

$fail = 0;
function check( $label, $got, $want ) {
	global $fail;
	if ( $got === $want ) { echo "ok   $label\n"; return; }
	$fail++; echo "FAIL $label\n  got:  " . var_export( $got, true ) . "\n  want: " . var_export( $want, true ) . "\n";
}

// ---- The gate the Worker injects, and the worker-call capture. ----
define( 'SKYPHUSION_PDF_INVOICE', true );
$GLOBALS['worker_calls'] = array();
$GLOBALS['worker_reply']  = '{"ok":true,"key":"invoices/42-abc.pdf","url":"/skyphusion-invoice?k=invoices%2F42-abc.pdf&e=1&s=deadbeef","bytes":1234}';
function skyphusion_worker_call( $json ) {
	$GLOBALS['worker_calls'][] = json_decode( $json, true );
	return $GLOBALS['worker_reply'];
}

// ---- Minimal WordPress stubs. ----
$GLOBALS['hooks'] = array();
function add_action( $hook, $cb, $prio = 10, $args = 1 ) { $GLOBALS['hooks'][ $hook ][] = $cb; }
function do_action( $hook, ...$args ) {
	foreach ( $GLOBALS['hooks'][ $hook ] ?? array() as $cb ) { call_user_func_array( $cb, $args ); }
}
function wp_json_encode( $v ) { return json_encode( $v ); }
function home_url( $path = '/' ) { return 'https://shop.test' . $path; }
function get_bloginfo( $k ) { return 'name' === $k ? 'Acme Goods' : 'admin@shop.test'; }
function get_option( $k, $d = '' ) {
	$opts = array(
		'woocommerce_store_address'   => '1 Main St',
		'woocommerce_store_address_2' => '',
		'woocommerce_store_city'      => 'Detroit',
		'woocommerce_store_postcode'  => '48201',
		'woocommerce_email_from_address' => 'shop@acme.test',
		'date_format'                 => 'Y-m-d',
	);
	return array_key_exists( $k, $opts ) ? $opts[ $k ] : $d;
}
function wp_strip_all_tags( $s ) { return trim( preg_replace( '/<[^>]*>/', '', (string) $s ) ); }
function __( $t, $d = 'default' ) { return $t; }
function esc_html__( $t, $d = 'default' ) { return $t; }
function esc_html( $t ) { return htmlspecialchars( (string) $t, ENT_QUOTES ); }
function esc_url( $u ) { return (string) $u; }
function esc_url_raw( $u ) { return (string) $u; }

class Stub_Date { public function date_i18n( $f ) { return '2026-11-08'; } }

class Stub_Item {
	private $name; private $qty;
	public function __construct( $name, $qty ) { $this->name = $name; $this->qty = $qty; }
	public function get_name() { return $this->name; }
	public function get_quantity() { return $this->qty; }
}

class WC_Order {
	public $meta = array();
	public $saved = 0;
	public function get_id() { return 42; }
	public function get_order_number() { return '1050'; }
	public function get_date_created() { return new Stub_Date(); }
	public function get_formatted_billing_full_name() { return 'Jane Doe'; }
	public function get_billing_company() { return 'Doe LLC'; }
	public function get_billing_address_1() { return '42 Oak Ave'; }
	public function get_billing_address_2() { return ''; }
	public function get_billing_city() { return 'Ann Arbor'; }
	public function get_billing_state() { return 'MI'; }
	public function get_billing_postcode() { return '48103'; }
	public function get_billing_country() { return 'US'; }
	public function get_billing_email() { return 'jane@x.test'; }
	public function get_billing_phone() { return '555-1000'; }
	public function get_items() { return array( new Stub_Item( 'Widget', 2 ), new Stub_Item( 'Gizmo', 1 ) ); }
	public function get_formatted_line_subtotal( $item ) { return '<span class="amount">$40.00</span>'; }
	public function get_order_item_totals() {
		return array(
			'cart_subtotal' => array( 'label' => 'Subtotal:', 'value' => '<span>$55.00</span>' ),
			'order_total'   => array( 'label' => 'Total:', 'value' => '<span>$55.00</span>' ),
		);
	}
	public function get_meta( $k ) { return $this->meta[ $k ] ?? ''; }
	public function update_meta_data( $k, $v ) { $this->meta[ $k ] = $v; }
	public function save() { $this->saved++; }
}

$GLOBALS['the_order'] = new WC_Order();
function wc_get_order( $id ) { return $GLOBALS['the_order']; }

require __DIR__ . '/../php/pdf-invoice.php';

// 1) The payload is structured and plain-text, billing lines built, empties dropped.
$payload = skyphusion_pdf_invoice_payload( $GLOBALS['the_order'] );
check( 'order number', $payload['number'], '1050' );
check( 'date formatted', $payload['date'], '2026-11-08' );
check( 'store name', $payload['store']['name'], 'Acme Goods' );
check( 'store address lines', $payload['store']['lines'], array( '1 Main St', 'Detroit 48201' ) );
check( 'billing name', $payload['billing']['name'], 'Jane Doe' );
check( 'billing lines drop the empty address_2', $payload['billing']['lines'], array( 'Doe LLC', '42 Oak Ave', 'Ann Arbor MI 48103', 'US' ) );
check( 'two line items', count( $payload['items'] ), 2 );
check( 'item total is plain text, no markup', $payload['items'][0]['total'], '$40.00' );
check( 'item qty is a string', $payload['items'][0]['qty'], '2' );
check( 'totals are plain text', $payload['totals'], array(
	array( 'label' => 'Subtotal:', 'value' => '$55.00' ),
	array( 'label' => 'Total:', 'value' => '$55.00' ),
) );

// 2) Generation sends one browserRender op and stores the URL + key as meta.
$url = skyphusion_pdf_invoice_generate( 42, false );
check( 'generate returns the url', $url, '/skyphusion-invoice?k=invoices%2F42-abc.pdf&e=1&s=deadbeef' );
check( 'one worker call', count( $GLOBALS['worker_calls'] ), 1 );
check( 'op is a browserRender invoice', $GLOBALS['worker_calls'][0]['browserRender']['kind'], 'invoice' );
check( 'op carries the order id as a string', $GLOBALS['worker_calls'][0]['browserRender']['orderId'], '42' );
check( 'url stored as meta', $GLOBALS['the_order']->meta['_skyphusion_invoice_url'], $url );
check( 'key stored as meta', $GLOBALS['the_order']->meta['_skyphusion_invoice_key'], 'invoices/42-abc.pdf' );

// 3) A second generate is skipped (a link already exists): no new worker call.
$GLOBALS['worker_calls'] = array();
$url2 = skyphusion_pdf_invoice_generate( 42, false );
check( 'skip when a link already exists', $url2, $url );
check( 'no second worker call', count( $GLOBALS['worker_calls'] ), 0 );

// 4) A degraded render (no url in the reply) stores nothing and returns null.
$GLOBALS['the_order'] = new WC_Order();
$GLOBALS['worker_calls'] = array();
$GLOBALS['worker_reply'] = '{"ok":true,"degraded":"render timeout"}';
$url3 = skyphusion_pdf_invoice_generate( 42, false );
check( 'degraded render returns null', $url3, null );
check( 'degraded render stores nothing', isset( $GLOBALS['the_order']->meta['_skyphusion_invoice_url'] ), false );
check( 'degraded render does not save the order', $GLOBALS['the_order']->saved, 0 );

// 5) The link helper is absolute and empty when there is no stored invoice.
check( 'no link without stored meta', skyphusion_pdf_invoice_link( $GLOBALS['the_order'] ), '' );
$GLOBALS['the_order']->meta['_skyphusion_invoice_url'] = '/skyphusion-invoice?k=x';
check( 'relative stored url becomes absolute', skyphusion_pdf_invoice_link( $GLOBALS['the_order'] ), 'https://shop.test/skyphusion-invoice?k=x' );

// 6) The customer surface prints the link only when one is stored.
ob_start();
do_action( 'woocommerce_order_details_after_order_table', $GLOBALS['the_order'] );
$out = ob_get_clean();
check( 'details surface prints the link', strpos( $out, 'https://shop.test/skyphusion-invoice?k=x' ) !== false, true );
$empty = new WC_Order();
ob_start();
do_action( 'woocommerce_order_details_after_order_table', $empty );
check( 'details surface prints nothing without a stored invoice', ob_get_clean(), '' );

echo $fail ? "\n$fail FAILED\n" : "\nALL PASS\n";
exit( $fail ? 1 : 0 );
