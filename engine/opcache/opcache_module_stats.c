/**
 * The pagefeather engine (#582 S4, M1): WordPress Playground's static-build glue for the opcache
 * extension (packages/php-wasm/compile/opcache/opcache_module.c at dcd8e50, GPL-2.0-or-later), plus a
 * MEASUREMENT of the payoff of OPcache lazy function bodies. Built only with ENGINE_OPCACHE_STATS=1;
 * never shipped.
 *
 * At the end of each request (RSHUTDOWN, before the executor frees the function and class tables) it
 * counts every declared user function and method, and the bytes of its body (opcodes, literals with their
 * string payloads, live ranges, try/catch), de-duplicated by the opcodes pointer, since inherited methods
 * share one body. An observer (its init runs once per function per request, on first call) marks which
 * of them ran. pagefeather_opcache_stats() returns the counts of the PREVIOUS request.
 * Literal strings may be interned and shared, so their bytes are an upper bound.
 */

#include "php.h"
#include "php_opcache.h"
#include "Zend/zend_extensions.h"
#include "Zend/zend_observer.h"

static HashTable *pf_called = NULL;
static zend_long pf_last[6]; /* declared, called, declared bytes, called bytes, requests counted, main scripts */

static size_t pf_body_bytes(const zend_op_array *op)
{
	size_t n = (size_t)op->last * sizeof(zend_op) + (size_t)op->last_literal * sizeof(zval)
		+ (size_t)op->last_live_range * sizeof(zend_live_range) + (size_t)op->last_try_catch * sizeof(zend_try_catch_element);
	uint32_t i;
	for (i = 0; i < (uint32_t)op->last_literal; i++) {
		zval *z = &op->literals[i];
		if (Z_TYPE_P(z) == IS_STRING) {
			n += _ZSTR_STRUCT_SIZE(ZSTR_LEN(Z_STR_P(z)));
		}
	}
	return n;
}

static zend_observer_fcall_handlers pf_observer_init(zend_execute_data *execute_data)
{
	zend_function *f = execute_data->func;
	if (f && f->type == ZEND_USER_FUNCTION && f->op_array.function_name) {
		if (!pf_called) {
			ALLOC_HASHTABLE(pf_called);
			zend_hash_init(pf_called, 1024, NULL, NULL, 0);
		}
		zend_hash_index_add_empty_element(pf_called, (zend_ulong)(uintptr_t)f->op_array.opcodes);
	}
	return (zend_observer_fcall_handlers){NULL, NULL};
}

static void pf_count(zend_function *f, HashTable *seen, zend_long *c)
{
	zend_ulong key;
	size_t bytes;
	if (!f || f->type != ZEND_USER_FUNCTION || !f->op_array.function_name || !f->op_array.opcodes) {
		return;
	}
	key = (zend_ulong)(uintptr_t)f->op_array.opcodes;
	if (zend_hash_index_exists(seen, key)) {
		return;
	}
	zend_hash_index_add_empty_element(seen, key);
	bytes = pf_body_bytes(&f->op_array);
	c[0]++;
	c[2] += (zend_long)bytes;
	if (pf_called && zend_hash_index_exists(pf_called, key)) {
		c[1]++;
		c[3] += (zend_long)bytes;
	}
}

PHP_MINIT_FUNCTION(opcache)
{
	/* NOTE (upstream): zend_extension_entry is the opcache-specific variable of ZendAccelerator.c. */
	extern zend_extension zend_extension_entry;
	zend_observer_fcall_register(pf_observer_init);
	zend_register_extension(&zend_extension_entry, NULL);
	return SUCCESS;
}

PHP_MSHUTDOWN_FUNCTION(opcache)
{
	return SUCCESS;
}

PHP_RSHUTDOWN_FUNCTION(opcache)
{
	zend_long c[6] = {0, 0, 0, 0, 0, 0};
	HashTable seen;
	zend_function *f;
	zend_class_entry *ce;
	zend_hash_init(&seen, 4096, NULL, NULL, 0);
	ZEND_HASH_FOREACH_PTR(EG(function_table), f) {
		pf_count(f, &seen, c);
	} ZEND_HASH_FOREACH_END();
	ZEND_HASH_FOREACH_PTR(EG(class_table), ce) {
		if (ce && ce->type == ZEND_USER_CLASS) {
			ZEND_HASH_FOREACH_PTR(&ce->function_table, f) {
				pf_count(f, &seen, c);
			} ZEND_HASH_FOREACH_END();
		}
	} ZEND_HASH_FOREACH_END();
	zend_hash_destroy(&seen);
	if (pf_called) {
		zend_hash_destroy(pf_called);
		FREE_HASHTABLE(pf_called);
		pf_called = NULL;
	}
	c[4] = pf_last[4] + 1;
	memcpy(pf_last, c, sizeof(pf_last));
	return SUCCESS;
}

ZEND_BEGIN_ARG_WITH_RETURN_TYPE_INFO_EX(arginfo_pagefeather_opcache_stats, 0, 0, IS_ARRAY, 0)
ZEND_END_ARG_INFO()

PHP_FUNCTION(pagefeather_opcache_stats)
{
	ZEND_PARSE_PARAMETERS_NONE();
	array_init(return_value);
	add_assoc_long(return_value, "declared_functions", pf_last[0]);
	add_assoc_long(return_value, "called_functions", pf_last[1]);
	add_assoc_long(return_value, "declared_body_bytes", pf_last[2]);
	add_assoc_long(return_value, "called_body_bytes", pf_last[3]);
	add_assoc_long(return_value, "requests", pf_last[4]);
	add_assoc_long(return_value, "sizeof_zend_op", (zend_long)sizeof(zend_op));
}

static const zend_function_entry pf_functions[] = {
	PHP_FE(pagefeather_opcache_stats, arginfo_pagefeather_opcache_stats)
	PHP_FE_END
};

zend_module_entry opcache_module_entry = {
	STANDARD_MODULE_HEADER,
	"opcache",
	pf_functions,
	PHP_MINIT(opcache),
	PHP_MSHUTDOWN(opcache),
	NULL, /* RINIT */
	PHP_RSHUTDOWN(opcache),
	NULL, /* MINFO */
	PHP_VERSION,
	STANDARD_MODULE_PROPERTIES
};
