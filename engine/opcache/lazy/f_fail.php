<?php
// #582 M2b fixture: the ONLY lazy body in this file, so the whole body tail is its body (tests 9, 13, 14).
function pf_lb_fail_target($x) { return "loaded:" . $x . ":" . str_repeat("ab", 3); }
