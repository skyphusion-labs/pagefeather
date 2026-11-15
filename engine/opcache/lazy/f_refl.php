<?php
// #582 M2b fixture: Reflection and other looks at functions not called yet (tests 7 and 13).
/**
 * The doc comment of pf_lb_refl.
 */
function pf_lb_refl(int $a, $b = "rb", array $c = array("x" => 1), ...$d)
{
	static $s1 = 10;
	static $s2 = array("k" => "v");
	return $a;
}
function pf_lb_refl_gen($n = 3) { yield $n; }
function pf_lb_refl_default_late($x, $y = PHP_INT_SIZE, $z = "z") { return "$x.$y.$z"; }
function pf_lb_warn_first() {
	$v = $pf_lb_undefined_variable;
	return "after warning";
}
function pf_lb_exists() { return "exists"; }
class PfLbRefl {
	/** method doc */
	public function rm($q = "rq") { static $ms = 5; return $q; }
}
