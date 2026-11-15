<?php
// #582 M2b fixture: the profile-guided hot set (stage 5). run-native.sh profiles prof_hot.php, which calls a() and
// b() only, so a and b are hot and c and d are cold. With opcache.pagefeather_lazy_unit=hot, the first call (c) reads
// the script once and keeps a, b and c; d still loads alone, later.
function pf_lb_h_a($x) { return "a:" . $x; }
function pf_lb_h_b($x) { return "b:" . strrev((string) $x); }
function pf_lb_h_c($x) { return "c:" . ($x * 3); }
function pf_lb_h_d($x) { return "d:" . str_repeat((string) $x, 2); }
