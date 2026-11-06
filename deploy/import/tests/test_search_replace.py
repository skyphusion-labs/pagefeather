#!/usr/bin/env python3
"""Tests of deploy/import/search-replace.py. Run: python3 deploy/import/tests/test_search_replace.py"""
import importlib.util
import os
import unittest

here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("sr", os.path.join(here, "..", "search-replace.py"))
sr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sr)

OLD = "https://old.example.com"
NEW = "https://wp.acct.workers.dev"


def rep(b):
    return sr.Replacer(OLD, NEW).value(b)


class T(unittest.TestCase):
    def test_plain(self):
        self.assertEqual(rep(b"see http://old.example.com/a and https://old.example.com/b"),
                         b"see https://wp.acct.workers.dev/a and https://wp.acct.workers.dev/b")

    def test_json_escaped(self):
        self.assertEqual(rep(b'{"url":"https:\\/\\/old.example.com\\/x"}'),
                         b'{"url":"https:\\/\\/wp.acct.workers.dev\\/x"}')

    def test_serialized_lengths(self):
        s = b'a:2:{i:0;s:27:"https://old.example.com/abc";s:1:"k";b:1;}'
        out = rep(s)
        self.assertEqual(out, b'a:2:{i:0;s:31:"https://wp.acct.workers.dev/abc";s:1:"k";b:1;}')

    def test_multibyte_length_is_bytes(self):
        # PHP counts bytes: the e with an accent is 2 bytes.
        s = 's:27:"\u00e9https://old.example.com/x";'.encode()
        self.assertEqual(rep(s), 's:31:"\u00e9https://wp.acct.workers.dev/x";'.encode())

    def test_nested_serialized(self):
        inner = b's:23:"https://old.example.com";'
        outer = b"s:%d:\"%s\";" % (len(inner), inner)
        out = rep(outer)
        new_inner = b's:27:"https://wp.acct.workers.dev";'
        self.assertEqual(out, b"s:%d:\"%s\";" % (len(new_inner), new_inner))

    def test_object(self):
        s = b'O:8:"stdClass":1:{s:3:"url";s:23:"https://old.example.com";}'
        self.assertEqual(rep(s), b'O:8:"stdClass":1:{s:3:"url";s:27:"https://wp.acct.workers.dev";}')

    def test_custom_serialized_skipped(self):
        r = sr.Replacer(OLD, NEW)
        s = b'C:3:"Foo":23:{https://old.example.com}'
        self.assertEqual(r.value(s), s)
        self.assertEqual(r.skipped, 1)

    def test_broken_serialized_gets_plain(self):
        # The length is wrong, so it is not serialized: plain replace.
        self.assertEqual(rep(b's:5:"https://old.example.com";'), b's:5:"https://wp.acct.workers.dev";')

    def test_other_host_kept(self):
        self.assertEqual(rep(b"https://old.example.com.evil.net/"), b"https://old.example.com.evil.net/")
        self.assertEqual(rep(b"https://old.example.com:8080/"), b"https://old.example.com:8080/")
        self.assertEqual(rep(b"https://notold.example.com"), b"https://notold.example.com")

    def test_untouched(self):
        self.assertEqual(rep(b"nothing here"), b"nothing here")


if __name__ == "__main__":
    unittest.main()
