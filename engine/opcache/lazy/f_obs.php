<?php
// #582 M2b fixture: observers on the stats build (test 16, wasm only).
function pf_lb_observed($x) { $a = array(); for ($i = 0; $i < $x; $i++) { $a[] = "o" . $i; } return implode(",", $a); }
function pf_lb_observed_other($x) { return strrev((string) $x); }
