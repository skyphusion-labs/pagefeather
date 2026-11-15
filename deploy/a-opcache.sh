# Approach A's precompiled OPcache for deploy/deploy.sh, OPCACHE_A=1 (#296). Sourced, run in the
# app dir (spikes/b2-wordpress).
#
# Why: deploy.sh primes A's OPcache against a local MariaDB in Docker. Without Docker it shipped an
# EMPTY opcache.zip with a one-line note. An unprimed A isolate recompiles every WooCommerce script
# on its cold boot, which is 4 to 5 times slower and can pass the 128 MiB isolate cap
# (docs/results.md, 2026-11-09, the 12/12 row). opcache-a.sh primes on the D1 engine instead (no
# MySQL, no Docker) and bundles the cache for ENGINE=a, as wp-a-lean is built.
#
# a_opcache_primed runs opcache-a.sh (it does the ENGINE=a build itself), then reads the cache: an
# empty or unreadable build/opcache.zip is a failure, never a deploy.
a_opcache_primed() {
  ./opcache-a.sh > build/opcache.log 2>&1 || { echo "opcache-a.sh failed; last lines of build/opcache.log:"; tail -25 build/opcache.log; return 1; }
  local n
  n=$(python3 -c 'import sys, zipfile; print(len(zipfile.ZipFile(sys.argv[1]).namelist()))' build/opcache.zip 2>/dev/null) \
    || { echo "OPCACHE_A=1: build/opcache.zip is not a readable zip"; return 1; }
  [ "$n" -gt 0 ] || { echo "OPCACHE_A=1: build/opcache.zip holds 0 compiled scripts"; return 1; }
  echo "  OPcache primed for approach A: $n compiled scripts"
}
