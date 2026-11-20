// A fake LeanMysql for the bridge tests (#1101): connect() runs globalThis.__lean.connect, which the test sets.
const control = (globalThis.__lean ??= { connect: null });
export class LeanMysql {
	static async connect(opts) {
		return control.connect(opts);
	}
}
