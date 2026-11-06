// Run checkStatement() of sql-import.js on every line of a mysql-prepare.py
// output, as /_sqlimport would before it runs any (issue #31).
//   node sqlimport-file.mjs <.mjs copy of sql-import.js> <file.jsonl>
import { readFileSync } from 'node:fs';
const { checkStatement } = await import(process.argv[2]);
const lines = readFileSync(process.argv[3], 'utf8').split('\n').filter(Boolean);
let bad = 0;
for (let i = 0; i < lines.length; i++) {
	const why = checkStatement(JSON.parse(lines[i]).sql);
	if (why && bad++ < 5) console.log(`line ${i + 1}: ${why}: ${JSON.parse(lines[i]).sql.slice(0, 100)}`);
}
console.log(`${lines.length} statements, ${bad} refused`);
process.exit(bad ? 1 : 0);
