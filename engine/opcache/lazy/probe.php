<?php
// #582 S4 M2b: the lazy-body contract suite. One case per request; the caller sets $pf_lb_case and $pf_lb_mode
// (or passes them as argv[1] and argv[2]): mode "lazy" (bodies load at first call), "eager" (the same engine with
// opcache.pagefeather_lazy_load=0) or "compiled" (OPcache off). The runner (run-native.sh, or the wasm runner
// spikes/b2-wordpress/tests/lazy-bodies.test.mjs) checks that "out" is the same in all three modes; the checks
// that only a lazy engine can pass are asserted HERE, in lazy mode, and listed in "fail".
// Prints one JSON line: {"case", "mode", "out", "fail": [messages], "lb": counter deltas}.
$pf_case = $pf_lb_case ?? ($argv[1] ?? "");
$pf_mode = $pf_lb_mode ?? ($argv[2] ?? "");
$pf_dir = __DIR__;
$pf_fail = array();
function pf_lb() {
	$s = function_exists("opcache_get_status") ? @opcache_get_status(false) : false;
	return is_array($s) && isset($s["pagefeather_lazy_bodies"]) ? $s["pagefeather_lazy_bodies"] : array();
}
function pf_d($a, $b) { $d = array(); foreach ($b as $k => $v) { if (is_int($v)) { $d[$k] = $v - ($a[$k] ?? 0); } } return $d; }
function pf_chk($ok, $msg) { global $pf_fail; if (!$ok) { $pf_fail[] = $msg; } }
// the .bin of a cached file: file_cache / <system id> / <full path> .bin
function pf_bin($file) {
	foreach (glob(ini_get("opcache.file_cache") . "/*", GLOB_ONLYDIR) as $sys) {
		if (is_file($sys . $file . ".bin")) { return $sys . $file . ".bin"; }
	}
	return null;
}
// header fields of a .bin: [header size, pf_body_offset, pf_body_size]. The metainfo is 96 bytes where size_t is
// 8 bytes (native) and 88 where it is 4 (wasm32); PHP_INT_SIZE does not tell (zend_long may be 64-bit on wasm32),
// so the layout is the one whose sizes add up to the file length, as engine/tools/bin-split.py reads it.
function pf_hdr($bytes) {
	$n = strlen($bytes);
	$m = unpack("Pmem/Pstr", substr($bytes, 40, 16)); $b = unpack("Voff/Vsize/Vbstr", substr($bytes, 76, 12));
	if (96 + $m["mem"] + $m["str"] + $b["bstr"] === $n) { return array(96, $b["off"], $b["size"]); }
	$m = unpack("Vmem/Vstr", substr($bytes, 40, 8)); $b = unpack("Voff/Vsize/Vbstr", substr($bytes, 68, 12));
	if (88 + $m["mem"] + $m["str"] + $b["bstr"] === $n) { return array(88, $b["off"], $b["size"]); }
	return array(0, 0, 0);
}
$lazy = $pf_mode === "lazy";
$t0 = pf_lb();
$out = array();
$step = function ($label) use (&$t0, &$out) { $now = pf_lb(); $d = pf_d($t0, $now); $t0 = $now; return $d; };

switch ($pf_case) {
case "plain": // tests 1, 3, 4, 5, 6
	require $pf_dir . "/f_plain.php";
	$step("require");
	for ($pass = 1; $pass <= 2; $pass++) {
		$o = array();
		$o[] = pf_lb_named(1, c: "C"); // FIRST call skips a default by name: zend_handle_undef_args reads the body
		$o[] = pf_lb_zero();
		$o[] = pf_lb_two(2, 3);
		$o[] = pf_lb_hinted(4, "h");
		$o[] = pf_lb_defaults("a");
		$o[] = pf_lb_defaults("a", "b", array(7));
		$o[] = pf_lb_variadic(1, 2, 3, 4);
		$o[] = pf_lb_variadic(9);
		$o[] = pf_lb_excess(1, 2, 3);
		$g = pf_lb_gen(3); $gs = array(); foreach ($g as $k => $v) { $gs[] = "$k=$v"; } $o[] = implode(";", $gs) . ";" . $g->getReturn();
		$o[] = pf_lb_fib(12);
		$o[] = pf_lb_counter();
		$o[] = pf_lb_counter();
		$o[] = pf_lb_throws(5);
		$o[] = pf_lb_throws(0);
		try { pf_lb_throws_out(7); } catch (LogicException $e) { $o[] = array($e->getMessage(), $e->getLine(), basename($e->getFile()), $e->getTrace()[0]["function"]); }
		$o[] = pf_lb_switch("beta") . pf_lb_switch("gamma");
		$out[] = $o;
		$d = $step("pass " . $pass);
		if ($lazy) {
			pf_chk(($d["body_loads"] ?? null) === ($pass == 1 ? 13 : 0), "plain pass $pass: body_loads " . json_encode($d["body_loads"] ?? null) . ", want " . ($pass == 1 ? 13 : 0) . " (13 distinct functions, each loaded once)");
			pf_chk(($d["body_fail"] ?? null) === 0, "plain pass $pass: body_fail " . json_encode($d["body_fail"] ?? null));
		}
	}
	break;

case "methods": // test 2
	require $pf_dir . "/f_methods.php";
	$step("require");
	$p = new PfLbParent; $c = new PfLbChild;
	$seq = array(
		"parent m" => function () use ($p) { return $p->m(1); },
		"child m (the same body)" => function () use ($c) { return $c->m(2); },
		"static via parent" => function () { return PfLbParent::sm(3); },
		"static via child (the same body)" => function () { return PfLbChild::sm(4); },
		"trait method (a copy)" => function () use ($c) { return $c->tm(5); },
		"override and parent::" => function () use ($c) { return $c->over(); },
	);
	$want = array(1, 0, 1, 0, 1, 2);
	$i = 0;
	foreach ($seq as $label => $fn) {
		$step("x");
		$out[] = array($label, $fn(), $fn());
		$d = $step($label);
		if ($lazy) {
			pf_chk(($d["body_loads"] ?? null) === $want[$i], "methods, $label: body_loads " . json_encode($d["body_loads"] ?? null) . ", want " . $want[$i]);
		}
		$i++;
	}
	break;

case "refl": // tests 7 and 13
	require $pf_dir . "/f_refl.php";
	$step("require");
	$f = new ReflectionFunction("pf_lb_refl");
	$ps = array();
	foreach ($f->getParameters() as $prm) { $ps[] = array($prm->getName(), $prm->isOptional(), $prm->isVariadic(), (string) $prm->getType()); }
	$m = new ReflectionMethod("PfLbRefl", "rm");
	$out[] = array("no body needed", $f->getStartLine(), $f->getEndLine(), $f->getDocComment(), $f->isGenerator(), $f->getStaticVariables(),
		$f->getNumberOfParameters(), $f->getNumberOfRequiredParameters(), $ps,
		(new ReflectionFunction("pf_lb_refl_gen"))->isGenerator(), $m->getDocComment(), $m->getStaticVariables(), $m->getStartLine(),
		function_exists("pf_lb_exists"), is_callable("pf_lb_exists"), is_callable("PfLbRefl::rm"));
	$d = $step("no body needed");
	if ($lazy) {
		pf_chk(($d["body_loads"] ?? null) === 0, "refl: looks that need no body loaded " . json_encode($d["body_loads"] ?? null) . " bodies, want 0");
	}
	$prm = $f->getParameters();
	$out[] = array("defaults", $prm[1]->isDefaultValueAvailable(), $prm[1]->getDefaultValue(), $prm[2]->getDefaultValue(), $prm[0]->isDefaultValueAvailable(),
		(new ReflectionParameter("pf_lb_refl_default_late", "y"))->getDefaultValue(), (new ReflectionParameter(array("PfLbRefl", "rm"), "q"))->getDefaultValue());
	$d = $step("defaults");
	if ($lazy) {
		pf_chk(($d["body_loads"] ?? null) === 3, "refl: default values read " . json_encode($d["body_loads"] ?? null) . " bodies, want 3 (pf_lb_refl, pf_lb_refl_default_late, PfLbRefl::rm)");
	}
	$out[] = array("call after reflection", pf_lb_refl(1), $f->getStaticVariables(), pf_lb_exists(), (new PfLbRefl)->rm());
	$errs = array();
	set_error_handler(function ($no, $msg, $file, $line) use (&$errs) {
		$bt = array(); foreach (debug_backtrace(DEBUG_BACKTRACE_IGNORE_ARGS) as $fr) { $bt[] = ($fr["function"] ?? "") . "@" . ($fr["line"] ?? ""); }
		$errs[] = array($no, $msg, basename($file), $line, $bt);
		return true;
	});
	$out[] = array("warning from the first op of a body", pf_lb_warn_first(), $errs);
	restore_error_handler();
	$d = $step("after");
	if ($lazy) {
		pf_chk(($d["body_loads"] ?? null) === 2, "refl: the calls loaded " . json_encode($d["body_loads"] ?? null) . " bodies, want 2 (pf_lb_exists, pf_lb_warn_first)");
	}
	break;

case "copy": // tests 8 and 15
	require $pf_dir . "/f_copy.php";
	$step("require");
	$cl = Closure::fromCallable("pf_lb_copied");
	$fc = pf_lb_copied(...);
	$d = $step("copies");
	if ($lazy) { pf_chk(($d["body_loads"] ?? null) === 0, "copy: taking copies loaded " . json_encode($d["body_loads"] ?? null) . " bodies"); }
	$out[] = array($cl(1), $fc(2), pf_lb_copied(3), $cl(4));
	$d = $step("calls");
	if ($lazy) {
		pf_chk(($d["body_loads"] ?? null) === 1, "copy: body_loads " . json_encode($d["body_loads"] ?? null) . ", want 1");
		pf_chk(($d["copy_installs"] ?? 0) >= 1, "copy: no install into a copy (copy_installs " . json_encode($d["copy_installs"] ?? null) . ")");
	}
	$g = pf_lb_gen2(4);
	$gs = array($g->current(), $g->key());
	$g->next();
	$gs[] = $g->current();
	for ($g->next(); $g->valid(); $g->next()) { $gs[] = $g->key() . "=" . $g->current(); }
	$gs[] = $g->getReturn();
	if (!empty($pf_lb_nofiber)) { // the runner found that this engine cannot run a Fiber at all (the wasm engines today)
		$out[] = array($gs, "fiber: not supported by this engine");
	} else {
		$fb = new Fiber("pf_lb_in_fiber");
		$s = $fb->start("x");
		$fb->resume("y");
		$out[] = array($gs, $s, $fb->getReturn());
	}
	$d = $step("generator and fiber");
	$want = empty($pf_lb_nofiber) ? 2 : 1;
	if ($lazy) { pf_chk(($d["body_loads"] ?? null) === $want, "copy: the generator and the fiber loaded " . json_encode($d["body_loads"] ?? null) . " bodies, want $want"); }
	break;

case "fail": // tests 9, 13 (the Error's line and trace) and 14 (a failure, then a success)
	require $pf_dir . "/f_fail.php";
	$step("require");
	$cl = Closure::fromCallable("pf_lb_fail_target"); // a copy taken before the failure
	if ($lazy) {
		$bin = pf_bin($pf_dir . "/f_fail.php");
		pf_chk($bin !== null, "fail: no .bin for f_fail.php under " . ini_get("opcache.file_cache"));
		$orig = $bin ? file_get_contents($bin) : "";
		list($hs, $boff, $bsize) = pf_hdr($orig);
		pf_chk($hs > 0 && $bsize > 0, "fail: f_fail.php has no body tail, or its header matches neither layout");
		$at = $hs + $boff + intdiv($bsize, 2);
		$bad = $orig; $bad[$at] = chr(ord($bad[$at]) ^ 0x5a);
		file_put_contents($bin, $bad);
		$start = (new ReflectionFunction("pf_lb_fail_target"))->getStartLine();
		for ($try = 1; $try <= 2; $try++) {
			$e = null;
			try { $line = __LINE__; pf_lb_fail_target(1); } catch (Error $x) { $e = $x; }
			pf_chk($e !== null, "fail try $try: a corrupted body did not throw");
			if ($e) {
				pf_chk(strpos($e->getMessage(), "pf_lb_fail_target") !== false && strpos($e->getMessage(), $bin) !== false, "fail try $try: the Error does not name the function and the path: " . $e->getMessage());
				pf_chk($e->getLine() === $start && basename($e->getFile()) === "f_fail.php", "fail try $try: Error at " . basename($e->getFile()) . ":" . $e->getLine() . ", want f_fail.php:$start");
				$tr = $e->getTrace();
				pf_chk(($tr[0]["function"] ?? "") === "pf_lb_fail_target" && ($tr[0]["line"] ?? 0) === $line, "fail try $try: trace[0] is " . json_encode($tr[0] ?? null));
			}
			$d = $step("try $try");
			pf_chk(($d["body_fail"] ?? null) === 1 && ($d["body_loads"] ?? null) === 0 && ($d["body_bytes_resident"] ?? null) === 0, "fail try $try: counters " . json_encode($d) . ", want body_fail 1, body_loads 0, body_bytes_resident 0 (nothing installed)");
		}
		$e = null;
		try { $cl(0); } catch (Error $x) { $e = $x; }
		pf_chk($e !== null, "fail: the copy taken before the failure ran a corrupted body");
		$step("copy try");
		file_put_contents($bin, $orig); // the transient failure is over
	}
	$out[] = array(pf_lb_fail_target(1), pf_lb_fail_target(2), $cl(3));
	$d = $step("restored");
	if ($lazy) {
		pf_chk(($d["body_loads"] ?? null) === 1 && ($d["body_fail"] ?? null) === 0, "fail after restore: counters " . json_encode($d) . ", want body_loads 1 and no failure (the retry reads the body)");
	}
	break;

case "missing": // test 9, a missing .bin
	require $pf_dir . "/f_never.php"; // not called here: its .bin goes away
	$step("require");
	if ($lazy) {
		$bin = pf_bin($pf_dir . "/f_never.php");
		pf_chk($bin !== null && rename($bin, $bin . ".gone"), "missing: could not move the .bin away");
		$e = null;
		try { pf_lb_never_a(1); } catch (Error $x) { $e = $x; }
		pf_chk($e !== null && strpos($e->getMessage(), "pf_lb_never_a") !== false && strpos($e->getMessage(), (string) $bin) !== false, "missing: want an Error naming pf_lb_never_a and " . $bin . ", got " . ($e ? $e->getMessage() : "none"));
		$d = $step("missing");
		pf_chk(($d["body_fail"] ?? null) === 1 && ($d["body_loads"] ?? null) === 0, "missing: counters " . json_encode($d));
		rename($bin . ".gone", $bin);
	}
	$out[] = array(pf_lb_never_a(2));
	break;

case "never": // test 10
	$step("start");
	require $pf_dir . "/f_never.php";
	$out[] = array(function_exists("pf_lb_never_a"), function_exists("pf_lb_never_b"), class_exists("PfLbNever", false));
	$d = $step("require");
	if ($lazy) {
		pf_chk(($d["lazy_scripts"] ?? null) === 1, "never: the require did not load f_never.php lazily (lazy_scripts " . json_encode($d["lazy_scripts"] ?? null) . "): this case would see nothing");
		pf_chk(($d["body_loads"] ?? null) === 0 && ($d["body_bytes_resident"] ?? null) === 0 && ($d["body_bytes_loaded"] ?? null) === 0, "never: functions never called read or hold bodies: " . json_encode($d));
	}
	break;

case "ic": // test 11
	require $pf_dir . "/f_ic_base.php";
	require $pf_dir . "/f_ic_kids.php";
	$step("require");
	for ($i = 0; $i < 12; $i++) {
		$cn = "PfLbIcK$i"; $k = new $cn; $mn = "m$i";
		$out[] = implode("|", array($k->$mn(2), $k->base(5), $k->t1(3), $k->t2(2), $k->t2(9), $k->t3("beta"), $k->t3("delta")));
	}
	$ok = new PfLbTcOk;
	$out[] = array($ok->shared(), $ok->u(), $ok->v());
	$d = $step("calls");
	if ($lazy) {
		pf_chk(($d["body_fail"] ?? null) === 0, "ic: body_fail " . json_encode($d["body_fail"] ?? null));
		pf_chk(($d["body_loads"] ?? null) === 19, "ic: body_loads " . json_encode($d["body_loads"] ?? null) . ", want 19 (base, 3 trait methods, 12 m*, shared, u, v)");
		pf_chk(($d["copy_installs"] ?? 0) >= 1, "ic: no body went into a run-time copy (copy_installs " . json_encode($d["copy_installs"] ?? null) . "): the copies were not lazy");
	}
	break;

case "xref": // test of stage 3: an array shared into bodies lives in the head, so the file still loads lazily
	require $pf_dir . "/f_xref.php";
	$d = $step("require");
	if ($lazy) {
		pf_chk(($d["xref_scripts"] ?? null) === 0 && ($d["lazy_scripts"] ?? null) === 1, "xref: f_xref.php must load lazily with no tail crossing (xref_scripts 0, lazy_scripts 1): " . json_encode($d));
	}
	$o = new PfLbX;
	$out[] = array(PfLbX::A, $o->get2()); // the constant, and the SECOND body first: get() is still not loaded
	$d = $step("constant and get2");
	if ($lazy) {
		pf_chk(($d["body_loads"] ?? null) === 1, "xref: the constant and get2() loaded " . json_encode($d["body_loads"] ?? null) . " bodies, want 1 (get2 only)");
	}
	$out[] = array($o->get(), pf_lb_x_after(), $o->get2());
	break;

case "xstr": // stage 3: a class constant string shared into bodies (run with a full interned buffer)
	require $pf_dir . "/f_xstr.php";
	$d = $step("require");
	if ($lazy) {
		pf_chk(($d["xref_scripts"] ?? null) === 0 && ($d["lazy_scripts"] ?? null) === 1, "xstr: f_xstr.php must load lazily with no tail crossing: " . json_encode($d));
	}
	$out[] = array(PfLbXs::NAME, PfLbXs::len()); // the constant, and the SECOND body first
	$d = $step("constant and len");
	if ($lazy) {
		pf_chk(($d["body_loads"] ?? null) === 1, "xstr: the constant and len() loaded " . json_encode($d["body_loads"] ?? null) . " bodies, want 1");
	}
	$out[] = array(PfLbXs::get(), PfLbXs::len());
	break;

case "tcbad": // test 11: a real trait collision must still be one (prints a fatal, not JSON)
	require $pf_dir . "/f_ic_base.php";
	require $pf_dir . "/f_tc_bad.php";
	echo "NO COLLISION: " . (new PfLbTcBad)->same() . "\n";
	exit;

default:
	$pf_fail[] = "unknown case " . json_encode($pf_case);
}
echo json_encode(array("case" => $pf_case, "mode" => $pf_mode, "out" => $out, "fail" => $pf_fail, "lb" => $lazy ? pf_d(array(), pf_lb()) : array())), "\n";
