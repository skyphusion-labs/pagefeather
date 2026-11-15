"""#582 S4 M2b, stage 2 (the lazy load), on top of the stage 1 tree (pf-lazy-bodies.patch at a10203e).
Usage: apply-m2b-lazy.py <php-src root>. Every anchor must occur exactly once (count checked).

Store: the serializer counts every pointer that reaches into the body tail from outside its own body span
(pf_xref, in the metainfo); a file with pf_xref != 0 always loads whole. The metainfo also carries a head
checksum over [head | strings], so a lazy load can verify what it read.
Load: a lazily loaded script reads and keeps only its head. Each lazy op_array points at a static trampoline of
PF_LB_STUB_LEN ZEND_PF_LAZY_BODY ops (op k carries k). The first call reads that body's span and string table,
checks its adler32, unserializes it into one malloc'd chunk and only then installs it, then continues at
real + k. A failure installs nothing and throws a catchable Error; the next call retries.
Zend: zend_handle_undef_args, Reflection's RECV lookup and the inheritance error text ask for the body first
(they read opcodes without a call); the trait collision check compares body ids, not opcodes pointers.
A copy taken before its body loaded keeps pointing at the trampoline; its first call installs the body."""
import sys, os, re
root = sys.argv[1]
def tabs(s):
    return re.sub(r"(?m)^((?:    )+)", lambda m: "\t" * (len(m.group(1)) // 4), s)
def edit(rel, pairs):
    p = os.path.join(root, rel); s = open(p).read()
    for old, new in pairs:
        assert s.count(old) == 1, (rel, s.count(old), old[:120])
        s = s.replace(old, new)
    open(p, "w").write(s)
T = "pagefeather lazy bodies (#582 M2b stage 2)"

# ---------------------------------------------------------------- Zend: the hook, the stub test, the body id
edit("Zend/zend_execute.h", [
 ("ZEND_API zend_result ZEND_FASTCALL zend_handle_undef_args(zend_execute_data *call);\n",
  "ZEND_API zend_result ZEND_FASTCALL zend_handle_undef_args(zend_execute_data *call);\n" + tabs(
  "\n/* " + T + ": OPcache may leave a function's body unloaded until its first call. Until then its\n"
  " * opcodes are a trampoline of ZEND_PF_LAZY_BODY ops. Code that reads opcodes WITHOUT calling the function asks\n"
  " * for the body first (zend_pf_lazy_body_ensure); zend_pf_body_id names one body the same before and after its load. */\n"
  "#define ZEND_PF_LAZY_BODY 240\n"
  "ZEND_API extern zend_result (*zend_pf_lazy_body_ensure)(zend_op_array *op_array, bool may_throw);\n"
  "ZEND_API extern int zend_pf_lazy_body_slot;\n"
  "static zend_always_inline bool zend_pf_lazy_body_pending(const zend_op_array *op_array)\n{\n"
  "    return zend_pf_lazy_body_ensure && op_array->opcodes && op_array->opcodes[0].opcode == ZEND_PF_LAZY_BODY;\n}\n"
  "static zend_always_inline const void *zend_pf_body_id(const zend_op_array *op_array)\n{\n"
  "    if (zend_pf_lazy_body_slot >= 0 && op_array->reserved[zend_pf_lazy_body_slot]) {\n"
  "        return op_array->reserved[zend_pf_lazy_body_slot];\n    }\n    return op_array->opcodes;\n}\n")),
])
edit("Zend/zend_execute.c", [
 ("ZEND_API void (ZEND_FASTCALL *zend_touch_vm_stack_data)(void *vm_stack_data) = NULL;\n",
  "ZEND_API void (ZEND_FASTCALL *zend_touch_vm_stack_data)(void *vm_stack_data) = NULL;\n\n"
  "/* " + T + ": set by OPcache when it loads function bodies at their first call */\n"
  "ZEND_API zend_result (*zend_pf_lazy_body_ensure)(zend_op_array *op_array, bool may_throw) = NULL;\n"
  "ZEND_API int zend_pf_lazy_body_slot = -1;\n"),
 ("\t\tzend_op_array *op_array = &fbc->op_array;\n\t\tuint32_t num_args = ZEND_CALL_NUM_ARGS(call);\n",
  "\t\tzend_op_array *op_array = &fbc->op_array;\n\t\tuint32_t num_args = ZEND_CALL_NUM_ARGS(call);\n"
  "\t\tif (UNEXPECTED(zend_pf_lazy_body_pending(op_array)) && zend_pf_lazy_body_ensure(op_array, true) == FAILURE) {\n"
  "\t\t\treturn FAILURE; /* " + T + ": the defaults are in the body; the Error is thrown */\n\t\t}\n"),
])
edit("ext/reflection/php_reflection.c", [
 ("static zend_op *get_recv_op(zend_op_array *op_array, uint32_t offset)\n{\n\tzend_op *op = op_array->opcodes;\n",
  "static zend_op *get_recv_op(zend_op_array *op_array, uint32_t offset)\n{\n"
  "\tif (UNEXPECTED(zend_pf_lazy_body_pending(op_array)) && zend_pf_lazy_body_ensure(op_array, true) == FAILURE) {\n"
  "\t\treturn NULL; /* " + T + ": the RECV ops are in the body; the Error is thrown */\n\t}\n"
  "\tzend_op *op = op_array->opcodes;\n"),
])
edit("Zend/zend_inheritance.c", [
 ("\t\t\t\t\t\tuint32_t idx  = i;\n\t\t\t\t\t\tzend_op *op = fptr->op_array.opcodes;\n",
  "\t\t\t\t\t\tuint32_t idx  = i;\n"
  "\t\t\t\t\t\tif (zend_pf_lazy_body_pending(&fptr->op_array)) {\n"
  "\t\t\t\t\t\t\tzend_pf_lazy_body_ensure((zend_op_array*)&fptr->op_array, false); /* " + T + " */\n\t\t\t\t\t\t}\n"
  "\t\t\t\t\t\tzend_op *op = fptr->op_array.opcodes;\n"),
 ("\t\tif (existing_fn->op_array.opcodes == fn->op_array.opcodes &&\n",
  "\t\t/* " + T + ": every body not loaded yet shares one trampoline, so compare body ids */\n"
  "\t\tif ((existing_fn->type == ZEND_USER_FUNCTION ? zend_pf_body_id(&existing_fn->op_array) : (const void*)existing_fn->op_array.opcodes) == zend_pf_body_id(&fn->op_array) &&\n"),
])

# ---------------------------------------------------------------- header: counters, the directive, the entry points
edit("ext/opcache/ZendAccelerator.h", [
 ("extern uint32_t pf_lb_dir_total, pf_lb_dir_mismatch;\n",
  "extern uint32_t pf_lb_dir_total, pf_lb_dir_mismatch;\n"
  "/* " + T + ": load counters (opcache_get_status), the startup, and the real counts of a body not loaded yet */\n"
  "extern uint32_t pf_lb_lazy_scripts, pf_lb_eager_scripts, pf_lb_xref_scripts, pf_lb_body_loads, pf_lb_body_fail, pf_lb_copy_installs;\n"
  "extern uint64_t pf_lb_body_bytes_loaded, pf_lb_body_bytes_resident, pf_lb_body_load_ns;\n"
  "void pf_lb_startup(void);\n"
  "bool pf_lb_real_counts(const zend_op_array *op_array, uint32_t counts[4]);\n"),
 ("\tbool      file_cache_consistency_checks;\n",
  "\tbool      file_cache_consistency_checks;\n\tbool      pf_lazy_load; /* " + T + ": opcache.pagefeather_lazy_load */\n"),
])
edit("ext/opcache/zend_accelerator_module.c", [
 ("accel_directives.file_cache_consistency_checks, zend_accel_globals, accel_globals)\n",
  "accel_directives.file_cache_consistency_checks, zend_accel_globals, accel_globals)\n"
  "\tSTD_PHP_INI_BOOLEAN(\"opcache.pagefeather_lazy_load\" , \"1\"   , PHP_INI_SYSTEM, OnUpdateBool,\t   accel_directives.pf_lazy_load, zend_accel_globals, accel_globals) /* " + T + " */\n"),
 ("\t\tadd_assoc_long(&pf_lb, \"dir_mismatch\", pf_lb_dir_mismatch);\n",
  "\t\tadd_assoc_long(&pf_lb, \"dir_mismatch\", pf_lb_dir_mismatch);\n"
  "\t\t/* " + T + " */\n"
  "\t\tadd_assoc_bool(&pf_lb, \"lazy_load\", ZCG(accel_directives).pf_lazy_load);\n"
  "\t\tadd_assoc_long(&pf_lb, \"lazy_scripts\", pf_lb_lazy_scripts);\n"
  "\t\tadd_assoc_long(&pf_lb, \"eager_scripts\", pf_lb_eager_scripts);\n"
  "\t\tadd_assoc_long(&pf_lb, \"xref_scripts\", pf_lb_xref_scripts);\n"
  "\t\tadd_assoc_long(&pf_lb, \"body_loads\", pf_lb_body_loads);\n"
  "\t\tadd_assoc_long(&pf_lb, \"body_fail\", pf_lb_body_fail);\n"
  "\t\tadd_assoc_long(&pf_lb, \"body_bytes_loaded\", (zend_long)pf_lb_body_bytes_loaded);\n"
  "\t\tadd_assoc_long(&pf_lb, \"body_bytes_resident\", (zend_long)pf_lb_body_bytes_resident);\n"
  "\t\tadd_assoc_long(&pf_lb, \"body_load_ns\", (zend_long)pf_lb_body_load_ns);\n"
  "\t\tadd_assoc_long(&pf_lb, \"copy_installs\", pf_lb_copy_installs);\n"),
])
edit("ext/opcache/ZendAccelerator.c", [
 ('"pagefeather-lazy-body-2"', '"pagefeather-lazy-body-3"'),
 ("\t\tzend_accel_error(ACCEL_LOG_ERROR, \"pagefeather lazy bodies: the system id could not take the lazy-body entropy\\n\");\n\t}\n",
  "\t\tzend_accel_error(ACCEL_LOG_ERROR, \"pagefeather lazy bodies: the system id could not take the lazy-body entropy\\n\");\n\t}\n"
  "\tpf_lb_startup(); /* " + T + ": the trampoline, its opcode handler, the op_array slot (warns and stays eager on failure) */\n"),
])

# ---------------------------------------------------------------- the file cache
FC = "ext/opcache/zend_file_cache.c"
edit(FC, [
 ('#include "zend_enum.h"\n', '#include "zend_enum.h"\n#include "zend_hrtime.h" /* ' + T + ' */\n'),
 # macros: the unserialized test sees a lazy chunk; pointer serialization is checked for tail crossings; a lazy
 # body's pointers map into its chunk or the resident head
 ("\t(((char*)(ptr) >= (char*)script->mem && (char*)(ptr) <= (char*)script->mem + script->size) || \\\n\t IS_ACCEL_INTERNED(ptr))\n",
  "\t(((char*)(ptr) >= (char*)script->mem && (char*)(ptr) <= (char*)script->mem + script->size) || \\\n\t IS_ACCEL_INTERNED(ptr) || PF_LZ_IN_CHUNK(ptr))\n"),
 ("\t\t\tZEND_ASSERT(IS_UNSERIALIZED(ptr)); \\\n\t\t\t(ptr) = (void*)((char*)(ptr) - (char*)script->mem); \\\n",
  "\t\t\tZEND_ASSERT(IS_UNSERIALIZED(ptr)); \\\n\t\t\tPF_XCHK(ptr); \\\n\t\t\t(ptr) = (void*)((char*)(ptr) - (char*)script->mem); \\\n"),
 ("\t\t\tZEND_ASSERT(IS_SERIALIZED(ptr)); \\\n\t\t\t(ptr) = (void*)((char*)buf + (size_t)(ptr)); \\\n",
  "\t\t\tZEND_ASSERT(IS_SERIALIZED(ptr)); \\\n\t\t\t(ptr) = PF_LZ_UNSER(ptr, buf); \\\n"),
 ("\t\t\t\tZEND_ASSERT(IS_UNSERIALIZED(ptr)); \\\n\t\t\t\t(ptr) = (void*)((char*)(ptr) - (char*)script->mem); \\\n",
  "\t\t\t\tZEND_ASSERT(IS_UNSERIALIZED(ptr)); \\\n\t\t\t\tPF_XCHK(ptr); \\\n\t\t\t\t(ptr) = (void*)((char*)(ptr) - (char*)script->mem); \\\n"),
 ("\t\t\t\tZEND_ASSERT(IS_SERIALIZED(ptr)); \\\n\t\t\t\t(ptr) = (void*)((char*)buf + (size_t)(ptr)); \\\n",
  "\t\t\t\tZEND_ASSERT(IS_SERIALIZED(ptr)); \\\n\t\t\t\t(ptr) = PF_LZ_UNSER(ptr, buf); \\\n"),
 # metainfo
 ("\tuint32_t     pf_bstr_size;   /* pagefeather lazy bodies (#582 M2b): the body-string section, after the string section */\n",
  "\tuint32_t     pf_bstr_size;   /* pagefeather lazy bodies (#582 M2b): the body-string section, after the string section */\n"
  "\tuint32_t     pf_head_checksum; /* " + T + ": adler32 of [head | string section], what a lazy load reads */\n"
  "\tuint32_t     pf_xref;        /* " + T + ": pointers into the body tail from outside their own body (non-zero: load whole) */\n"),
 # the store and load contexts, after the stage 1 globals
 ("static char *pf_load_bstr = NULL;\n",
  "static char *pf_load_bstr = NULL;\n" + tabs(
  "/* " + T + ": while a split script is serialized, pf_xr counts pointers that reach into the body tail\n"
  " * from outside the body being serialized ([lo, hi] is that body's span; lo > hi means none). */\n"
  "static struct { bool on; size_t tail, lo, hi; uint32_t n; } pf_xr;\n"
  "#define PF_XCHK(p) do { \\\n"
  "        if (pf_xr.on) { \\\n"
  "            size_t pf_o = (size_t)((char*)(p) - (char*)script->mem); \\\n"
  "            if (pf_o >= pf_xr.tail && (pf_o < pf_xr.lo || pf_o > pf_xr.hi)) { \\\n"
  "                pf_xr.n++; \\\n"
  "            } \\\n"
  "        } \\\n"
  "    } while (0)\n"
  "/* While one lazy body is unserialized, its serialized offsets in [lo, hi] map into chunk, offsets below tail into the\n"
  " * resident head; anything else marks the load bad (the store keeps such files whole, so only corruption gets here). */\n"
  "static struct { char *chunk, *head; size_t len, lo, hi, tail; bool bad; } pf_lz;\n"
  "static void *pf_lz_map(size_t off)\n{\n"
  "    if (off >= pf_lz.lo && off <= pf_lz.hi) {\n        return pf_lz.chunk + (off - pf_lz.lo);\n    }\n"
  "    if (off < pf_lz.tail) {\n        return pf_lz.head + off;\n    }\n"
  "    pf_lz.bad = true;\n    return pf_lz.chunk;\n}\n"
  "#define PF_LZ_IN_CHUNK(p) (pf_lz.chunk && (char*)(p) >= pf_lz.chunk && (char*)(p) <= pf_lz.chunk + pf_lz.len)\n"
  "#define PF_LZ_UNSER(p, b) (pf_lz.chunk ? pf_lz_map((size_t)(p)) : (void*)((char*)(b) + (size_t)(p)))\n")),
 # a lazy body's own interned strings are used in place, inside its chunk, never copied to shared memory
 ("\tstr = (zend_string*)((char*)ZCG(mem) + ((size_t)(str) & ~Z_UL(1)));\n\tif (!in_shm) {\n",
  "\tstr = (zend_string*)((char*)ZCG(mem) + ((size_t)(str) & ~Z_UL(1)));\n"
  "\tif (pf_lz.chunk) { /* " + T + ": in place in the body chunk, which lives as long as the runtime */\n"
  "\t\tGC_ADD_FLAGS(str, IS_STR_INTERNED | IS_STR_PERSISTENT | IS_STR_PERMANENT);\n\t\treturn str;\n\t}\n"
  "\tif (!in_shm) {\n"),
])

# serialize: the allowed windows
edit(FC, [
 ("\t\t\top_array->refcount = (uint32_t*)(intptr_t)-1;\n\t\t\tSERIALIZE_PTR(op_array->static_variables);\n",
  "\t\t\top_array->refcount = (uint32_t*)(intptr_t)-1;\n"
  "\t\t\tsize_t pf_rlo = pf_xr.lo, pf_rhi = pf_xr.hi; /* " + T + ": a shared body's pointers are in its span */\n"
  "\t\t\tif (pf_xr.on) {\n"
  "\t\t\t\tint pf_rk = pf_dir_find(script->pf_body_dir, script->pf_body_dir_n, (size_t)((char*)op_array->opcodes - (char*)script->mem));\n"
  "\t\t\t\tpf_xr.lo = pf_rk >= 0 ? script->pf_body_dir[pf_rk].span_off : 1;\n"
  "\t\t\t\tpf_xr.hi = pf_rk >= 0 ? (size_t)script->pf_body_dir[pf_rk].span_off + script->pf_body_dir[pf_rk].span_len : 0;\n"
  "\t\t\t}\n"
  "\t\t\tSERIALIZE_PTR(op_array->static_variables);\n"),
 ("\t\t\tSERIALIZE_PTR(op_array->try_catch_array);\n\t\t\tSERIALIZE_PTR(op_array->prototype);\n\t\t\treturn;\n",
  "\t\t\tSERIALIZE_PTR(op_array->try_catch_array);\n\t\t\tSERIALIZE_PTR(op_array->prototype);\n"
  "\t\t\tpf_xr.lo = pf_rlo;\n\t\t\tpf_xr.hi = pf_rhi;\n\t\t\treturn;\n"),
 ("\t\t\tpf_bmode = true;\n\t\t}\n\t}\n",
  "\t\t\tpf_bmode = true;\n\t\t}\n\t}\n"
  "\tsize_t pf_wlo = pf_xr.lo, pf_whi = pf_xr.hi; /* " + T + ": this body's own span is allowed */\n"
  "\tpf_xr.lo = pf_k >= 0 ? script->pf_body_dir[pf_k].span_off : 1;\n"
  "\tpf_xr.hi = pf_k >= 0 ? (size_t)script->pf_body_dir[pf_k].span_off + script->pf_body_dir[pf_k].span_len : 0;\n"),
 ("\t\tif (op_array->arg_info) {\n\t\t\tzend_arg_info *p, *end;\n\t\t\tSERIALIZE_PTR(op_array->arg_info);\n",
  "\t\tsize_t pf_blo = pf_xr.lo, pf_bhi = pf_xr.hi; /* " + T + ": the head parts are outside the body */\n"
  "\t\tpf_xr.lo = 1;\n\t\tpf_xr.hi = 0;\n"
  "\t\tif (op_array->arg_info) {\n\t\t\tzend_arg_info *p, *end;\n\t\t\tSERIALIZE_PTR(op_array->arg_info);\n"),
 ("\t\tSERIALIZE_PTR(op_array->live_range);\n\t\tSERIALIZE_PTR(op_array->scope);\n",
  "\t\tpf_xr.lo = pf_blo;\n\t\tpf_xr.hi = pf_bhi;\n\t\tSERIALIZE_PTR(op_array->live_range);\n\t\tpf_xr.lo = 1;\n\t\tpf_xr.hi = 0;\n\t\tSERIALIZE_PTR(op_array->scope);\n"),
 ("\t\tSERIALIZE_PTR(op_array->try_catch_array);\n\t\tSERIALIZE_PTR(op_array->prototype);\n\t}\n}\n",
  "\t\tpf_xr.lo = pf_blo;\n\t\tpf_xr.hi = pf_bhi;\n\t\tSERIALIZE_PTR(op_array->try_catch_array);\n"
  "\t\tpf_xr.lo = pf_wlo;\n\t\tpf_xr.hi = pf_whi;\n\t\tSERIALIZE_PTR(op_array->prototype);\n\t}\n}\n"),
 ("\tinfo->pf_body_size = (uint32_t)script->pf_body_size;\n",
  "\tinfo->pf_body_size = (uint32_t)script->pf_body_size;\n"
  "\tpf_xr.on = script->pf_body_dir != NULL && script->pf_body_size != 0; /* " + T + " */\n"
  "\tpf_xr.tail = info->pf_body_offset;\n\tpf_xr.lo = 1;\n\tpf_xr.hi = 0;\n\tpf_xr.n = 0;\n"),
 ("\tinfo.checksum = zend_adler32(ADLER32_INIT, buf, script->size);\n",
  "\tinfo.pf_xref = pf_xr.n; /* " + T + ": non-zero keeps the file whole on load */\n"
  "\tpf_xr.on = false;\n"
  "\tinfo.pf_head_checksum = zend_adler32(ADLER32_INIT, (unsigned char*)buf, info.pf_body_offset);\n"
  "\tinfo.pf_head_checksum = zend_adler32(info.pf_head_checksum, (unsigned char*)ZSTR_VAL(s), info.str_size);\n"
  "\tinfo.checksum = zend_adler32(ADLER32_INIT, buf, script->size);\n"),
])

# unserialize_op_array: the head of a lazy script records each body and leaves the stub state
edit(FC, [
 ("\t/* Check whether this op_array has already been unserialized. */\n\tif (IS_UNSERIALIZED(op_array->opcodes)) {\n",
  "\t/* Check whether this op_array has already been unserialized. */\n"
  "\tif (IS_UNSERIALIZED(op_array->opcodes) || op_array->opcodes == pf_lb_stub) { /* " + T + ": or left at the trampoline */\n"),
 ("\tif (op_array->refcount) {\n\t\top_array->refcount = NULL;\n",
  "\tif (op_array->refcount) {\n\t\top_array->refcount = NULL;\n"
  "\t\tpf_lb_desc *pf_rd = pf_lb_head_desc(script, op_array); /* " + T + ": a second op_array of a lazy body */\n"),
 ("\t\tUNSERIALIZE_PTR(op_array->try_catch_array);\n\t\tUNSERIALIZE_PTR(op_array->prototype);\n\t\treturn;\n",
  "\t\tUNSERIALIZE_PTR(op_array->try_catch_array);\n\t\tUNSERIALIZE_PTR(op_array->prototype);\n"
  "\t\tif (pf_rd) {\n\t\t\tpf_lb_stub_state(op_array, pf_rd);\n\t\t}\n\t\treturn;\n"),
 ("\tvoid *pf_saved_mem = NULL; /* pagefeather lazy bodies (#582 M2b): a body resolves its interned strings in its own table */\n\tif (script->pf_body_dir && op_array->opcodes) {\n",
  "\tpf_lb_desc *pf_d = pf_lb_head_desc(script, op_array); /* " + T + ": a lazy body: its four body parts stay in the file */\n"
  "\tvoid *pf_saved_mem = NULL; /* pagefeather lazy bodies (#582 M2b): a body resolves its interned strings in its own table */\n"
  "\tif (!pf_d && pf_load_bstr && script->pf_body_dir && op_array->opcodes) {\n"),
 ("\tif (op_array->literals) {\n\t\tzval *p, *end;\n\n\t\tUNSERIALIZE_PTR(op_array->literals);\n",
  "\tif (op_array->literals && !pf_d) {\n\t\tzval *p, *end;\n\n\t\tUNSERIALIZE_PTR(op_array->literals);\n"),
 ("\t\tUNSERIALIZE_PTR(op_array->opcodes);\n\t\topline = op_array->opcodes;\n\t\tend = opline + op_array->last;\n",
  "\t\tUNSERIALIZE_PTR(op_array->opcodes);\n\t\topline = op_array->opcodes;\n"
  "\t\tend = pf_d ? opline : opline + op_array->last; /* " + T + ": a lazy body's opcodes are not read yet */\n"),
 ("\t\tUNSERIALIZE_PTR(op_array->try_catch_array);\n\t\tUNSERIALIZE_PTR(op_array->prototype);\n\t}\n}\n\nstatic void zend_file_cache_unserialize_func(",
  "\t\tUNSERIALIZE_PTR(op_array->try_catch_array);\n\t\tUNSERIALIZE_PTR(op_array->prototype);\n"
  "\t\tif (pf_d) {\n\t\t\tpf_lb_stub_state(op_array, pf_d);\n\t\t}\n\t}\n}\n\nstatic void zend_file_cache_unserialize_func("),
])

RUNTIME = tabs(r'''/* pagefeather lazy bodies (#582 M2b stage 2): the load at first call.
 * A lazily loaded script keeps only its head in shared memory. Each lazy op_array points at pf_lb_stub
 * (PF_LB_STUB_LEN ops, all ZEND_PF_LAZY_BODY, op k carrying k in extended_value), with no literals, live ranges or
 * try/catch, and its real frame fields (last_var, T, cache_size, num_args, fn_flags), so the caller pushes the
 * right frame and its RECV skip lands on stub k. The first call reads the body's span and its own string table
 * from the .bin, checks the adler32, unserializes it into one malloc'd chunk (kept for the runtime's life), and
 * only then writes the real pointers into every op_array that shares the body, and continues at real + k.
 * A failure writes nothing, throws a catchable Error, and the next call tries again. Writing a shared-memory
 * op_array at run time is safe only in a single-process, single-thread runtime, which the pagefeather engine is;
 * opcache.protect_memory turns the lazy load off. A copy taken before the load (a trait method linked at run time,
 * Closure::fromCallable) keeps the trampoline pointer: the inheritance cache never persists the op_arrays of a
 * cached class again (the ZEND_ACC_CACHED return in zend_persist_op_array_ex), so it is never copied or freed. */
typedef struct _pf_lb_script {
    char *path;                   /* the .bin, malloc'd */
    const pf_body_dir_entry *dir; /* in the shared-memory head */
    char *head;                   /* the shared-memory head (script->mem) */
    size_t full_size, tail;       /* the serialized block size; where its body tail starts */
    size_t bstr_base;             /* file offset of the body-string section */
} pf_lb_script;

typedef struct _pf_lb_desc {
    pf_lb_script *s;
    uint32_t k;                   /* the directory entry */
    bool loaded;
    uintptr_t lit, ops, lr, tc;   /* serialized offsets of the four body parts */
    uint32_t last, last_literal, last_live_range, last_try_catch;
    char *chunk;
    zval *literals;
    zend_op *opcodes;
    zend_live_range *live_range;
    zend_try_catch_element *try_catch_array;
    zend_op_array **oas;          /* the shared-memory op_arrays of this body */
    uint32_t n_oa, cap_oa;
} pf_lb_desc;

static zend_op pf_lb_stub[PF_LB_STUB_LEN];
static int pf_lb_slot = -1;
uint32_t pf_lb_lazy_scripts = 0, pf_lb_eager_scripts = 0, pf_lb_xref_scripts = 0, pf_lb_body_loads = 0, pf_lb_body_fail = 0, pf_lb_copy_installs = 0;
uint64_t pf_lb_body_bytes_loaded = 0, pf_lb_body_bytes_resident = 0, pf_lb_body_load_ns = 0;
/* set only while the head of a lazily loaded script is unserialized */
static struct { pf_lb_script *s; pf_lb_desc *descs; uint32_t n; } pf_lzh;

static bool pf_lb_lazy_ok(void)
{
    return pf_lb_slot >= 0 && ZCG(accel_directives).pf_lazy_load && !ZCG(accel_directives).protect_memory && !file_cache_only;
}

static size_t pf_lb_read_size(const zend_file_cache_metainfo *info, bool lazy)
{
    return lazy ? (size_t)info->pf_body_offset + info->str_size : (size_t)info->mem_size + info->str_size + info->pf_bstr_size;
}

static bool pf_lb_pread(int fd, char *dst, size_t n, size_t off)
{
    if (!n) {
        return true;
    }
    if (lseek(fd, (off_t)off, SEEK_SET) != (off_t)off) {
        return false;
    }
    while (n) {
        ssize_t r = read(fd, dst, n);
        if (r < 0 && errno == EINTR) {
            continue;
        }
        if (r <= 0) {
            return false;
        }
        dst += r;
        n -= (size_t)r;
    }
    return true;
}

/* the read after the metainfo: everything (eager), or the head and the string section (lazy) */
static bool pf_lb_read(int fd, char *mem, const zend_file_cache_metainfo *info, bool lazy)
{
    if (!lazy) {
        return pf_lb_pread(fd, mem, pf_lb_read_size(info, false), sizeof(*info));
    }
    return pf_lb_pread(fd, mem, info->pf_body_offset, sizeof(*info))
        && pf_lb_pread(fd, mem + info->pf_body_offset, info->str_size, sizeof(*info) + (size_t)info->mem_size);
}

static void *pf_lb_arena(size_t size)
{
#if defined(__AVX__) || defined(__SSE2__)
    void *mem = zend_arena_alloc(&CG(arena), size + 64);
    return (void*)(((uintptr_t)mem + 63L) & ~63L);
#else
    return zend_arena_alloc(&CG(arena), size);
#endif
}

static void pf_lb_free_script(pf_lb_script *s, pf_lb_desc *descs, uint32_t n)
{
    if (descs) {
        for (uint32_t i = 0; i < n; i++) {
            free(descs[i].oas);
        }
        free(descs);
    }
    if (s) {
        free(s->path);
        free(s);
    }
}

/* the head unserializer meets a lazy op_array: record its body (once per directory entry) and its op_array */
static pf_lb_desc *pf_lb_head_desc(zend_persistent_script *script, zend_op_array *op_array)
{
    int k;
    pf_lb_desc *d;
    if (!pf_lzh.descs || !script->pf_body_dir || !op_array->opcodes) {
        return NULL;
    }
    k = pf_dir_find(script->pf_body_dir, script->pf_body_dir_n, (size_t)op_array->opcodes);
    if (k < 0 || (uint32_t)k >= pf_lzh.n) {
        return NULL;
    }
    d = &pf_lzh.descs[k];
    if (!d->s) {
        d->s = pf_lzh.s;
        d->k = (uint32_t)k;
        d->lit = (uintptr_t)op_array->literals;
        d->ops = (uintptr_t)op_array->opcodes;
        d->lr = (uintptr_t)op_array->live_range;
        d->tc = (uintptr_t)op_array->try_catch_array;
        d->last = op_array->last;
        d->last_literal = op_array->last_literal;
        d->last_live_range = op_array->last_live_range;
        d->last_try_catch = op_array->last_try_catch;
    }
    if (d->n_oa == d->cap_oa) {
        uint32_t cap = d->cap_oa ? d->cap_oa * 2 : 2;
        zend_op_array **oas = realloc(d->oas, sizeof(zend_op_array*) * cap);
        if (!oas) {
            zend_error_noreturn(E_ERROR, "pagefeather lazy bodies: out of memory recording a body");
        }
        d->oas = oas;
        d->cap_oa = cap;
    }
    d->oas[d->n_oa++] = op_array;
    return d;
}

static void pf_lb_stub_state(zend_op_array *op_array, pf_lb_desc *d)
{
    op_array->opcodes = pf_lb_stub;
    op_array->last = PF_LB_STUB_LEN;
    op_array->literals = NULL;
    op_array->last_literal = 0;
    op_array->live_range = NULL;
    op_array->last_live_range = 0;
    op_array->try_catch_array = NULL;
    op_array->last_try_catch = 0;
    op_array->reserved[pf_lb_slot] = d;
}

/* mirrors the literal and opcode loops of zend_file_cache_unserialize_op_array (re-check on every PHP bump) */
static void pf_lb_unserialize_body(zend_op_array *op_array, zend_persistent_script *script, void *buf)
{
    if (op_array->literals) {
        zval *p, *end;

        UNSERIALIZE_PTR(op_array->literals);
        p = op_array->literals;
        end = p + op_array->last_literal;
        while (p < end) {
            zend_file_cache_unserialize_zval(p, script, buf);
            p++;
        }
    }
    {
        zend_op *opline, *end;

        UNSERIALIZE_PTR(op_array->opcodes);
        opline = op_array->opcodes;
        end = opline + op_array->last;
        while (opline < end) {
#if ZEND_USE_ABS_CONST_ADDR
            if (opline->op1_type == IS_CONST) {
                UNSERIALIZE_PTR(opline->op1.zv);
            }
            if (opline->op2_type == IS_CONST) {
                UNSERIALIZE_PTR(opline->op2.zv);
            }
#else
            if (opline->op1_type == IS_CONST) {
                ZEND_PASS_TWO_UPDATE_CONSTANT(op_array, opline, opline->op1);
            }
            if (opline->op2_type == IS_CONST) {
                ZEND_PASS_TWO_UPDATE_CONSTANT(op_array, opline, opline->op2);
            }
#endif
#if ZEND_USE_ABS_JMP_ADDR
            switch (opline->opcode) {
                case ZEND_JMP:
                case ZEND_FAST_CALL:
                    UNSERIALIZE_PTR(opline->op1.jmp_addr);
                    break;
                case ZEND_JMPZ:
                case ZEND_JMPNZ:
                case ZEND_JMPZ_EX:
                case ZEND_JMPNZ_EX:
                case ZEND_JMP_SET:
                case ZEND_COALESCE:
                case ZEND_FE_RESET_R:
                case ZEND_FE_RESET_RW:
                case ZEND_ASSERT_CHECK:
                case ZEND_JMP_NULL:
                case ZEND_BIND_INIT_STATIC_OR_JMP:
                    UNSERIALIZE_PTR(opline->op2.jmp_addr);
                    break;
                case ZEND_CATCH:
                    if (!(opline->extended_value & ZEND_LAST_CATCH)) {
                        UNSERIALIZE_PTR(opline->op2.jmp_addr);
                    }
                    break;
                case ZEND_FE_FETCH_R:
                case ZEND_FE_FETCH_RW:
                case ZEND_SWITCH_LONG:
                case ZEND_SWITCH_STRING:
                    /* relative extended_value don't have to be changed */
                    break;
            }
#endif
            zend_deserialize_opcode_handler(opline);
            opline++;
        }
    }
    UNSERIALIZE_PTR(op_array->live_range);
    UNSERIALIZE_PTR(op_array->try_catch_array);
}

/* read, check and unserialize one body; on success it is resident, on failure nothing is kept */
static zend_result pf_lb_load(pf_lb_desc *d)
{
    const pf_body_dir_entry *e = &d->s->dir[d->k];
    size_t span = e->span_len, len = span + e->str_len;
    zend_hrtime_t t0 = zend_hrtime();
    char *chunk = malloc(len ? len : 1);
    bool ok = chunk != NULL;

    if (ok) {
        int fd = open(d->s->path, O_RDONLY | O_BINARY);
        ok = fd >= 0
            && pf_lb_pread(fd, chunk, span, sizeof(zend_file_cache_metainfo) + (size_t)e->span_off)
            && pf_lb_pread(fd, chunk + span, e->str_len, d->s->bstr_base + e->str_off);
        if (fd >= 0) {
            close(fd);
        }
    }
    ok = ok && zend_adler32(ADLER32_INIT, (unsigned char*)chunk, len) == e->adler;
    if (ok) {
        zend_op_array tmp;
        zend_persistent_script fake;
        void *saved_mem = ZCG(mem);

        memset(&tmp, 0, sizeof(tmp));
        memset(&fake, 0, sizeof(fake));
        tmp.literals = (zval*)d->lit;
        tmp.last_literal = d->last_literal;
        tmp.opcodes = (zend_op*)d->ops;
        tmp.last = d->last;
        tmp.live_range = (zend_live_range*)d->lr;
        tmp.last_live_range = d->last_live_range;
        tmp.try_catch_array = (zend_try_catch_element*)d->tc;
        tmp.last_try_catch = d->last_try_catch;
        fake.mem = d->s->head;
        fake.size = d->s->full_size;
        fake.corrupted = false;
        pf_lz.chunk = chunk;
        pf_lz.head = d->s->head;
        pf_lz.len = len;
        pf_lz.lo = e->span_off;
        pf_lz.hi = (size_t)e->span_off + span;
        pf_lz.tail = d->s->tail;
        pf_lz.bad = false;
        ZCG(mem) = chunk + span;
        pf_lb_unserialize_body(&tmp, &fake, NULL);
        ZCG(mem) = saved_mem;
        ok = !pf_lz.bad;
        pf_lz.chunk = NULL;
        if (ok) {
            d->literals = tmp.literals;
            d->opcodes = tmp.opcodes;
            d->live_range = tmp.live_range;
            d->try_catch_array = tmp.try_catch_array;
        }
    }
    pf_lb_body_load_ns += (uint64_t)(zend_hrtime() - t0);
    if (!ok) {
        free(chunk);
        pf_lb_body_fail++;
        return FAILURE;
    }
    d->chunk = chunk;
    d->loaded = true;
    pf_lb_body_loads++;
    pf_lb_body_bytes_loaded += len;
    pf_lb_body_bytes_resident += len;
    return SUCCESS;
}

static void pf_lb_set(zend_op_array *op_array, const pf_lb_desc *d)
{
    op_array->literals = d->literals;
    op_array->last_literal = d->last_literal;
    op_array->live_range = d->live_range;
    op_array->last_live_range = d->last_live_range;
    op_array->try_catch_array = d->try_catch_array;
    op_array->last_try_catch = d->last_try_catch;
    op_array->last = d->last;
    op_array->opcodes = d->opcodes; /* last: the op_array reads as loaded only when all of it is */
}

/* a loaded body goes into every shared-memory op_array of it, and into op_array if that is a copy */
static void pf_lb_install(zend_op_array *op_array, const pf_lb_desc *d)
{
    bool listed = false;
    for (uint32_t i = 0; i < d->n_oa; i++) {
        if (zend_pf_lazy_body_pending(d->oas[i])) {
            pf_lb_set(d->oas[i], d);
        }
        listed = listed || d->oas[i] == op_array;
    }
    if (!listed && zend_pf_lazy_body_pending(op_array)) {
        pf_lb_set(op_array, d);
        pf_lb_copy_installs++;
    }
}

static void pf_lb_throw(const zend_op_array *op_array, const pf_lb_desc *d)
{
    zend_throw_error(NULL, "Cannot load the body of %s%s%s() from %s",
        op_array->scope ? ZSTR_VAL(op_array->scope->name) : "", op_array->scope ? "::" : "",
        op_array->function_name ? ZSTR_VAL(op_array->function_name) : "{main}",
        d ? d->s->path : "(no body descriptor)");
}

static zend_result pf_lb_ensure(zend_op_array *op_array, bool may_throw)
{
    pf_lb_desc *d;
    if (!zend_pf_lazy_body_pending(op_array)) {
        return SUCCESS;
    }
    d = pf_lb_slot >= 0 ? (pf_lb_desc*)op_array->reserved[pf_lb_slot] : NULL;
    if (!d || (!d->loaded && pf_lb_load(d) != SUCCESS)) {
        if (may_throw && !EG(exception)) {
            pf_lb_throw(op_array, d);
        }
        return FAILURE;
    }
    pf_lb_install(op_array, d);
    return SUCCESS;
}

/* the trampoline: load (or install) the body, then continue at real + k; or throw and install nothing */
static int pf_lb_handler(zend_execute_data *execute_data)
{
    zend_op_array *op_array = &EX(func)->op_array;
    uint32_t k = EX(opline)->extended_value;

    if (UNEXPECTED(k >= PF_LB_STUB_LEN) || UNEXPECTED(pf_lb_ensure(op_array, false) != SUCCESS)) {
        if (k < PF_LB_STUB_LEN) {
            pf_lb_stub[k].lineno = op_array->line_start; /* the Error's line: the declaration */
        }
        pf_lb_throw(op_array, pf_lb_slot >= 0 ? (const pf_lb_desc*)op_array->reserved[pf_lb_slot] : NULL);
        return ZEND_USER_OPCODE_CONTINUE;
    }
    EX(opline) = op_array->opcodes + k;
    return ZEND_USER_OPCODE_CONTINUE;
}

void pf_lb_startup(void)
{
    zend_op op;
    int slot = zend_get_resource_handle("pagefeather lazy bodies");

    if (slot < 0) {
        zend_accel_error(ACCEL_LOG_WARNING, "pagefeather lazy bodies: no op_array slot; bodies load eagerly\n");
        return;
    }
    memset(&op, 0, sizeof(op));
    op.opcode = ZEND_USER_OPCODE;
    op.op1_type = IS_UNUSED;
    op.op2_type = IS_UNUSED;
    op.result_type = IS_UNUSED;
    zend_vm_set_opcode_handler(&op); /* the ZEND_USER_OPCODE handler, which dispatches on the op's own opcode */
    for (uint32_t i = 0; i < PF_LB_STUB_LEN; i++) {
        pf_lb_stub[i] = op;
        pf_lb_stub[i].opcode = ZEND_PF_LAZY_BODY;
        pf_lb_stub[i].extended_value = i;
    }
    if (zend_set_user_opcode_handler(ZEND_PF_LAZY_BODY, pf_lb_handler) != SUCCESS) {
        zend_accel_error(ACCEL_LOG_WARNING, "pagefeather lazy bodies: the trampoline opcode is taken; bodies load eagerly\n");
        return;
    }
    pf_lb_slot = slot;
    zend_pf_lazy_body_slot = slot;
    zend_pf_lazy_body_ensure = pf_lb_ensure;
}

/* the real counts of a body not loaded yet (the M1 stats module reads them); false when it is not lazy */
bool pf_lb_real_counts(const zend_op_array *op_array, uint32_t counts[4])
{
    const pf_lb_desc *d;
    if (!zend_pf_lazy_body_pending(op_array) || pf_lb_slot < 0 || !(d = op_array->reserved[pf_lb_slot])) {
        return false;
    }
    counts[0] = d->last;
    counts[1] = d->last_literal;
    counts[2] = d->last_live_range;
    counts[3] = d->last_try_catch;
    return true;
}

''')
edit(FC, [
 ("static void zend_file_cache_unserialize_op_array(zend_op_array           *op_array,\n",
  RUNTIME + "static void zend_file_cache_unserialize_op_array(zend_op_array           *op_array,\n"),
])

# script_load: head only when lazy
edit(FC, [
 ("\tsize_t orig_map_ptr_last = 0;\n\n\tif (!full_path) {\n",
  "\tsize_t orig_map_ptr_last = 0;\n"
  "\tbool pf_lazy; /* " + T + ": read only the head now, each body at its first call */\n"
  "\tsize_t pf_head;\n\tint pf_fd = -1;\n\tpf_lb_script *pf_s = NULL;\n\tpf_lb_desc *pf_descs = NULL;\n\tuint32_t pf_n = 0;\n"
  "\n\tif (!full_path) {\n"),
 ("\tcheckpoint = zend_arena_checkpoint(CG(arena));\n#if defined(__AVX__) || defined(__SSE2__)\n\t/* Align to 64-byte boundary */\n"
  "\tmem = zend_arena_alloc(&CG(arena), info.mem_size + info.str_size + info.pf_bstr_size + 64);\n\tmem = (void*)(((uintptr_t)mem + 63L) & ~63L);\n#else\n"
  "\tmem = zend_arena_alloc(&CG(arena), info.mem_size + info.str_size + info.pf_bstr_size);\n#endif\n\n"
  "\tif (read(fd, mem, info.mem_size + info.str_size + info.pf_bstr_size) != (ssize_t)(info.mem_size + info.str_size + info.pf_bstr_size)) {\n",
  "\t/* " + T + ": lazy only for a split file with no tail crossings, into shared memory */\n"
  "\tpf_lazy = pf_lb_lazy_ok() && info.pf_body_size != 0 && info.pf_xref == 0 && (size_t)info.pf_body_offset + info.pf_body_size == info.mem_size;\n"
  "\tpf_head = pf_lazy ? info.pf_body_offset : info.mem_size;\n"
  "\tcheckpoint = zend_arena_checkpoint(CG(arena));\n"
  "\tmem = pf_lb_arena(pf_lb_read_size(&info, pf_lazy)); /* aligned to 64 bytes, as upstream */\n\n"
  "\tif (!pf_lb_read(fd, mem, &info, pf_lazy)) {\n"),
 ("\tclose(fd);\n\n\t/* verify checksum */\n\tif (ZCG(accel_directives).file_cache_consistency_checks &&\n"
  "\t    (actual_checksum = zend_adler32(ADLER32_INIT, mem, info.mem_size + info.str_size + info.pf_bstr_size)) != info.checksum) {\n"
  "\t\tzend_accel_error(ACCEL_LOG_WARNING, \"corrupted file '%s' excepted checksum: 0x%08x actual checksum: 0x%08x\\n\", filename, info.checksum, actual_checksum);\n",
  "\tif (pf_lazy) {\n\t\tpf_fd = fd; /* " + T + ": kept open in case the script must go to process memory whole */\n\t} else {\n\t\tclose(fd);\n\t}\n\n"
  "\t/* verify checksum */\n\tif (ZCG(accel_directives).file_cache_consistency_checks &&\n"
  "\t    (actual_checksum = zend_adler32(ADLER32_INIT, mem, pf_lb_read_size(&info, pf_lazy))) != (pf_lazy ? info.pf_head_checksum : info.checksum)) {\n"
  "\t\tzend_accel_error(ACCEL_LOG_WARNING, \"corrupted file '%s' excepted checksum: 0x%08x actual checksum: 0x%08x\\n\", filename, pf_lazy ? info.pf_head_checksum : info.checksum, actual_checksum);\n"
  "\t\tif (pf_fd >= 0) {\n\t\t\tclose(pf_fd);\n\t\t}\n"),
 ("\t\t\tif (!script->corrupted) {\n\t\t\t\tzend_shared_alloc_unlock();\n\t\t\t\tzend_arena_release(&CG(arena), checkpoint);\n\t\t\t\tefree(filename);\n\t\t\t\treturn script;\n",
  "\t\t\tif (!script->corrupted) {\n\t\t\t\tzend_shared_alloc_unlock();\n\t\t\t\tzend_arena_release(&CG(arena), checkpoint);\n\t\t\t\tefree(filename);\n"
  "\t\t\t\tif (pf_fd >= 0) {\n\t\t\t\t\tclose(pf_fd); /* " + T + " */\n\t\t\t\t}\n\t\t\t\treturn script;\n"),
 ("\t\tbuf = zend_shared_alloc_aligned(info.mem_size);\n", "\t\tbuf = zend_shared_alloc_aligned(pf_head); /* " + T + ": the head only, when lazy */\n"),
 ("\t\tmemcpy(buf, mem, info.mem_size);\n", "\t\tmemcpy(buf, mem, pf_head);\n"),
 ("use_process_mem:\n\t\tbuf = mem;\n\t\tcache_it = false;\n",
  "use_process_mem:\n"
  "\t\tif (pf_lazy) { /* " + T + ": process memory holds the whole script, so read all of it now */\n"
  "\t\t\tpf_lb_free_script(pf_s, pf_descs, pf_n);\n\t\t\tpf_s = NULL;\n\t\t\tpf_descs = NULL;\n"
  "\t\t\tpf_lazy = false;\n\t\t\tpf_head = info.mem_size;\n\t\t\tmem = pf_lb_arena(pf_lb_read_size(&info, false));\n"
  "\t\t\tif (!pf_lb_read(pf_fd, mem, &info, false) || (ZCG(accel_directives).file_cache_consistency_checks &&\n"
  "\t\t\t    zend_adler32(ADLER32_INIT, mem, pf_lb_read_size(&info, false)) != info.checksum)) {\n"
  "\t\t\t\tzend_accel_error(ACCEL_LOG_WARNING, \"opcache cannot read from file '%s' (whole, for process memory)\\n\", filename);\n"
  "\t\t\t\tclose(pf_fd);\n\t\t\t\tzend_arena_release(&CG(arena), checkpoint);\n\t\t\t\tefree(filename);\n\t\t\t\treturn NULL;\n\t\t\t}\n"
  "\t\t\tclose(pf_fd);\n\t\t\tpf_fd = -1;\n\t\t}\n"
  "\t\tbuf = mem;\n\t\tcache_it = false;\n"),
 ("\tZCG(mem) = ((char*)mem + info.mem_size);\n\tpf_load_bstr = (char*)mem + info.mem_size + info.str_size; /* pagefeather lazy bodies (#582 M2b) */\n"
  "\tscript = (zend_persistent_script*)((char*)buf + info.script_offset);\n\tscript->corrupted = !cache_it; /* used to check if script restored to SHM or process memory */\n",
  "\tZCG(mem) = ((char*)mem + pf_head);\n"
  "\tpf_load_bstr = pf_lazy ? NULL : (char*)mem + info.mem_size + info.str_size; /* pagefeather lazy bodies (#582 M2b) */\n"
  "\tscript = (zend_persistent_script*)((char*)buf + info.script_offset);\n\tscript->corrupted = !cache_it; /* used to check if script restored to SHM or process memory */\n"
  "\tif (pf_lazy) { /* " + T + ": one descriptor per directory entry, filled while the head is unserialized */\n"
  "\t\tpf_n = script->pf_body_dir_n;\n"
  "\t\tpf_s = calloc(1, sizeof(*pf_s));\n\t\tpf_descs = calloc(pf_n ? pf_n : 1, sizeof(*pf_descs));\n"
  "\t\tif (pf_s) {\n\t\t\tpf_s->path = strdup(filename);\n\t\t}\n"
  "\t\tif (!pf_s || !pf_descs || !pf_s->path) {\n"
  "\t\t\tzend_error_noreturn(E_ERROR, \"pagefeather lazy bodies: out of memory loading '%s'\", filename);\n\t\t}\n"
  "\t\tpf_s->head = buf;\n\t\tpf_s->full_size = info.mem_size;\n\t\tpf_s->tail = info.pf_body_offset;\n"
  "\t\tpf_s->bstr_base = sizeof(info) + (size_t)info.mem_size + info.str_size;\n"
  "\t\tpf_lzh.s = pf_s;\n\t\tpf_lzh.descs = pf_descs;\n\t\tpf_lzh.n = pf_n;\n\t}\n"),
 ("\tzend_try {\n\t\tzend_file_cache_unserialize(script, buf);\n\t} zend_catch {\n\t\tok = false;\n\t} zend_end_try();\n",
  "\tzend_try {\n\t\tzend_file_cache_unserialize(script, buf);\n\t} zend_catch {\n\t\tok = false;\n\t} zend_end_try();\n"
  "\tpf_lzh.s = NULL; /* " + T + " */\n\tpf_lzh.descs = NULL;\n\tpf_lzh.n = 0;\n"),
 ("\t\t} else {\n\t\t\tzend_arena_release(&CG(arena), checkpoint);\n\t\t\tefree(filename);\n\t\t\treturn NULL;\n\t\t}\n\t}\n\n\tscript->corrupted = false;\n",
  "\t\t} else {\n\t\t\tzend_arena_release(&CG(arena), checkpoint);\n\t\t\tefree(filename);\n"
  "\t\t\tif (pf_fd >= 0) {\n\t\t\t\tclose(pf_fd); /* " + T + " */\n\t\t\t}\n\t\t\treturn NULL;\n\t\t}\n\t}\n\n\tscript->corrupted = false;\n"
  "\tif (pf_lazy) { /* " + T + " */\n\t\tpf_s->dir = script->pf_body_dir;\n\t\tscript->size = pf_head;\n\t\tpf_lb_lazy_scripts++;\n"
  "\t} else if (info.pf_body_size) {\n\t\tpf_lb_eager_scripts++;\n\t\tif (info.pf_xref) {\n\t\t\tpf_lb_xref_scripts++;\n\t\t}\n\t}\n"
  "\tif (pf_fd >= 0) {\n\t\tclose(pf_fd);\n\t\tpf_fd = -1;\n\t}\n"),
])
print("apply-m2b-lazy: all anchors applied")
