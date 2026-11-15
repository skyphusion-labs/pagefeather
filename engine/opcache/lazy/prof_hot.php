<?php
// #582 M2b: the profile run for f_hot.php (run-native.sh): it calls a and b only, so they become the hot set.
require __DIR__ . "/f_hot.php";
echo pf_lb_h_a(1), pf_lb_h_b(2), "\n";
