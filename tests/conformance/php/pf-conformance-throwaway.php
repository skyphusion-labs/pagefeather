<?php
/**
 * Plugin Name: Pagefeather conformance throwaway marker (#759)
 * Description: Marks a THROWAWAY site built for the upstream test suites. tests/conformance/runner.py
 * refuses every site without this marker, because those suites delete all posts, pages and orders.
 * prepare-content.sh ships it; never put it on a real site.
 */
add_action(
	'rest_api_init',
	function () {
		register_rest_route(
			'pf-conformance/v1',
			'/throwaway',
			array(
				'methods'             => 'GET',
				'permission_callback' => '__return_true',
				'callback'            => function () {
					return array(
						'throwaway' => true,
						'host'      => wp_parse_url( home_url(), PHP_URL_HOST ),
					);
				},
			)
		);
	}
);
