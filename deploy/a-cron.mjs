// Approach A Workers Cron render helpers (#855). Offline-tested; deploy/a-settings.sh mirrors
// these lines when A_CRON=1. The runtime half is spikes/b2-wordpress/a-cron.mjs.

/** Default Cloudflare Cron expression when A_CRON_CRON is unset (one minute). */
export const A_CRON_SCHEDULE_DEFAULT = '* * * * *';

/** Wrangler [triggers] block (no trailing newline required). */
export function aCronTriggersToml(schedule = A_CRON_SCHEDULE_DEFAULT) {
	return `[triggers]\ncrons = ["${schedule}"]`;
}

/** PhpRuntime DO binding + v1 migration when overflow has not already rendered it. */
export function aPhpRuntimeBindingsToml() {
	return [
		'[[durable_objects.bindings]]',
		'name = "PHP_RUNTIME"',
		'class_name = "PhpRuntime"',
		'[[migrations]]',
		'tag = "v1"',
		'new_sqlite_classes = ["PhpRuntime"]',
	].join('\n');
}

/** Full scaffold when A_CRON=1 and PHP_OVERFLOW is off. */
export function aCronRenderToml({ schedule = A_CRON_SCHEDULE_DEFAULT, overflowOn = false } = {}) {
	const parts = ['A_CRON = "on"', aCronTriggersToml(schedule)];
	if (!overflowOn) parts.push(aPhpRuntimeBindingsToml());
	return parts.join('\n');
}