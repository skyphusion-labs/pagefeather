// Approach A entry: the approach B Worker (index.js), with WordPress's
// database on MySQL through Hyperdrive instead of D1. Same PHP build, same
// OPcache, same page cache, same R2 media: only the database differs, so A and
// B compare the database and nothing else. mysql2 is bundled only here, so the
// B bundle does not grow (the plugin suite runs B near the 64 MiB limit).
import worker, { setDbHandler } from './index.js';
import { mysqlQuery, mysqlEnd, mysqlReset } from './mysql-bridge.js';

setDbHandler({ query: mysqlQuery, end: mysqlEnd, reset: mysqlReset });

export default worker;
