<?php
// #582 M2b fixture: copies taken before the first call (test 8), generators and fibers (test 15).
function pf_lb_copied($x) { return "copied:" . $x; }
function pf_lb_gen2($n) { $t = 0; for ($i = 1; $i <= $n; $i++) { $t += $i; yield $i => $t; } return $t; }
function pf_lb_in_fiber($x) {
	$got = Fiber::suspend("suspended:" . $x);
	return "resumed:" . $got;
}
