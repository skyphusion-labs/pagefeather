<?php
// #582 M2b fixture: functions declared and never called (test 10).
function pf_lb_never_a($x) { return str_repeat("never", $x) . implode(",", array(1, 2, 3)); }
function pf_lb_never_b() { $a = array(); for ($i = 0; $i < 10; $i++) { $a[] = "n" . $i; } return $a; }
class PfLbNever { public function nm() { return "nm"; } }
