<?php
// #582 M2b fixture: an array shared into bodies. The optimizer puts self::A's array into the literals of get() and
// get2(); before stage 3, persist placed it in get()'s body, so the class constant (head to body) and get2() (body
// to body) pointed into get()'s body, and the whole file loaded eagerly. Stage 3 persists such an array in the head.
class PfLbX {
	const A = array("x" => 1, "y" => array(2, 3));
	public function get() { return self::A; }
	public function get2() { return self::A["y"]; }
}
function pf_lb_x_after() { return PfLbX::A["y"][1]; }
