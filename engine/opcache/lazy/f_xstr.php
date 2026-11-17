<?php
// #582 M2b fixture: a class constant's STRING, shared into method bodies (stage 3), as in WooCommerce's
// InboxNotifications and Jetpack's Package_Version. run-native.sh primes it after a generated file (f_0fill.php)
// has filled a 1 MB interned-string buffer, as the 4 MB buffer of the Worker fills on WordPress. Then the string is
// not interned: before stage 3, persist copied it into get()'s body, and the constant (head) and len() (another
// body) pointed into that body, so the whole file loaded eagerly.
class PfLbXs {
	const NAME = 'pf_lb_a_constant_string_shared_into_bodies';
	public static function get() { return self::NAME; }
	public static function len() { return strlen(self::NAME); }
}
