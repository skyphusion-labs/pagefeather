<?php
/**
 * Plugin Name: Pagefeather conformance gap tests (#759)
 * Description: For a THROWAWAY conformance site only. It stands in for wordpress-develop's fatal-error-handler
 * spec, which writes this same mu-plugin on the RUNNER's disk and so cannot run on a deployed site. On
 * ?pf_conformance=fatal it runs upstream's own line, so the request ends in a PHP fatal at mu-plugin load,
 * after WordPress registered its fatal error handler. tests/conformance/gaps.py then reads the handler page.
 * It does nothing unless the throwaway marker (pf-conformance-throwaway.php) sits beside it: mu-plugins load in
 * name order, so this file checks for the marker's FILE, not its code. prepare-content.sh ships both; never
 * put this on a real site. Tested in tests/conformance/gaps-php-test.sh.
 */
// phpcs:ignore WordPress.Security.NonceVerification.Recommended -- a read of one fixed test switch, no state change.
if ( isset( $_GET['pf_conformance'] ) && 'fatal' === $_GET['pf_conformance'] && file_exists( __DIR__ . '/pf-conformance-throwaway.php' ) ) {
	new NonExistentClass();
}
