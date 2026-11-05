<?php
/**
 * Object cache drop-in (wp-content/object-cache.php) for approach B with the
 * database in the PHP object (DB_IN_DO, docs/perf-dosql.md).
 *
 * A PHP request keeps nothing, so WordPress redoes the same work on every
 * request: options, posts, terms, and the theme.json data of a block theme.
 * This cache keeps values across requests in a JavaScript Map in the PHP
 * object, reached through post_message_to_js() (index.js, handleMessage).
 * Within a request, values also stay in a PHP array, so a key costs at most
 * one bridge call per request.
 *
 * It is on only when the Worker defines JS_OBJECT_CACHE (wp-runtime.php), that
 * is, with DB_IN_DO: one object is the only writer of the database, so a
 * WordPress delete or flush keeps the cache exact. Without it, this file
 * defines nothing, so nothing changes (see below).
 *
 * Groups core marks non-persistent stay per request, except theme_json: the
 * theme files cannot change within a deploy, and core deletes that group when
 * user styles change (wp_clean_theme_json_cache()).
 *
 * Values are serialized and base64 encoded: serialize() output may not be
 * UTF-8, and the bridge is JSON.
 */

// The implementation is in its own file: PHP declares a file's top-level
// functions when it compiles the file, even after an early return, so one file
// with both paths would declare wp_cache_init() twice (measured 2026-11-05).
//
// Without JS_OBJECT_CACHE this file defines nothing. wp_start_object_cache()
// then finds no wp_cache_init(), keeps wp_using_ext_object_cache() false and
// loads core's cache itself: the same as with no drop-in (transients stay in
// the database). Loading core's cache.php here would mark an external cache.
if ( defined( 'JS_OBJECT_CACHE' ) && function_exists( 'post_message_to_js' ) ) {
	require __DIR__ . '/object-cache-js.php';
}
