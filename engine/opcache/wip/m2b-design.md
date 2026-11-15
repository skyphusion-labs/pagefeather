## S4 M2b design: lazy function bodies loaded at first call (rollins, seat rollins-sb1114h, written 2026-11-15)

M2a (#607, e1aec0a) gave every split script a body tail. M2b loads a function's body only when the function is first called, and only for scripts that come from the file cache (`opcache.zip`). A script compiled at run time stays eager: its body is already in shared memory. Behind `ENGINE_LAZY_BODIES=1`, off by default. **Design only; no code until you review the shape.**

Source facts (php-8.3.36):
- `i_init_func_execute_data` (`zend_execute.c`) starts a frame at `op_array->opcodes`. It advances `opline` by the call's arg count when there are no type hints (skipping RECV), and it moves extra args with `zend_copy_extra_args`, which uses `last_var` and `T`.
- `zend_file_cache_serialize_interned` writes strings flagged `IS_STR_INTERNED`. That is how file-cache-only mode uses them in place.

### 1. What is lazy

- **Lazy:** named functions and methods of a split script, loaded from the file cache.
- **Never lazy:**
  - the main script op_array, which runs at once;
  - closures (`ZEND_ACC_CLOSURE`): they are copied at creation, and Reflection reads their opcodes (`getClosureUsedVariables`);
  - a function with more declared args than the stub length;
  - every script compiled at run time.

### 2. Store side (opcache.sh priming, `zend_file_cache_script_store`)

**A body's span.** Persist lays out each op_array's body parts in one run: literals and their nested strings and arrays, opcodes, live ranges, try/catch. A nested function's body follows after it. So each lazy op_array's body is ONE contiguous span of the M2a tail.

**A body's own strings.** The span's literal strings are written to a per-body string table, appended after the script's string section. They are deduplicated within that body only. A lazy load then reads ONE chunk, [span | its strings], and needs nothing else from the file. This costs file size (a string shared by two bodies is stored twice). It costs no wasm memory for bodies never called.

**A per-script body directory**, appended to the file and recorded in the metainfo. One entry per lazy op_array:
- span offset and length;
- string-table offset and length;
- adler32;
- the real `last`, `last_literal`, `last_live_range` and `last_try_catch`.
The serialized op_array names its entry through one `reserved[]` slot, taken with `zend_get_resource_handle` at startup (not a raw pointer).

The system id entropy moves to `pagefeather-lazy-body-2`, so M2a files are refused, not misread.

### 3. Load side (`zend_file_cache_script_load`)

Load reads the metainfo, the HEAD part of the block, the script's string section and the directory. The body tail and the body string tables are NOT read. The head and the directory are copied to shared memory, and the head is unserialized as today.

For each lazy op_array, its four body pointers are left as they were (serialized offsets into the tail) and are not unserialized:
- `opcodes` points at the shared trampoline (section 4), and `last` is the trampoline length;
- `literals`, `live_range` and `try_catch_array` are NULL, with their counts set to 0. So an exception in the stub state finds no live range or catch to run;
- `last_var`, `T`, `cache_size`, `num_args`, `fn_flags`, `arg_info`, `vars`, the static variables and the lines keep their real values, so the frame the caller pushes is right;
- `reserved[slot]` points at a descriptor: the directory entry, the script's `.bin` path, its state, and the loaded pointers.

### 4. The trampoline

- **Stub array.** One static array of N `zend_op`s (N = 256, which bounds the declared args of a lazy function). Each is the same opcode, `PF_LAZY_BODY` (a free opcode above `ZEND_VM_LAST_OPCODE`), with its handler from `zend_set_user_opcode_handler` and its line number set to `line_start`. N covers the RECV skip: the caller's `opline += num_args` lands on stub k.
- **The handler, on the first call:**
  1. **Read.** Read the chunk from the `.bin` with `open`, `lseek` and `read`. These go through our hooks, so a remote pack uses the existing path, Suspending under JSPI. `wasm_sapi_handle_request` is promising, so the suspend is legal inside a handler. To verify with a test.
  2. **Check.** Check the length and the adler32.
  3. **Unserialize** into ONE persistent allocation (`pemalloc`, for the runtime's life; a recycle frees it). Body pointers are unserialized against (chunk minus span offset). String pointers are unserialized against the body's own table, used in place as `IS_STR_INTERNED`, as file-cache-only mode does.
  4. **Install.** Only after all of that succeeds: write the four pointers and real counts into the shared-memory op_array and into `EX(func)` if it is a copy. Set `EX(opline) = real_opcodes + k`, where k is the distance from `EX(func)`'s own stub base (a copy may carry a copied stub), and return `ZEND_USER_OPCODE_CONTINUE`.
- **Later calls:** the shared-memory op_array now has real pointers, so the trampoline is never entered again for it. A copy made before the load (Closure::fromCallable, a trait method clone, an inheritance-cache entry) still has stub pointers. It shares the descriptor, so its first call installs the already-loaded pointers and reads nothing.
- **Shared bodies:** two op_arrays naming the same directory entry (an inherited method that keeps one body) share one descriptor, so the body is loaded once.

### 5. Failure path

- **What fails:** a short read, EIO (a remote fetch that failed), a checksum or length mismatch, or an unserialize error.
- **What happens:**
  - the handler frees the chunk;
  - it installs nothing (no field is written);
  - it throws `Error("Cannot load the body of C::f() from <path>")` in the callee frame and hands it to the exception path. Whether CONTINUE or a dispatch to `ZEND_HANDLE_EXCEPTION` is right is to verify in code; test 9 checks it.
- **Why that is safe:** the stub state has no live range and no catch, so the Error goes straight to the caller, where `try`/`catch` can take it. The frame's CVs are initialised (`last_var` is real), so unwinding frees them as for any call.
- **After a failure:** the stub stays, and the next call retries. A failed body is never cached. There is no fallback to compiling from source (a second load path we cannot test well), and never a bailout: this PR's own lesson.
- **Counters** in `pagefeather_lazy_bodies`: `body_loads`, `body_bytes_loaded`, `body_fail`, `body_bytes_resident`. `/_mem` shows them, and the gate asserts `body_fail == 0` on the e2e.

### 6. Tests (all red-first where the harness can reach it)

Contract suite, on a file-cache-loaded script (shared memory plus a primed file cache in the node harness):
1. **Plain functions:** a lazy function answers as compiled, on its first and second call. Cases: 0 args; N args with no type hints (the RECV skip); type hints (no skip); defaults (`RECV_INIT`); extra args (variadic, and excess args).
2. **Methods:** an instance method, a static method, an inherited method sharing one body (loaded once, measured by `body_loads`), and a trait method (a copy).
3. **Generators:** a generator function, lazy; `GENERATOR_CREATE` is its first real op.
4. **Recursion:** a function that recurses on its first call.
5. **Static variables:** they persist across calls after the load.
6. **Exceptions:** inside a lazy body, with the right file and line, and caught inside its own try/catch on the first call.
7. **Reflection, before and after the load:** `getStartLine`, `getParameters`, `isGenerator`, `getStaticVariables`, `getDocComment`. Closures are asserted NOT lazy.
8. **Copies before the load:** `Closure::fromCallable` of a lazy function, taken before its first call.
9. **Failure:** a corrupted body (one byte flipped in the chunk) and a missing `.bin`. Each throws a catchable `Error` naming the function and the path. `body_fail` is counted, the stub stays, and after the file is restored the next call works. This also settles the exception hand-off of section 5.
10. **Never called:** a function that is never called reads nothing and holds nothing (`body_loads` and `body_bytes_resident` unchanged).
11. **The inheritance cache with lazy trait methods:** M2a's red family, now with bodies loaded through a copy.
12. **A delayed read:** the body read is held back by a `pagefeatherRead` hook with a delay (Suspending inside the handler), and still loads correctly.
13. **A function not loaded yet, seen without a call** (the lead's (a)). Each must match the eager engine:
    - Reflection: `getStartLine`, `getEndLine`, `getStaticVariables`, `getDocComment`;
    - `debug_backtrace()` and the error line number while a stub frame is on the stack (a load failure, and a warning raised by a body's first op);
    - `function_exists` and `is_callable`.
14. **A transient failure, then a success** (the lead's (b)). A remote pack fetch fails on the first call, through a `pagefeatherRead` hook that fails once and then serves. The first call throws the `Error`, and NOTHING is installed: the shared-memory op_array and any copy still hold the stub pointers and zero counts, `body_bytes_resident` is unchanged, and `body_fail` is 1. The next call loads and answers. `body_loads` is 1.
15. **Generators and fibers** (the lead's (c)): a generator whose first `->current()` resumes into a body just loaded; and a Fiber whose callable is a lazy function, so the first call into the body runs on the fiber's stack, then suspends and resumes.
16. **Observers** (the lead's (d)): on the M1 stats build (`ENGINE_OPCACHE_STATS=1` with lazy bodies), the observer's begin and end fire exactly once per call of a lazy function, and its body-bytes count reads the REAL opcodes after the install (not the stub). The same holds for any `zend_observer` fcall handler.

Added 2026-11-15 after the lead's review; tests 13 to 16 are part of the list before any code.

Engine gates: the `lazy-bodies` job runs its current steps plus `e2e.sh`, `woo.py` and `frames-e2e.sh` on a lean-lazy engine primed with `PRIME_OPCACHE_MB=128`, loading from that zip. It asserts `body_fail == 0`, `mismatch == 0` and `noregion == 0`, and reads `body_loads` and `body_bytes_resident` against the M1 numbers (that is M2c).

The CodeQL job for the patched tree (#608) is needed before M2b merges, as agreed.

### 7. Costs and risks, named

- **Reads on first calls:** one read per function, per runtime. M1 found about 4,700 called functions on an editor screen, so the first editor request after a boot pays thousands of small MEMFS reads. M2c measures the time.
  - **Clock:** the loader accumulates `body_load_ns` with `zend_hrtime`, because `Date.now()` does not move during a Worker request.
  - **Threshold, named before measuring:** on the first editor request after a boot (`post-new.php`, WooCommerce active), the fallback is triggered if the summed load time exceeds **250 ms**, or **5% of that request's own wall time**, whichever comes first.
  - **The fallback:** load a script's whole tail at the first call into that script (more memory, fewer reads).
- **The per-body string tables** make `opcache.zip` bigger (to measure). They add nothing to memory for bodies never called.
- **Writing a shared-memory op_array at run time** is safe here because the wasm runtime is one process with one thread. It would not be safe on a multi-process PHP; this engine is never that.
- **Every PHP 8.3.x bump** that touches `zend_file_cache.c`, `zend_persist*.c` or the frame setup needs this patch re-checked. The patch applies with `git apply --check` first, so a bump fails loudly.
