<?php
// #582 M2b fixture: a trait collision, linked at run time (test 11). Every engine must refuse it.
class PfLbTcBad { use PfLbTcA, PfLbTcB; }
