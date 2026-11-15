"""#582 S4 M2b, stage 1 (store side, loaded EAGERLY), on top of the M2a patch (engine/opcache/pf-lazy-bodies.patch).
Usage: apply-m2b-store.py <php-src root>. Every anchor must occur exactly once.

- Each lazy-eligible op_array's body is one contiguous span of the M2a tail. Persist records the spans in a
  per-script body directory (pf_body_dir, allocated at the end of the head; calc sizes it).
- Eligible now also excludes closures and functions with PF_LB_STUB_LEN or more declared args (M2b design 1).
- The store writes each body's INTERNED literal strings to that body's own string table (dedup within the body,
  never through the xlat table), appended after the script's string section; the directory records each
  table's offset and length and an adler32 over [span | table]. Non-interned strings and arrays a body points
  at stay offsets into the block (a lazy load resolves those below the body start against the resident head).
- The load still reads and unserializes everything: a body's literals resolve interned strings against its own
  table. So behaviour is unchanged; the gates prove the format. Stage 2 makes the load lazy.
- The system id entropy is pagefeather-lazy-body-2: M2a files are refused, never misread."""
import sys, os
root = sys.argv[1]
def edit(rel, pairs):
    p = os.path.join(root, rel); s = open(p).read()
    for old, new in pairs:
        assert s.count(old) == 1, (rel, s.count(old), old[:110])
        s = s.replace(old, new)
    open(p, "w").write(s)
T = "/* pagefeather lazy bodies (#582 M2b) */"

# ---- header: the directory entry, its place in the persistent script, the stub length
edit("ext/opcache/ZendAccelerator.h", [
 ("typedef struct _zend_persistent_script {",
  "/* pagefeather lazy bodies (#582 M2b): one lazy body. span_* locate it in the block (mem offsets); str_* its\n"
  " * own interned-string table in the file (offsets into the body-string section); adler covers [span | table]. */\n"
  "typedef struct _pf_body_dir_entry {\n\tuint32_t span_off, span_len, str_off, str_len, adler;\n} pf_body_dir_entry;\n"
  "#define PF_LB_STUB_LEN 256 /* a lazy function declares fewer args than this (the trampoline length) */\n"
  "extern uint32_t pf_lb_dir_total, pf_lb_dir_mismatch;\n\n"
  "typedef struct _zend_persistent_script {"),
 ("\tsize_t         pf_body_size;           /* pagefeather lazy bodies (#582 M2a): the last pf_body_size bytes of mem are function bodies */\n",
  "\tsize_t         pf_body_size;           /* pagefeather lazy bodies (#582 M2a): the last pf_body_size bytes of mem are function bodies */\n"
  "\tpf_body_dir_entry *pf_body_dir;        " + T + " the body directory, at the end of the head (NULL when unsplit) */\n"
  "\tuint32_t       pf_body_dir_n;          " + T + " its entries (calc sets the expected count, persist the real one) */\n"),
])
# fix the two comments that the T + prose construction above leaves open
p = os.path.join(root, "ext/opcache/ZendAccelerator.h"); s = open(p).read()
s = s.replace(T + " the body directory, at the end of the head (NULL when unsplit) */", "/* pagefeather lazy bodies (#582 M2b): the body directory, at the end of the head (NULL when unsplit) */")
s = s.replace(T + " its entries (calc sets the expected count, persist the real one) */", "/* pagefeather lazy bodies (#582 M2b): its entries (calc sets the expected count, persist the real one) */")
open(p, "w").write(s)

ELIG_EXTRA = " && !(op_array->fn_flags & ZEND_ACC_CLOSURE) && op_array->num_args < PF_LB_STUB_LEN"
# ---- calc: the same eligibility, count the directory, size it at the end of the head
edit("ext/opcache/zend_persist_calc.c", [
 ("\tbool pf_lb_eligible = pf_lb_active && op_array != &ZCG(current_persistent_script)->script.main_op_array;",
  "\tbool pf_lb_eligible = pf_lb_active && op_array != &ZCG(current_persistent_script)->script.main_op_array" + ELIG_EXTRA + ";"),
 ("\tPF_LB_CALC_BEGIN(pf_lb_eligible);\n\tif (op_array->literals) {",
  "\tif (pf_lb_eligible) {\n\t\tpf_lb_dir_calc_n++; /* pagefeather lazy bodies (#582 M2b): one directory entry per body */\n\t}\n\tPF_LB_CALC_BEGIN(pf_lb_eligible);\n\tif (op_array->literals) {"),
 ("#define PF_LB_CALC_END() do { pf_lb_in_body = false; } while (0)\n",
  "#define PF_LB_CALC_END() do { pf_lb_in_body = false; } while (0)\nstatic uint32_t pf_lb_dir_calc_n = 0; /* pagefeather lazy bodies (#582 M2b) */\n"),
 ("\tpf_lb_active = for_shm != 0;\n\tpf_lb_in_body = false;\n\tpf_lb_body_size = 0;\n",
  "\tpf_lb_active = for_shm != 0;\n\tpf_lb_in_body = false;\n\tpf_lb_body_size = 0;\n\tpf_lb_dir_calc_n = 0;\n\tnew_persistent_script->pf_body_dir = NULL;\n\tnew_persistent_script->pf_body_dir_n = 0;\n"),
 ("\tnew_persistent_script->pf_body_size = pf_lb_body_size;\n\tnew_persistent_script->size += pf_lb_body_size;\n",
  "\t/* pagefeather lazy bodies (#582 M2b): the body directory is the last head allocation */\n"
  "\tif (pf_lb_dir_calc_n) {\n\t\tADD_SIZE(sizeof(pf_body_dir_entry) * pf_lb_dir_calc_n);\n\t}\n"
  "\tnew_persistent_script->pf_body_dir_n = pf_lb_dir_calc_n;\n"
  "\tnew_persistent_script->pf_body_size = pf_lb_body_size;\n\tnew_persistent_script->size += pf_lb_body_size;\n"),
])

# ---- persist: the same eligibility; record each body span; write the directory at the end of the head
edit("ext/opcache/zend_persist.c", [
 ("uint64_t pf_lb_body_bytes = 0;\n",
  "uint64_t pf_lb_body_bytes = 0;\n"
  "uint32_t pf_lb_dir_total = 0, pf_lb_dir_mismatch = 0; /* pagefeather lazy bodies (#582 M2b) */\n"
  "static pf_body_dir_entry *pf_lb_dir_tmp = NULL;\nstatic uint32_t pf_lb_dir_n = 0, pf_lb_dir_cap = 0;\n"
  "static void pf_lb_dir_push(uint32_t off, uint32_t len)\n{\n"
  "\tif (pf_lb_dir_n == pf_lb_dir_cap) {\n\t\tpf_lb_dir_cap = pf_lb_dir_cap ? pf_lb_dir_cap * 2 : 256;\n"
  "\t\tpf_lb_dir_tmp = perealloc(pf_lb_dir_tmp, sizeof(pf_body_dir_entry) * pf_lb_dir_cap, 1);\n\t}\n"
  "\tpf_lb_dir_tmp[pf_lb_dir_n].span_off = off;\n\tpf_lb_dir_tmp[pf_lb_dir_n].span_len = len;\n"
  "\tpf_lb_dir_tmp[pf_lb_dir_n].str_off = 0;\n\tpf_lb_dir_tmp[pf_lb_dir_n].str_len = 0;\n\tpf_lb_dir_tmp[pf_lb_dir_n].adler = 0;\n"
  "\tpf_lb_dir_n++;\n}\n"),
 ("\tbool pf_lb_eligible = main_persistent_script == NULL; /* pagefeather lazy bodies (#582 M2a) */\n",
  "\tbool pf_lb_eligible = main_persistent_script == NULL" + ELIG_EXTRA + "; /* pagefeather lazy bodies (#582 M2a, M2b) */\n\tchar *pf_s0 = NULL;\n"),
 ("\tPF_LB_BEGIN(pf_lb_eligible && op_array->literals);\n",
  "\tif (pf_lb_eligible && pf_lb_active) {\n\t\tpf_s0 = (char*)pf_lb_body_mem; /* pagefeather lazy bodies (#582 M2b): the body span starts here */\n\t}\n\tPF_LB_BEGIN(pf_lb_eligible && op_array->literals);\n"),
 ("\tif (op_array->try_catch_array) {\n\t\tPF_LB_BEGIN(pf_lb_eligible);\n\t\top_array->try_catch_array = zend_shared_memdup_put_free(op_array->try_catch_array, sizeof(zend_try_catch_element) * op_array->last_try_catch);\n\t\tPF_LB_END();\n\t}\n",
  "\tif (op_array->try_catch_array) {\n\t\tPF_LB_BEGIN(pf_lb_eligible);\n\t\top_array->try_catch_array = zend_shared_memdup_put_free(op_array->try_catch_array, sizeof(zend_try_catch_element) * op_array->last_try_catch);\n\t\tPF_LB_END();\n\t}\n"
  "\tif (pf_s0) { /* pagefeather lazy bodies (#582 M2b): ... and ends here (before any nested function) */\n"
  "\t\tpf_lb_dir_push((uint32_t)(pf_s0 - (char*)ZCG(current_persistent_script)->mem), (uint32_t)((char*)pf_lb_body_mem - pf_s0));\n\t}\n"),
 ("\tpf_lb_active = for_shm != 0; /* pagefeather lazy bodies (#582 M2a): as in calc */\n",
  "\tpf_lb_active = for_shm != 0; /* pagefeather lazy bodies (#582 M2a): as in calc */\n\tpf_lb_dir_n = 0;\n"),
 ("\tif (script->pf_body_size) {\n\t\tchar *pf_body_start = (char*)script->mem + script->size - script->pf_body_size;\n",
  "\t/* pagefeather lazy bodies (#582 M2b): the directory, the last head allocation, sized by calc */\n"
  "\tscript->pf_body_dir = NULL;\n"
  "\tif (script->pf_body_dir_n) {\n"
  "\t\tpf_body_dir_entry *pf_dir = (pf_body_dir_entry*)ZCG(mem);\n"
  "\t\tZCG(mem) = (void*)((char*)ZCG(mem) + ZEND_ALIGNED_SIZE(sizeof(pf_body_dir_entry) * script->pf_body_dir_n));\n"
  "\t\tif (pf_lb_dir_n == script->pf_body_dir_n) {\n"
  "\t\t\tmemcpy(pf_dir, pf_lb_dir_tmp, sizeof(pf_body_dir_entry) * pf_lb_dir_n);\n\t\t\tscript->pf_body_dir = pf_dir;\n"
  "\t\t} else {\n"
  "\t\t\tpf_lb_dir_mismatch++;\n"
  "\t\t\tzend_accel_error(ACCEL_LOG_WARNING, \"pagefeather lazy bodies: %u bodies, calc said %u, in %s; stored unsplit\\n\", pf_lb_dir_n, script->pf_body_dir_n, ZSTR_VAL(script->script.filename));\n"
  "\t\t\tscript->pf_body_size = 0;\n\t\t}\n\t}\n"
  "\tif (script->pf_body_size) {\n\t\tchar *pf_body_start = (char*)script->mem + script->size - script->pf_body_size;\n"),
 ("\t\t\tZCG(mem) = pf_lb_body_mem;\n\t\t\tscript->pf_body_size = 0;\n\t\t} else {\n\t\t\tZCG(mem) = pf_lb_body_mem;\n\t\t\tpf_lb_split++;\n\t\t\tpf_lb_body_bytes += script->pf_body_size;\n\t\t}\n",
  "\t\t\tZCG(mem) = pf_lb_body_mem;\n\t\t\tscript->pf_body_size = 0;\n\t\t} else {\n\t\t\tZCG(mem) = pf_lb_body_mem;\n\t\t\tpf_lb_split++;\n\t\t\tpf_lb_body_bytes += script->pf_body_size;\n\t\t\tif (script->pf_body_dir) {\n\t\t\t\tpf_lb_dir_total += script->pf_body_dir_n;\n\t\t\t}\n\t\t}\n"),
 ("\tpf_lb_body_mem = NULL;\n\tpf_lb_active = false;\n",
  "\tif (!script->pf_body_size) { /* pagefeather lazy bodies (#582 M2b): unsplit means no directory */\n\t\tscript->pf_body_dir = NULL;\n\t\tscript->pf_body_dir_n = 0;\n\t}\n\tpf_lb_body_mem = NULL;\n\tpf_lb_active = false;\n"),
])

# ---- file cache: metainfo, body string tables on store, resolve them on (eager) load
edit("ext/opcache/zend_file_cache.c", [
 ("\tuint32_t     pf_body_size;   /* pagefeather lazy bodies (#582 M2a): its length */\n} zend_file_cache_metainfo;\n",
  "\tuint32_t     pf_body_size;   /* pagefeather lazy bodies (#582 M2a): its length */\n"
  "\tuint32_t     pf_bstr_size;   /* pagefeather lazy bodies (#582 M2b): the body-string section, after the string section */\n} zend_file_cache_metainfo;\n\n"
  "/* pagefeather lazy bodies (#582 M2b): while a body's literals are serialized, interned strings go to that body's\n"
  " * own table (pf_bstr, deduplicated within the body only); on load they resolve against it (pf_load_bstr). */\n"
  "static bool pf_bmode = false;\nstatic zend_string *pf_bstr = NULL;\nstatic size_t pf_bstr_len = 0, pf_bcur_off = 0;\nstatic HashTable pf_bdedup;\n"
  "static char *pf_load_bstr = NULL;\n"
  "static int pf_dir_find(const pf_body_dir_entry *dir, uint32_t n, size_t off)\n{\n"
  "\tuint32_t lo = 0, hi = n;\n\twhile (lo < hi) {\n\t\tuint32_t mid = lo + (hi - lo) / 2;\n"
  "\t\tif (off < dir[mid].span_off) {\n\t\t\thi = mid;\n\t\t} else if (off >= (size_t)dir[mid].span_off + dir[mid].span_len) {\n\t\t\tlo = mid + 1;\n\t\t} else {\n\t\t\treturn (int)mid;\n\t\t}\n\t}\n\treturn -1;\n}\n"
  "static void *pf_serialize_body_interned(zend_string *str)\n{\n"
  "\tzval *hit = zend_hash_index_find(&pf_bdedup, (zend_ulong)(uintptr_t)str);\n"
  "\tif (hit) {\n\t\treturn Z_PTR_P(hit);\n\t}\n"
  "\tsize_t len = ZEND_MM_ALIGNED_SIZE(_ZSTR_STRUCT_SIZE(ZSTR_LEN(str)));\n"
  "\tvoid *ret = (void*)((pf_bstr_len - pf_bcur_off) | Z_UL(1));\n"
  "\tif (pf_bstr_len + len > ZSTR_LEN(pf_bstr)) {\n\t\tsize_t new_len = pf_bstr_len + len;\n"
  "\t\tpf_bstr = zend_string_realloc(pf_bstr, ((_ZSTR_HEADER_SIZE + 1 + new_len + 4095) & ~0xfff) - (_ZSTR_HEADER_SIZE + 1), 0);\n\t}\n"
  "\tzend_string *new_str = (zend_string *) (ZSTR_VAL(pf_bstr) + pf_bstr_len);\n\tmemcpy(new_str, str, len);\n"
  "\tGC_ADD_FLAGS(new_str, IS_STR_INTERNED);\n\tGC_DEL_FLAGS(new_str, IS_STR_PERMANENT|IS_STR_CLASS_NAME_MAP_PTR);\n"
  "\tpf_bstr_len += len;\n\tzval z;\n\tZVAL_PTR(&z, ret);\n\tzend_hash_index_add_new(&pf_bdedup, (zend_ulong)(uintptr_t)str, &z);\n\treturn ret;\n}\n"),
 ("\t/* check if the same interned string was already stored */\n\tret = zend_shared_alloc_get_xlat_entry(str);\n",
  "\tif (pf_bmode) {\n\t\treturn pf_serialize_body_interned(str); /* pagefeather lazy bodies (#582 M2b) */\n\t}\n\t/* check if the same interned string was already stored */\n\tret = zend_shared_alloc_get_xlat_entry(str);\n"),
 # serialize: the body mode around an eligible op_array's literals
 ("\tif (op_array->literals) {\n\t\tzval *p, *end;\n\n\t\tSERIALIZE_PTR(op_array->literals);",
  "\tint pf_k = -1; /* pagefeather lazy bodies (#582 M2b): this op_array's directory entry, if it is a lazy body */\n"
  "\tpf_body_dir_entry *pf_dir_buf = NULL;\n"
  "\tif (script->pf_body_dir && op_array->opcodes) {\n"
  "\t\tpf_k = pf_dir_find(script->pf_body_dir, script->pf_body_dir_n, (size_t)((char*)op_array->opcodes - (char*)script->mem));\n"
  "\t\tif (pf_k >= 0) {\n"
  "\t\t\tpf_dir_buf = (pf_body_dir_entry*)((char*)buf + ((char*)script->pf_body_dir - (char*)script->mem));\n"
  "\t\t\tpf_dir_buf[pf_k].str_off = (uint32_t)pf_bstr_len;\n\t\t\tpf_bcur_off = pf_bstr_len;\n\t\t\tzend_hash_clean(&pf_bdedup);\n\t\t\tpf_bmode = true;\n\t\t}\n\t}\n"
  "\tif (op_array->literals) {\n\t\tzval *p, *end;\n\n\t\tSERIALIZE_PTR(op_array->literals);"),
])
# close the body mode right after the serialize literal loop (the first "zend_op *opline, *end;" block follows it)
p = os.path.join(root, "ext/opcache/zend_file_cache.c"); s = open(p).read()
anchor = "\t{\n\t\tzend_op *opline, *end;\n\n#if !ZEND_USE_ABS_CONST_ADDR\n\t\tzval *literals = op_array->literals;\n\t\tUNSERIALIZE_PTR(literals);\n#endif\n\n\t\tSERIALIZE_PTR(op_array->opcodes);"
assert s.count(anchor) == 1, ("serialize opcodes anchor", s.count(anchor))
s = s.replace(anchor, "\tif (pf_k >= 0) { /* pagefeather lazy bodies (#582 M2b): the body's table ends here */\n\t\tpf_bmode = false;\n\t\tpf_dir_buf[pf_k].str_len = (uint32_t)(pf_bstr_len - pf_dir_buf[pf_k].str_off);\n\t}\n" + anchor)
open(p, "w").write(s)
edit("ext/opcache/zend_file_cache.c", [
 # serialize: the directory pointer of the script
 ("\tnew_script = (zend_persistent_script*)((char*)buf + info->script_offset);\n\tSERIALIZE_STR(new_script->script.filename);\n",
  "\tnew_script = (zend_persistent_script*)((char*)buf + info->script_offset);\n\tSERIALIZE_STR(new_script->script.filename);\n\tSERIALIZE_PTR(new_script->pf_body_dir); /* pagefeather lazy bodies (#582 M2b) */\n"),
 # store: the body-string buffer, its size in the metainfo, the per-body adler32, the checksum
 ("\tZCG(mem) = zend_string_alloc(4096 - (_ZSTR_HEADER_SIZE + 1), 0);\n\n\tzend_shared_alloc_init_xlat_table();\n",
  "\tZCG(mem) = zend_string_alloc(4096 - (_ZSTR_HEADER_SIZE + 1), 0);\n"
  "\tpf_bstr = zend_string_alloc(4096 - (_ZSTR_HEADER_SIZE + 1), 0); /* pagefeather lazy bodies (#582 M2b) */\n"
  "\tpf_bstr_len = 0;\n\tpf_bmode = false;\n\tzend_hash_init(&pf_bdedup, 64, NULL, NULL, 0);\n\n\tzend_shared_alloc_init_xlat_table();\n"),
 ("\tinfo.checksum = zend_adler32(ADLER32_INIT, buf, script->size);\n\tinfo.checksum = zend_adler32(info.checksum, (unsigned char*)ZSTR_VAL(s), info.str_size);\n",
  "\tzend_hash_destroy(&pf_bdedup); /* pagefeather lazy bodies (#582 M2b) */\n"
  "\tinfo.pf_bstr_size = (uint32_t)pf_bstr_len;\n"
  "\tif (script->pf_body_dir) {\n"
  "\t\tpf_body_dir_entry *pf_d = (pf_body_dir_entry*)((char*)buf + ((char*)script->pf_body_dir - (char*)script->mem));\n"
  "\t\tfor (uint32_t i = 0; i < script->pf_body_dir_n; i++) {\n"
  "\t\t\tuint32_t a = zend_adler32(ADLER32_INIT, (unsigned char*)buf + pf_d[i].span_off, pf_d[i].span_len);\n"
  "\t\t\tpf_d[i].adler = zend_adler32(a, (unsigned char*)ZSTR_VAL(pf_bstr) + pf_d[i].str_off, pf_d[i].str_len);\n\t\t}\n\t}\n"
  "\tinfo.checksum = zend_adler32(ADLER32_INIT, buf, script->size);\n\tinfo.checksum = zend_adler32(info.checksum, (unsigned char*)ZSTR_VAL(s), info.str_size);\n"
  "\tinfo.checksum = zend_adler32(info.checksum, (unsigned char*)ZSTR_VAL(pf_bstr), info.pf_bstr_size);\n"),
 ("\t\tzend_accel_error(ACCEL_LOG_WARNING, \"opcache cannot write to file '%s': %s\\n\", filename, strerror(errno));\n\t\tzend_string_release_ex(s, 0);\n",
  "\t\tzend_accel_error(ACCEL_LOG_WARNING, \"opcache cannot write to file '%s': %s\\n\", filename, strerror(errno));\n\t\tzend_string_release_ex(s, 0);\n\t\tzend_string_release_ex(pf_bstr, 0);\n\t\tpf_bstr = NULL;\n"),
 ("\tzend_string_release_ex(s, 0);\n\tefree(mem);\n\tif (zend_file_cache_flock(fd, LOCK_UN) != 0) {",
  "\tzend_string_release_ex(s, 0);\n\tzend_string_release_ex(pf_bstr, 0); /* pagefeather lazy bodies (#582 M2b) */\n\tpf_bstr = NULL;\n\tefree(mem);\n\tif (zend_file_cache_flock(fd, LOCK_UN) != 0) {"),
 # write: the body-string section after the string section
 ("\tconst ssize_t total_size = (ssize_t)(sizeof(*info) + script->size + info->str_size);\n",
  "\tconst ssize_t total_size = (ssize_t)(sizeof(*info) + script->size + info->str_size + info->pf_bstr_size);\n"),
 ("\t\t{ .iov_base = (void *)ZSTR_VAL(s), .iov_len = info->str_size },\n\t};\n",
  "\t\t{ .iov_base = (void *)ZSTR_VAL(s), .iov_len = info->str_size },\n\t\t{ .iov_base = (void *)ZSTR_VAL(pf_bstr), .iov_len = info->pf_bstr_size }, /* pagefeather lazy bodies (#582 M2b) */\n\t};\n"),
 ("\twritten = write(fd, ZSTR_VAL(s), info->str_size);\n\tif (UNEXPECTED(written != info->str_size)) {\n\t\terrno = written == -1 ? errno : EAGAIN;\n\t\treturn false;\n\t}\n",
  "\twritten = write(fd, ZSTR_VAL(s), info->str_size);\n\tif (UNEXPECTED(written != info->str_size)) {\n\t\terrno = written == -1 ? errno : EAGAIN;\n\t\treturn false;\n\t}\n"
  "\twritten = write(fd, ZSTR_VAL(pf_bstr), info->pf_bstr_size); /* pagefeather lazy bodies (#582 M2b) */\n\tif (UNEXPECTED(written != info->pf_bstr_size)) {\n\t\terrno = written == -1 ? errno : EAGAIN;\n\t\treturn false;\n\t}\n"),
 # load: read and check the body-string section with the rest
 ("\tmem = zend_arena_alloc(&CG(arena), info.mem_size + info.str_size + 64);\n", "\tmem = zend_arena_alloc(&CG(arena), info.mem_size + info.str_size + info.pf_bstr_size + 64);\n"),
 ("\tmem = zend_arena_alloc(&CG(arena), info.mem_size + info.str_size);\n", "\tmem = zend_arena_alloc(&CG(arena), info.mem_size + info.str_size + info.pf_bstr_size);\n"),
 ("\tif (read(fd, mem, info.mem_size + info.str_size) != (ssize_t)(info.mem_size + info.str_size)) {",
  "\tif (read(fd, mem, info.mem_size + info.str_size + info.pf_bstr_size) != (ssize_t)(info.mem_size + info.str_size + info.pf_bstr_size)) {"),
 ("(actual_checksum = zend_adler32(ADLER32_INIT, mem, info.mem_size + info.str_size)) != info.checksum) {",
  "(actual_checksum = zend_adler32(ADLER32_INIT, mem, info.mem_size + info.str_size + info.pf_bstr_size)) != info.checksum) {"),
 ("\tZCG(mem) = ((char*)mem + info.mem_size);\n",
  "\tZCG(mem) = ((char*)mem + info.mem_size);\n\tpf_load_bstr = (char*)mem + info.mem_size + info.str_size; /* pagefeather lazy bodies (#582 M2b) */\n"),
])
# load: the directory pointer first, then a body's literals resolve interned strings against its own table
p = os.path.join(root, "ext/opcache/zend_file_cache.c"); s = open(p).read()
a = "static void zend_file_cache_unserialize(zend_persistent_script  *script,\n                                        void                    *buf)\n{\n"
assert s.count(a) == 1, ("unserialize anchor", s.count(a))
s = s.replace(a, a + "\tUNSERIALIZE_PTR(script->pf_body_dir); /* pagefeather lazy bodies (#582 M2b) */\n")
a = "\tif (op_array->literals) {\n\t\tzval *p, *end;\n\n\t\tUNSERIALIZE_PTR(op_array->literals);\n\t\tp = op_array->literals;\n\t\tend = p + op_array->last_literal;\n\t\twhile (p < end) {"
assert s.count(a) == 1, ("unserialize literals anchor", s.count(a))
s = s.replace(a, "\tvoid *pf_saved_mem = NULL; /* pagefeather lazy bodies (#582 M2b): a body resolves its interned strings in its own table */\n"
  "\tif (script->pf_body_dir && op_array->opcodes) {\n"
  "\t\tint pf_k = pf_dir_find(script->pf_body_dir, script->pf_body_dir_n, (size_t)op_array->opcodes);\n"
  "\t\tif (pf_k >= 0) {\n\t\t\tpf_saved_mem = ZCG(mem);\n\t\t\tZCG(mem) = pf_load_bstr + script->pf_body_dir[pf_k].str_off;\n\t\t}\n\t}\n" + a)
open(p, "w").write(s)
# restore ZCG(mem) after the unserialize literal loop: it is followed by the opcodes block
p = os.path.join(root, "ext/opcache/zend_file_cache.c"); s = open(p).read()
a = "\t{\n\t\tzend_op *opline, *end;\n\n\t\tUNSERIALIZE_PTR(op_array->opcodes);"
assert s.count(a) == 1, ("unserialize opcodes anchor", s.count(a))
s = s.replace(a, "\tif (pf_saved_mem) {\n\t\tZCG(mem) = pf_saved_mem;\n\t}\n" + a)
open(p, "w").write(s)
# ---- stats and the system id
edit("ext/opcache/zend_accelerator_module.c", [
 ("\t\tadd_assoc_long(&pf_lb, \"noregion\", pf_lb_noregion);\n",
  "\t\tadd_assoc_long(&pf_lb, \"noregion\", pf_lb_noregion);\n\t\tadd_assoc_long(&pf_lb, \"dir_entries\", pf_lb_dir_total);\n\t\tadd_assoc_long(&pf_lb, \"dir_mismatch\", pf_lb_dir_mismatch);\n"),
])
edit("ext/opcache/ZendAccelerator.c", [("\"pagefeather-lazy-body-1\"", "\"pagefeather-lazy-body-2\"")])
print("m2b store edits applied")
