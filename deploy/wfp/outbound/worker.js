// The outbound Worker of deploy/wfp (issue #35): every fetch() that a user
// Worker makes through the DISPATCHER_OUT binding comes here first. It passes
// the request on. SITE is the user script, from the dispatcher. This is the
// place for allowlists, metering and logging (#26). It does NOT see fetch()
// from a Durable Object, so b-dosql's PHP (which runs in its object) does not
// pass here (docs/wfp.md item 4).
export default {
	async fetch(request) {
		return fetch(request);
	},
};
