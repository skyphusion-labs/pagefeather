// Issue #856 / #185: SKYPHUSION_ASYNC_EMAIL turns on php/wp-mail-queue.php so wp_mail
// hands messages to the Worker. b-dosql (PHP and SQL in the Durable Object) and approach A
// (external MySQL through Hyperdrive; dbHandler is set at boot). ASYNC_EMAIL=off disables it.
export function asyncEmailDefine(env, approachA) {
	if (!env || env.ASYNC_EMAIL === 'off') return null;
	const bDosql = env.PHP_IN_DO === 'on' && env.DB_IN_DO === 'on';
	if (bDosql || approachA) return "define('SKYPHUSION_ASYNC_EMAIL', true);";
	return null;
}