<?php
// #582 M2b fixture: the inheritance cache with lazy trait methods (test 11). The kids in f_ic_kids.php extend a
// class and use a trait from THIS file, so they are linked at run time and their trait methods are copies of
// op_arrays whose bodies are not loaded yet.
class PfLbIcBase { public function base($x) { $s = 0; for ($i = 0; $i < $x; $i++) { $s += $i; } return "base:" . $s; } }
trait PfLbIcT {
	public function t1($x) { $a = array(); for ($i = 0; $i < $x; $i++) { $a[] = "t1-" . $i . "-" . static::class; } return implode(",", $a); }
	public function t2($x) { try { if ($x > 3) { throw new RuntimeException("big:" . $x); } return "small:" . str_pad((string) $x, 4, "0", STR_PAD_LEFT); } catch (RuntimeException $e) { return "caught " . $e->getMessage(); } }
	public function t3($k) { switch ($k) { case "alpha": return "A1"; case "beta": return "B2"; default: return "other:" . strtoupper($k); } }
}
// the trait collision check compares bodies (zend_add_trait_method): one body reached by two paths is no collision
trait PfLbTcCommon { public function shared() { return "shared-body"; } }
trait PfLbTcU { use PfLbTcCommon; public function u() { return "u"; } }
trait PfLbTcV { use PfLbTcCommon; public function v() { return "v"; } }
// ... and two different bodies under one name are a collision
trait PfLbTcA { public function same() { return "from A"; } }
trait PfLbTcB { public function same() { return "from B"; } }
