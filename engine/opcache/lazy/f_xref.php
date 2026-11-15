<?php
// #582 M2b fixture: a pointer from the head into a body. The optimizer puts self::A's array into get()'s literals;
// persist places get()'s body first, so the class constant points into that body. The store counts the crossing
// (pf_xref) and the file always loads whole: a head-only load would leave the constant pointing at nothing.
class PfLbX {
	const A = array("x" => 1, "y" => array(2, 3));
	public function get() { return self::A; }
}
function pf_lb_x_after() { return PfLbX::A["y"][1]; }
