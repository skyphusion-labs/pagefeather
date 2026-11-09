// Approach A entry, lean variant: identical to index-a.js but the database
// bridge is mysql-lean-bridge.js (the hand-rolled MySQL client) instead of
// mysql2. Nothing else differs, so wp-a-lean and wp-a-paid compare the MySQL
// CLIENT and nothing else: the test of whether dropping mysql2's JS heap lets
// an approach-A WooCommerce write fit under the 128 MiB isolate cap (#218).
// mysql2 is never imported here, so it is absent from this bundle entirely.
import worker, { setDbHandler } from './index.js';
import { mysqlQuery, mysqlEnd, mysqlReset } from './mysql-lean-bridge.js';

setDbHandler({ query: mysqlQuery, end: mysqlEnd, reset: mysqlReset });

export default worker;
// The cached entrypoint of the page cache (issue #63).
// PhpRuntime is re-exported so a PHP_IN_DO env on this entry can run PHP in a
// Durable Object (its own 128 MiB isolate) while the database stays external
// MySQL through Hyperdrive: the DO's db-bridge messages reach the lean client
// set by setDbHandler above, which runs in the DO isolate too (#218). That is
// the only non-container way to fit an approach-A WooCommerce write under the
// isolate cap: give PHP a separate isolate from the Worker, as b-dosql does,
// but keep the database on managed MySQL instead of the object's own SQLite.
export { Pages, PhpRuntime } from './index.js';
