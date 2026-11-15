<?php
// #582 M2b fixture: a body read held back by the read hook (test 12, wasm only).
function pf_lb_delayed($x) { return "delayed:" . $x; }
