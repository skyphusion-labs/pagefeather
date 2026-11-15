<?php
// #582 M2b fixture: a remote read that fails once, then serves (test 14, wasm only, through pagefeatherRead).
function pf_lb_transient($x) { return "transient:" . $x; }
