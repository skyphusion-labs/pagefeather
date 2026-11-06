<?php
/**
 * TEST ONLY, never shipped: tests/tx/tx_check.py copies this into the built
 * tree's mu-plugins for a test run. Administrator-only REST routes that run
 * transactions through $wpdb, as plugins do (issue #60).
 *
 * POST /skyphusion-test/v1/tx {"mode": ..., "marker": "<name>", "url": "<for fetch>"}
 *   rollback      START TRANSACTION, insert <m>, ROLLBACK
 *   commit        START TRANSACTION, insert <m>, COMMIT
 *   die           START TRANSACTION, insert <m>, a PHP fatal error (500)
 *   savepoint     START TRANSACTION, insert <m>_a, SAVEPOINT sp1, insert <m>_b, ROLLBACK TO SAVEPOINT sp1, COMMIT
 *   update        (autocommit) insert <m> = orig and <m>_d; START TRANSACTION, UPDATE <m> = changed,
 *                 DELETE <m>_d, ROLLBACK
 *   cache         (autocommit) update_option(<m>, orig); START TRANSACTION, update_option(<m>, changed), ROLLBACK
 *   fetch         START TRANSACTION, insert <m>, wp_remote_get(url), ROLLBACK
 *   insert_b      insert <m>_b, no transaction (the second request of the concurrency check)
 *   nested_begin  START TRANSACTION, insert <m>_a, START TRANSACTION (MySQL commits the first), insert <m>_b, ROLLBACK
 *   ddl           START TRANSACTION, insert <m>, CREATE TABLE (MySQL commits first), ROLLBACK, DROP TABLE
 * GET  /skyphusion-test/v1/tx?marker=<name>   rows of <m>, <m>_a, <m>_b, <m>_d in the database (straight
 *      $wpdb, no cache), the value of <m> in the database, and get_option(<m>) (through the object cache).
 * DELETE /skyphusion-test/v1/tx?marker=<name> removes them.
 */
add_action(
	'rest_api_init',
	function () {
		$admin = function () {
			return current_user_can( 'manage_options' );
		};
		$name  = function ( $raw ) {
			return 'skyphusion_tx_' . preg_replace( '/[^a-z0-9]/', '', (string) $raw );
		};
		$ins   = function ( $n, $v = 'x' ) {
			global $wpdb;
			return $wpdb->insert( $wpdb->options, array( 'option_name' => $n, 'option_value' => $v, 'autoload' => 'no' ) );
		};
		register_rest_route(
			'skyphusion-test/v1',
			'/tx',
			array(
				array(
					'methods'             => 'POST',
					'permission_callback' => $admin,
					'callback'            => function ( WP_REST_Request $req ) use ( $name, $ins ) {
						global $wpdb;
						$p    = $req->get_json_params();
						$m    = $name( $p['marker'] ?? '' );
						$mode = $p['mode'] ?? '';
						$out  = array( 'marker' => $m, 'mode' => $mode );
						$t0   = microtime( true );
						switch ( $mode ) {
							case 'rollback':
							case 'commit':
							case 'die':
								$wpdb->query( 'START TRANSACTION' );
								$ins( $m );
								$out['seen_inside'] = (int) $wpdb->get_var( $wpdb->prepare( "SELECT COUNT(*) FROM {$wpdb->options} WHERE option_name = %s", $m ) );
								if ( 'die' === $mode ) {
									undefined_function_on_purpose(); // a fatal error with the transaction open
								}
								$wpdb->query( 'commit' === $mode ? 'COMMIT' : 'ROLLBACK' );
								break;
							case 'savepoint':
								$wpdb->query( 'START TRANSACTION' );
								$ins( $m . '_a' );
								$wpdb->query( 'SAVEPOINT sp1' );
								$ins( $m . '_b' );
								$wpdb->query( 'ROLLBACK TO SAVEPOINT sp1' );
								$wpdb->query( 'COMMIT' );
								break;
							case 'update':
								$ins( $m, 'orig' );
								$ins( $m . '_d', 'keep me' );
								$wpdb->query( 'START TRANSACTION' );
								$wpdb->update( $wpdb->options, array( 'option_value' => 'changed' ), array( 'option_name' => $m ) );
								$wpdb->delete( $wpdb->options, array( 'option_name' => $m . '_d' ) );
								$out['inside_value'] = $wpdb->get_var( $wpdb->prepare( "SELECT option_value FROM {$wpdb->options} WHERE option_name = %s", $m ) );
								$wpdb->query( 'ROLLBACK' );
								break;
							case 'cache':
								update_option( $m, 'orig', false );
								$wpdb->query( 'START TRANSACTION' );
								update_option( $m, 'changed', false );
								$out['inside_option'] = get_option( $m );
								$wpdb->query( 'ROLLBACK' );
								break;
							case 'fetch':
								$wpdb->query( 'START TRANSACTION' );
								$ins( $m );
								$r                   = wp_remote_get( (string) ( $p['url'] ?? '' ), array( 'timeout' => 10 ) );
								$out['fetch_status'] = is_wp_error( $r ) ? 'error: ' . $r->get_error_message() : wp_remote_retrieve_response_code( $r );
								$wpdb->query( 'ROLLBACK' );
								break;
							case 'insert_b': // a plain write (autocommit), for the concurrency check
								$ins( $m . '_b' );
								break;
							case 'nested_begin':
								$wpdb->query( 'START TRANSACTION' );
								$ins( $m . '_a' );
								$wpdb->query( 'START TRANSACTION' );
								$ins( $m . '_b' );
								$wpdb->query( 'ROLLBACK' );
								break;
							case 'ddl':
								$wpdb->query( 'START TRANSACTION' );
								$ins( $m );
								$wpdb->query( "CREATE TABLE {$wpdb->prefix}skyphusion_tx_ddl (id INT)" );
								$wpdb->query( 'ROLLBACK' );
								$wpdb->query( "DROP TABLE IF EXISTS {$wpdb->prefix}skyphusion_tx_ddl" );
								break;
						}
						$out['ms']         = (int) round( ( microtime( true ) - $t0 ) * 1000 );
						$out['last_error'] = $wpdb->last_error;
						return $out;
					},
				),
				array(
					'methods'             => 'GET',
					'permission_callback' => $admin,
					'callback'            => function ( WP_REST_Request $req ) use ( $name ) {
						global $wpdb;
						$m   = $name( $req['marker'] );
						$out = array( 'marker' => $m );
						foreach ( array( '' => 'rows', '_a' => 'rows_a', '_b' => 'rows_b', '_d' => 'rows_d' ) as $suffix => $key ) {
							$out[ $key ] = (int) $wpdb->get_var( $wpdb->prepare( "SELECT COUNT(*) FROM {$wpdb->options} WHERE option_name = %s", $m . $suffix ) );
						}
						$out['db_value']     = $wpdb->get_var( $wpdb->prepare( "SELECT option_value FROM {$wpdb->options} WHERE option_name = %s", $m ) );
						$out['option_value'] = get_option( $m, null );
						return $out;
					},
				),
				array(
					'methods'             => 'DELETE',
					'permission_callback' => $admin,
					'callback'            => function ( WP_REST_Request $req ) use ( $name ) {
						global $wpdb;
						$m = $name( $req['marker'] );
						foreach ( array( '', '_a', '_b', '_d' ) as $suffix ) {
							delete_option( $m . $suffix );
							$wpdb->delete( $wpdb->options, array( 'option_name' => $m . $suffix ) );
						}
						return array( 'deleted' => true );
					},
				),
			)
		);
	}
);
