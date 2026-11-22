<?php
// php spikes/b2-wordpress/tests/url-details-self-test.php (#1157, option (d), Conrad's choice 2026-11-22)
// The block editor's url-details route (WP_REST_URL_Details_Controller) fetches a URL with wp_safe_remote_get() and
// reads its <head>. For the site's OWN URL that fetch cannot leave a Worker (a same-zone fetch() fails, error 1042), and
// with no pool and no cached copy index.js refuses it, so url-details answers 404 no_response. The gb navigation specs
// read the link preview's title from it ("can update page link to a new page link": toContainText('Test Page 2')).
// (d): on that refusal, for a GET that url-details tagged, the bridge answers a <head> built from WordPress's own data,
// with no HTTP hop. Core's controller then parses it, caches it and filters it as it does a fetched page.
// Minimal WordPress stubs; the real bridge and the real url-details-self.php are loaded and driven.
$fail = 0;
function check( $label, $got, $want ) {
	global $fail;
	if ( $got === $want ) { echo "ok   $label\n"; return; }
	$fail++; echo "FAIL $label\n  got:  " . var_export( $got, true ) . "\n  want: " . var_export( $want, true ) . "\n";
}
$GLOBALS['sent'] = array(); $GLOBALS['reply'] = '{}'; $GLOBALS['filters'] = array();
function post_message_to_js( $j ) { $GLOBALS['sent'][] = json_decode( $j, true ); return $GLOBALS['reply']; }
function add_filter( $h, $cb, $prio = 10, $n = 1 ) { $GLOBALS['filters'][ $h ][] = $cb; }
function apply_filters( $hook, $value, ...$args ) {
	foreach ( $GLOBALS['filters'][ $hook ] ?? array() as $cb ) { $value = $cb( $value, ...$args ); }
	return $value;
}
function do_action( $hook, ...$a ) {}
function get_option( $k ) {
	$o = array( 'home' => 'https://shop.example.com', 'blog_charset' => 'UTF-8', 'show_on_front' => $GLOBALS['show_on_front'] ?? 'posts', 'page_on_front' => $GLOBALS['page_on_front'] ?? 0 );
	return $o[ $k ] ?? false;
}
function home_url( $p = '' ) { return 'https://shop.example.com' . $p; }
function get_bloginfo( $k, $f = 'raw' ) { return array( 'name' => 'Shop', 'description' => 'Just another site', 'charset' => 'UTF-8' )[ $k ] ?? ''; }
function wp_kses_bad_protocol( $s, $allowed ) { return $s; }
function wp_parse_url( $u, $c = -1 ) { return parse_url( $u, $c ); }
function __( $s ) { return $s; }
function esc_html( $s ) { return htmlspecialchars( $s, ENT_QUOTES ); }
function get_status_header_desc( $c ) { return 'OK'; }
function current_theme_supports( $f ) { return 'title-tag' === $f && ( $GLOBALS['title_tag'] ?? true ); }
function wp_is_block_theme() { return $GLOBALS['block_theme'] ?? false; }
$GLOBALS['posts'] = array(
	12 => (object) array( 'ID' => 12, 'post_title' => 'Test Page 2', 'post_status' => 'publish', 'post_type' => 'page' ),
	13 => (object) array( 'ID' => 13, 'post_title' => 'Draft Page', 'post_status' => 'draft', 'post_type' => 'page' ),
	14 => (object) array( 'ID' => 14, 'post_title' => 'Home Page', 'post_status' => 'publish', 'post_type' => 'page' ),
);
$GLOBALS['urls'] = array( 'https://shop.example.com/?page_id=12' => 12, 'https://shop.example.com/test-page-2' => 12, 'https://shop.example.com/?page_id=13' => 13, 'https://shop.example.com/?page_id=14' => 14, 'https://other.example.org/?page_id=12' => 12 ); // the last: as if url_to_postid ignored the host, so the plugin's own check is what refuses it
function url_to_postid( $u ) { return $GLOBALS['urls'][ $u ] ?? 0; }
function get_post( $id ) { return $GLOBALS['posts'][ $id ] ?? null; }
function is_post_publicly_viewable( $p ) { return $p && 'publish' === $p->post_status; }
function wp_site_icon() { if ( ! empty( $GLOBALS['icon'] ) ) { echo '<link rel="icon" href="https://shop.example.com/i-32.png" sizes="32x32" />' . "\n"; } }
class WP_Error { public $code; public $message; function __construct( $c, $m ) { $this->code = $c; $this->message = $m; } }
class WP_Http_Cookie { function __construct( $v, $u ) {} }
class WP_Http { static function processHeaders( $h ) { return array( 'headers' => array() ); } }
class Skyphusion_Test_Http { function block_request( $u ) { return false; } }
function _wp_http_get_object() { return new Skyphusion_Test_Http(); }
require __DIR__ . '/../php/http-bridge.php';
$plugin = __DIR__ . '/../php/url-details-self.php';
if ( file_exists( $plugin ) ) { require $plugin; } else { echo "FAIL php/url-details-self.php is missing\n"; $fail++; }
$bridge = $GLOBALS['filters']['pre_http_request'][0];
// The args core's controller sends, through its own filter (rest_url_details_http_request_args), as WP_Http passes them on.
function ud_args( $url, $method = 'GET' ) {
	$a = array( 'method' => $method, 'headers' => array(), 'cookies' => array(), 'body' => null, 'user-agent' => 'WP-URLDetails/7.1', 'timeout' => 10, 'redirection' => 5, 'limit_response_size' => 153600, 'stream' => false, 'filename' => null, 'reject_unsafe_urls' => true, 'blocking' => true );
	return apply_filters( 'rest_url_details_http_request_args', $a, $url );
}
function plain_args( $method = 'GET' ) {
	return array( 'method' => $method, 'headers' => array(), 'cookies' => array(), 'body' => null, 'user-agent' => 'WordPress', 'timeout' => 5, 'redirection' => 5, 'limit_response_size' => null, 'stream' => false, 'filename' => null, 'reject_unsafe_urls' => true, 'blocking' => true );
}
function title_of( $r ) { return is_array( $r ) && preg_match( '#<title[^>]*>(.*?)</title>#is', $r['body'], $m ) ? $m[1] : null; }
$SELF = '{"error":"a request to this site itself is refused: no other PHP runtime to run it on (the overflow pool is off), and Cloudflare does not route a fetch() to its own zone","self":true}';

// The spec's assertion: the preview title contains the page title. Stock's <title> is core's document title.
$u = 'https://shop.example.com/?page_id=12';
$GLOBALS['reply'] = $SELF;
$r = $bridge( false, ud_args( $u ), $u );
check( 'url-details, own published page, self-refused: a 200', is_array( $r ) ? $r['response']['code'] : ( $r instanceof WP_Error ? $r->message : $r ), 200 );
check( '  its <title> is core document title (title, sep, site)', title_of( $r ), 'Test Page 2 - Shop' );
check( '  it contains the spec page title', is_string( title_of( $r ) ) && false !== strpos( title_of( $r ), 'Test Page 2' ), true );
check( '  no icon when the site has none (stock prints none)', is_array( $r ) && false === strpos( $r['body'], 'rel="icon"' ), true );
check( '  named as synthetic', is_array( $r ) ? ( $r['headers']['x-pf-synthetic'] ?? null ) : null, 'url-details-self' );
check( '  the Worker was asked first (cache first)', count( $GLOBALS['sent'] ), 1 );
// a pretty permalink resolves the same way
$u2 = 'https://shop.example.com/test-page-2';
check( 'a pretty permalink resolves too', title_of( $bridge( false, ud_args( $u2 ), $u2 ) ), 'Test Page 2 - Shop' );
// the site icon, as wp_site_icon() prints it (its first rel=icon is the one core reads)
$GLOBALS['icon'] = true;
$r = $bridge( false, ud_args( $u ), $u );
check( 'with a site icon: wp_site_icon output is in the head', is_array( $r ) && false !== strpos( $r['body'], '<link rel="icon" href="https://shop.example.com/i-32.png" sizes="32x32" />' ), true );
$GLOBALS['icon'] = false;
// the front page: site name, then tagline (core's is_front_page branch)
$r = $bridge( false, ud_args( 'https://shop.example.com/' ), 'https://shop.example.com/' );
check( 'the home URL (posts on front): site name - tagline', title_of( $r ), 'Shop - Just another site' );
$GLOBALS['show_on_front'] = 'page'; $GLOBALS['page_on_front'] = 14;
$u3 = 'https://shop.example.com/?page_id=14';
check( 'the static front page by its own URL: site name - tagline', title_of( $bridge( false, ud_args( $u3 ), $u3 ) ), 'Shop - Just another site' );
$GLOBALS['show_on_front'] = 'posts'; $GLOBALS['page_on_front'] = 0;
// core's title filters still run
add_filter( 'document_title_separator', function () { return '|'; } );
check( 'document_title_separator is applied', title_of( $bridge( false, ud_args( $u ), $u ) ), 'Test Page 2 | Shop' );
array_pop( $GLOBALS['filters']['document_title_separator'] );

// What stays refused, exactly as today (the WP_Error the Worker sent):
$GLOBALS['sent'] = array();
$r = $bridge( false, plain_args(), $u );
check( 'not url-details (an untagged self GET): still refused', $r instanceof WP_Error ? 'refused' : 'answered', 'refused' );
$r = $bridge( false, ud_args( $u, 'POST' ), $u );
check( 'not a GET: still refused', $r instanceof WP_Error ? 'refused' : 'answered', 'refused' );
$GLOBALS['reply'] = '{"error":"host not in HTTP_ALLOW_HOSTS: x"}';
$r = $bridge( false, ud_args( $u ), $u );
check( 'a refusal that is not a self refusal: unchanged', $r instanceof WP_Error ? $r->message : 'answered', 'host not in HTTP_ALLOW_HOSTS: x' );
$GLOBALS['reply'] = $SELF;
$o = 'https://other.example.org/?page_id=12';
$r = $bridge( false, ud_args( $o ), $o );
check( 'another host, even if marked self: refused', $r instanceof WP_Error ? 'refused' : 'answered', 'refused' );
$u4 = 'https://shop.example.com/?page_id=13';
$r = $bridge( false, ud_args( $u4 ), $u4 );
check( 'a draft (stock: an anonymous fetch gets a 404): refused', $r instanceof WP_Error ? 'refused' : 'answered', 'refused' );
$u5 = 'https://shop.example.com/category/news';
$r = $bridge( false, ud_args( $u5 ), $u5 );
check( 'a URL that is not a post (an archive): refused, not guessed', $r instanceof WP_Error ? 'refused' : 'answered', 'refused' );
$GLOBALS['title_tag'] = false;
$r = $bridge( false, ud_args( $u ), $u );
check( 'a CLASSIC theme without title-tag (its own <title>): refused, not guessed', $r instanceof WP_Error ? 'refused' : 'answered', 'refused' );
// #1326 live proof, cf759hw 2026-11-22: a BLOCK theme has no title-tag support (core's _add_default_theme_supports does
// not add it), yet its template prints core's document title unconditionally (block-template.php,
// _block_template_render_title_tag). The guard refused every block theme, so url-details stayed 404 live.
$GLOBALS['block_theme'] = true;
$r = $bridge( false, ud_args( $u ), $u );
check( 'a BLOCK theme without title-tag support: answered with the document title', title_of( $r ), 'Test Page 2 - Shop' );
$GLOBALS['block_theme'] = false;
$GLOBALS['title_tag'] = true;
// Each layer's guard on its own (the bridge's and the plugin's host checks would otherwise mask each other):
$GLOBALS['reply'] = $SELF;
check( 'the plugin alone: another host gets no answer', apply_filters( 'skyphusion_http_self_refused', null, $o, ud_args( $o ), 'GET' ), null );
$GLOBALS['filters']['skyphusion_http_self_refused'][] = function ( $a ) { return array( 'headers' => array(), 'body' => '<title>any</title>', 'response' => array( 'code' => 200, 'message' => 'OK' ), 'cookies' => array() ); };
$r = $bridge( false, ud_args( $o ), $o );
check( 'the bridge alone: never asks the filter for another host', $r instanceof WP_Error ? 'refused' : 'answered', 'refused' );
$nb = ud_args( $u ); $nb['blocking'] = false;
$r = $bridge( false, $nb, $u );
check( 'the bridge alone: a non-blocking request is never answered', $r instanceof WP_Error ? 'refused' : 'answered', 'refused' );
array_pop( $GLOBALS['filters']['skyphusion_http_self_refused'] );
// a 200 the Worker answered (a cache hit) is the real page, untouched
$GLOBALS['reply'] = '{"status":200,"statusText":"OK","headers":[],"body":"' . base64_encode( '<title>Real</title>' ) . '"}';
check( 'a cache hit: the real page, not the synthetic one', title_of( $bridge( false, ud_args( $u ), $u ) ), 'Real' );
echo $fail ? "$fail FAILED\n" : "ALL PASS\n";
exit( $fail ? 1 : 0 );
