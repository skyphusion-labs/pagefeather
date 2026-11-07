import io, sys
eng = sys.argv[1]
s = io.open(eng, encoding="utf-8").read()
# 1. static cache props
o1 = "\tprivate $last_sqlite_queries = array();\n"
n1 = ("\tprivate $last_sqlite_queries = array();\n\n"
      "\t// AST cache (build-time patch, issue #173): per-request (php-wasm clears\n"
      "\t// userland state between requests), keyed on sql_mode + version + the raw\n"
      "\t// MySQL string. The AST is read-only after parse, so it is reused directly\n"
      "\t// (no clone). BOOTSTRAP_AST_CACHE='off' bypasses. Bounded FIFO.\n"
      "\tpublic static $ast_cache = array();\n"
      "\tpublic static $ast_cache_hits = 0;\n"
      "\tpublic static $ast_cache_misses = 0;\n"
      "\tpublic static $ast_cache_cap = 512;\n")
if s.count(o1) != 1: sys.exit("props count %d" % s.count(o1))
s = s.replace(o1, n1)
# 2. cache-aware parse block
o2 = ("\t\t\t// Parse the MySQL query.\n"
      "\t\t\t$parser = $this->create_parser( $query );\n"
      "\t\t\t$parser->next_query();\n"
      "\t\t\t$ast = $parser->get_query_ast();\n"
      "\t\t\tif ( null === $ast ) {\n"
      "\t\t\t\tthrow $this->new_driver_exception( 'Failed to parse the MySQL query.' );\n"
      "\t\t\t}\n"
      "\n"
      "\t\t\tif ( $parser->next_query() ) {\n"
      "\t\t\t\tthrow $this->new_driver_exception( 'Multi-query is not supported.' );\n"
      "\t\t\t}\n")
n2 = ("\t\t\t// Parse the MySQL query, through the AST cache (issue #173).\n"
      "\t\t\t$ast_off = defined( 'BOOTSTRAP_AST_CACHE' ) && 'off' === BOOTSTRAP_AST_CACHE;\n"
      "\t\t\t$ast_key = implode( ',', $this->get_active_sql_mode_names() ) . \"\\x1e\" . $this->mysql_version . \"\\x1e\" . $query;\n"
      "\t\t\tif ( ! $ast_off && isset( self::$ast_cache[ $ast_key ] ) ) {\n"
      "\t\t\t\t$ast = self::$ast_cache[ $ast_key ];\n"
      "\t\t\t\t++self::$ast_cache_hits;\n"
      "\t\t\t} else {\n"
      "\t\t\t\t$parser = $this->create_parser( $query );\n"
      "\t\t\t\t$parser->next_query();\n"
      "\t\t\t\t$ast = $parser->get_query_ast();\n"
      "\t\t\t\tif ( null === $ast ) {\n"
      "\t\t\t\t\tthrow $this->new_driver_exception( 'Failed to parse the MySQL query.' );\n"
      "\t\t\t\t}\n"
      "\t\t\t\tif ( $parser->next_query() ) {\n"
      "\t\t\t\t\tthrow $this->new_driver_exception( 'Multi-query is not supported.' );\n"
      "\t\t\t\t}\n"
      "\t\t\t\t++self::$ast_cache_misses;\n"
      "\t\t\t\tif ( ! $ast_off ) {\n"
      "\t\t\t\t\tif ( count( self::$ast_cache ) >= self::$ast_cache_cap ) {\n"
      "\t\t\t\t\t\tarray_shift( self::$ast_cache );\n"
      "\t\t\t\t\t}\n"
      "\t\t\t\t\tself::$ast_cache[ $ast_key ] = $ast;\n"
      "\t\t\t\t}\n"
      "\t\t\t}\n")
if s.count(o2) != 1: sys.exit("parse block count %d" % s.count(o2))
s = s.replace(o2, n2)
io.open(eng, "w", encoding="utf-8").write(s)
print("AST cache patch applied")
