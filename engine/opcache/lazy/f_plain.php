<?php
// #582 M2b fixture: plain functions (tests 1, 3, 4, 5, 6). Each case of probe.php touches only its own functions.
function pf_lb_zero() { return "zero"; }
function pf_lb_two($a, $b) { return "$a+$b=" . ($a + $b); }
function pf_lb_hinted(int $a, string $b) { return $b . ":" . ($a * 2); }
function pf_lb_defaults($a, $b = "B", $c = array(1, 2)) { return $a . "|" . $b . "|" . implode(",", $c); }
function pf_lb_named($a, $b = "nb", $c = "nc") { return "$a/$b/$c"; }
function pf_lb_variadic($first, ...$rest) { return $first . ":" . implode(",", $rest) . ":" . func_num_args(); }
function pf_lb_excess($a) { return $a . ":" . implode(",", func_get_args()); }
function pf_lb_gen($n) { for ($i = 0; $i < $n; $i++) { yield $i => "g" . $i; } return "done"; }
function pf_lb_fib($n) { return $n < 2 ? $n : pf_lb_fib($n - 1) + pf_lb_fib($n - 2); }
function pf_lb_counter() { static $n = 0; static $log = array(); $n++; $log[] = $n; return implode(",", $log); }
function pf_lb_throws($x) {
	try {
		if ($x > 1) { throw new RuntimeException("inner " . $x); }
		return "no";
	} catch (RuntimeException $e) {
		return "caught " . $e->getMessage() . " at line " . $e->getLine() . " of " . basename($e->getFile());
	}
}
function pf_lb_throws_out($x) { throw new LogicException("out " . $x); }
function pf_lb_switch($k) { switch ($k) { case "alpha": return "A"; case "beta": return "B"; default: return "other:" . strtoupper($k); } }
