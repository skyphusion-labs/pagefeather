# shellcheck shell=bash
# PHP_MEMORY_REUSE and BOOT_GATE (#598, #603): the ONE rule, sourced by both emitters that render them:
# deploy/wfp/lib.sh (render_user, memory_reuse_vars) and deploy/a-settings.sh (deploy.sh, variant a). Sourced, not run.
#
# PHP_MEMORY_REUSE=on: a recycled PHP runtime hands its WebAssembly memory to the next boot, so the isolate never
# holds two. BOOT_GATE=on: a boot beside retired memory that would pass the budget answers a known 503, for a
# bounded time. Each is on or unset (unset: off, today's path). The gate is only valid WITH reuse: alone it refuses
# every reboot until the bound, after every recycle. So the valid sets are: neither, PHP_MEMORY_REUSE alone, or both.
# BOOT_TEST_DELAY_MS is a local test seam (spikes/b2-wordpress/tests/boot-race-e2e.sh) and never reaches a site.

# memory_reuse_check: status 1 and the reason on stderr when the set is not valid.
memory_reuse_check() {
  case "${PHP_MEMORY_REUSE:-}" in ""|on) ;; *) echo "PHP_MEMORY_REUSE must be on or unset, not ${PHP_MEMORY_REUSE}" >&2; return 1 ;; esac
  case "${BOOT_GATE:-}" in ""|on) ;; *) echo "BOOT_GATE must be on or unset, not ${BOOT_GATE}" >&2; return 1 ;; esac
  if [ "${BOOT_GATE:-}" = on ] && [ "${PHP_MEMORY_REUSE:-}" != on ]; then
    echo "BOOT_GATE=on needs PHP_MEMORY_REUSE=on: without reuse every runtime reboot is refused until V8 collects the retired memory, which locally did not happen within 660 s (#598, #603)" >&2; return 1
  fi
  if [ -n "${BOOT_TEST_DELAY_MS:-}" ] || [ -n "${BOOT_TEST_DELAY_AT:-}" ]; then
    echo "BOOT_TEST_DELAY_MS is a local test seam (tests/boot-race-e2e.sh) and is never rendered for a site" >&2; return 1
  fi
  return 0
}

# memory_reuse_lines: the [vars] lines of a valid set (nothing when neither is on). Run memory_reuse_check first.
memory_reuse_lines() {
  [ -z "${PHP_MEMORY_REUSE:-}" ] || echo 'PHP_MEMORY_REUSE = "on"'
  [ -z "${BOOT_GATE:-}" ] || echo 'BOOT_GATE = "on"'
  return 0
}
