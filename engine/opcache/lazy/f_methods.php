<?php
// #582 M2b fixture: methods (test 2). PfLbChild inherits m() from PfLbParent: one op_array, one body.
trait PfLbTrait {
	public function tm($x) { return "tm:" . $x . ":" . static::class; }
}
class PfLbParent {
	public $p = "P";
	public function m($x) { return "m:" . $x . ":" . $this->p . ":" . static::class; }
	public static function sm($x) { return "sm:" . $x . ":" . static::class; }
	public function over() { return "parent-over"; }
}
class PfLbChild extends PfLbParent {
	use PfLbTrait;
	public $p = "C";
	public function over() { return "child-over+" . parent::over(); }
}
