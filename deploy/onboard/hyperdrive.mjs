// Hyperdrive config CRUD for the onboarding step (issue #240). Built on the SAME
// cfFetch as the provisioning core (deploy/provision/cf.mjs): one Cloudflare API
// layer, no new dependency, pure fetch so it runs in node and in a Worker.
//
// Every WordPress-on-Hyperdrive config is caching DISABLED. Hyperdrive's default
// query cache (60 s, "not purged or invalidated when your application writes")
// serves stale WordPress reads after a write; the a2 measurements deploy with it
// off (docs/approach-a2.md, deploy/terraform caching = { disabled = true }).
import { cfFetch, opError } from '../provision/cf.mjs';

// The sql_mode WordPress needs on a STRICT server that will not keep a session
// SET: carried per statement by spikes/b2-wordpress/php/hyperdrive-sql-mode.php.
export const WP_SQL_MODE = 'ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';

// Which provider backends need that mode carried per statement, and which do not.
// Only PlanetScale (Vitess) does: it is strict, and through Hyperdrive's pooled
// connections a `SET SESSION sql_mode` does not hold from one statement to the
// next (docs/approach-a2.md, result 2). MariaDB (vultr) and Azure MySQL are
// relaxed at the SERVER instead (the Vultr box ships relaxed; Azure is relaxed
// with `az ... parameter set`), so they need no per-statement mode. This map is
// the single source for the SQL_MODE half of the Phase 2 contract.
export function providerSqlMode(provider) {
  return provider === 'planetscale' ? WP_SQL_MODE : '';
}

// Build a Hyperdrive origin. Two shapes, exactly as deploy/terraform/main.tf:
//   public: host on a port, SSL at the server (deploy/mysql, Azure, PlanetScale,
//           or a public external host).
//   tunnel: host with an Access service token and NO port, so Hyperdrive reaches
//           the origin through a Cloudflare Tunnel behind Access (CR #141): no
//           inbound port and no SSL needed on the box.
// The password is carried here and never logged by any caller; CF never returns
// it on a read.
export function buildOrigin({ host, database, user, password, port = 3306, accessClientId, accessClientSecret }) {
  if (!host) throw new Error('origin needs a host');
  if (!database) throw new Error('origin needs a database');
  if (!user) throw new Error('origin needs a user');
  if (!password) throw new Error('origin needs a password');
  const useAccess = Boolean(accessClientId || accessClientSecret);
  const origin = { scheme: 'mysql', host, database, user, password };
  if (useAccess) {
    if (!accessClientId || !accessClientSecret) {
      throw new Error('an Access-tunnel origin needs BOTH access_client_id and access_client_secret (CR #141)');
    }
    origin.access_client_id = accessClientId;
    origin.access_client_secret = accessClientSecret;
  } else {
    origin.port = port;
  }
  return origin;
}

// POST a new config. caching disabled is set HERE, not by the caller, so no
// provider path can forget it. Returns the CF result ({ id, name, origin without
// the password, caching, ... }).
export async function createHyperdriveConfig(ctx, { name, origin }) {
  if (!name) throw new Error('a Hyperdrive config needs a name');
  if (!origin) throw new Error('a Hyperdrive config needs an origin');
  const body = { name, origin, caching: { disabled: true } };
  const r = await cfFetch(ctx.token, 'POST', `/accounts/${ctx.acct}/hyperdrive/configs`, { body, fetchImpl: ctx.fetchImpl });
  if (!r.ok || !r.result) throw opError('createHyperdriveConfig', name, r);
  return r.result;
}

// Read one config (used to VERIFY an existing config, e.g. the live Azure one,
// without recreating it).
export async function getHyperdriveConfig(ctx, id) {
  const r = await cfFetch(ctx.token, 'GET', `/accounts/${ctx.acct}/hyperdrive/configs/${id}`, { fetchImpl: ctx.fetchImpl });
  if (!r.ok || !r.result) throw opError('getHyperdriveConfig', id, r);
  return r.result;
}

export async function listHyperdriveConfigs(ctx) {
  const r = await cfFetch(ctx.token, 'GET', `/accounts/${ctx.acct}/hyperdrive/configs`, { fetchImpl: ctx.fetchImpl });
  if (!r.ok) throw opError('listHyperdriveConfigs', ctx.acct, r);
  return r.result || [];
}

// DELETE a config. Used to clean up a throwaway test config after a live check.
export async function deleteHyperdriveConfig(ctx, id) {
  const r = await cfFetch(ctx.token, 'DELETE', `/accounts/${ctx.acct}/hyperdrive/configs/${id}`, { fetchImpl: ctx.fetchImpl });
  if (!r.ok) throw opError('deleteHyperdriveConfig', id, r);
  return true;
}
