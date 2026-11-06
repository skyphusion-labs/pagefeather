// Outbound Worker for the spike (issue #35). Every fetch() from a user Worker
// called through the DISPATCHER_OUT binding comes here first. It passes the
// request on and marks the answer with x-wfp-outbound, so the user Worker can
// show that its fetch went through this Worker. TENANT_FROM_DISPATCH is the
// parameter the dispatcher sets.
export default {
	async fetch(request, env) {
		const r = await fetch(request);
		const out = new Response(r.body, r);
		out.headers.set('x-wfp-outbound', env.TENANT_FROM_DISPATCH || 'yes');
		return out;
	},
};
