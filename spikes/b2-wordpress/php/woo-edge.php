<?php
/**
 * Plugin Name: WooCommerce on the edge
 * Description: WooCommerce settings for PHP in a Worker.
 *
 * PHP in a Worker cannot send mail (no mail(), no network). Rendering the order
 * emails at checkout loads PHPMailer and the email templates for nothing, in a
 * request that is near the 128 MB isolate memory limit. Defer them to Action
 * Scheduler, where a mail binding can send them later.
 */
add_filter( 'woocommerce_defer_transactional_emails', '__return_true' );
