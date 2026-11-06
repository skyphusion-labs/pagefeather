// Tests of checkStatement() in spikes/b2-wordpress/sql-import.js (issue #31).
//   node sqlimport-check.mjs <path to a .mjs copy of sql-import.js>
// Prints "ok" or "FAIL" per case; exit 1 on any FAIL.
const { checkStatement } = await import(process.argv[2]);
const H = "/*+ SET_VAR(sql_mode='NO_AUTO_VALUE_ON_ZERO') */";
const M = "SET STATEMENT sql_mode='NO_AUTO_VALUE_ON_ZERO' FOR ";
const allow = [
	'DROP TABLE IF EXISTS `wp_options`',
	"CREATE TABLE `wp_options` (\n  `option_id` bigint unsigned NOT NULL AUTO_INCREMENT,\n  `option_name` varchar(191) NOT NULL DEFAULT '',\n  `autoload` varchar(20) NOT NULL DEFAULT 'yes',\n  PRIMARY KEY (`option_id`),\n  UNIQUE KEY `option_name` (`option_name`),\n  KEY `autoload` (`autoload`)\n) ENGINE=InnoDB AUTO_INCREMENT=200 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_520_ci",
	"CREATE TABLE `wp_x` (`a` int NOT NULL COMMENT 'it''s fine', `p` decimal(10,2) DEFAULT '0.00') ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 ROW_FORMAT=DYNAMIC COMMENT='a table'",
	`INSERT ${H} INTO \`wp_options\` VALUES (1,'siteurl','https://a.example','yes'),(2,'blogname','It\\'s; DROP TABLE x -- INTO OUTFILE','yes')`,
	`${M}INSERT INTO \`wp_posts\` VALUES (0,-1,1.5e3,NULL,0x00FF,'a ( b ) \\\\ c "d"')`,
	`INSERT ${H} INTO \`wp_t\` (\`a\`, \`b\`) VALUES (1,'x')`,
	"INSERT INTO `wp_t` VALUES (1,'GRANT ALL ON *.* TO x; SET GLOBAL y=1; LOAD DATA')",
	"CREATE TABLE `wp_x` (`like` int, `as` int, `select_count` int)",
];
const refuse = [
	'GRANT ALL ON *.* TO `x`@`%`',
	"SET GLOBAL general_log = 'ON'",
	'SET SESSION sql_mode = ""',
	"LOAD DATA INFILE '/etc/passwd' INTO TABLE `wp_x`",
	"SELECT * FROM `wp_users` INTO OUTFILE '/tmp/x'",
	'DROP TABLE IF EXISTS `other_table`',
	'DROP TABLE `wp_options`',
	'DROP DATABASE `wordpress`',
	"INSERT INTO `other` VALUES (1)",
	"INSERT INTO `wp_x` SELECT * FROM `mysql`.`user`",
	"INSERT INTO `wp_x` VALUES (LOAD_FILE('/etc/passwd'))",
	"INSERT INTO `wp_x` VALUES ((SELECT authentication_string FROM mysql.user LIMIT 1))",
	"INSERT INTO `wp_x` VALUES (1); DROP TABLE `wp_y`",
	"INSERT INTO `wp_x` VALUES (1) ON DUPLICATE KEY UPDATE a = 2",
	"INSERT INTO `wp_x` VALUES (1) /* c */",
	"INSERT INTO `wp_x` VALUES (1) -- c",
	"INSERT INTO `wp_x` VALUES ('a\\'), (1)",
	"INSERT INTO `wp_x` VALUES (_binary 'ab')",
	"INSERT INTO `wp_x` VALUES (1) INTO OUTFILE '/tmp/x'",
	"CREATE TABLE `wp_x` (`a` int) SELECT * FROM `mysql`.`user`",
	"CREATE TABLE `wp_x` LIKE `mysql`.`user`",
	"CREATE TABLE `wp_x` (`a` int) ENGINE=InnoDB AS SELECT 1",
	"CREATE TABLE `wp_x` (`a` int COMMENT 'x\\' ) SELECT 1 -- ')",
	'CREATE TABLE `wp_x` (`a` int COMMENT "x")',
	"CREATE TABLE `wp_x` (`a` int) PARTITION BY HASH (a)",
	"CREATE TABLE `other` (`a` int)",
	"CREATE TABLE `wp_x` (`a` int)) ENGINE=InnoDB",
	"INSERT INTO `wp_x` VALUES ('never ends",
	"CREATE USER `x`",
	"CREATE TABLE `wp_x` (`a` text DEFAULT (LOAD_FILE('/etc/passwd')))",
	"CREATE TABLE `wp_x` (`a` int) ENGINE=InnoDB DATA DIRECTORY='/tmp/x'",
	"CREATE TABLE `wp_x` (`a` int) TABLESPACE `innodb_system`",
	"CREATE TABLE `wp_x` (`a` varchar(5) DEFAULT 'a\\b')",
	"CREATE TABLE `wp_x` (`a` int /* c */)",
	"CREATE TABLE `wp_x` (`a` int -- c\n)",
	"CREATE TABLE `wp_x` (`a` int GENERATED ALWAYS AS ((SELECT 1)))",
	'',
];
const reasons = [
	["INSERT INTO `wp_x` VALUES (1) ON DUPLICATE KEY UPDATE a = 2", 'between the VALUES groups'],
	["INSERT INTO `wp_x` VALUES (1); DROP TABLE `wp_y`", 'a ; or a comment'],
	["INSERT INTO `wp_x` VALUES (1) /* c */", 'a ; or a comment'],
];
let fails = 0;
for (const [s, want] of reasons) {
	const why = checkStatement(s) || '';
	if (!why.includes(want)) (fails++, console.log(`FAIL reason: ${s.slice(0, 50)}: got "${why}", want "${want}"`));
	else console.log(`ok   reason: ${s.slice(0, 50)} (${want})`);
}
for (const s of allow) {
	const why = checkStatement(s);
	if (why) (fails++, console.log(`FAIL allow: ${s.slice(0, 60)}: ${why}`));
	else console.log(`ok   allow: ${s.slice(0, 50).replace(/\n/g, ' ')}`);
}
for (const s of refuse) {
	const why = checkStatement(s);
	if (!why) (fails++, console.log(`FAIL refuse: ${s.slice(0, 60)}`));
	else console.log(`ok   refuse: ${s.slice(0, 50)} (${why.slice(0, 50)})`);
}
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
