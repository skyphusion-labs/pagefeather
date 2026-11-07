// Slice 7 feasibility probe (#147): can a Workers for Platforms
// dispatch-namespace USER WORKER bind and launch a Cloudflare Container?
// This is the minimal test. The Probe container returns a fixed marker; this
// Worker forwards every request to the one instance and returns its answer.
// Uploaded as a namespace user script (wrangler deploy --dispatch-namespace),
// reached through the existing dispatcher by a KV entry. A response carrying
// the marker proves the container launched from inside a namespace user Worker.
import { Container, getContainer } from '@cloudflare/containers';

export class Probe extends Container {
	defaultPort = 8080;
	sleepAfter = '2m';
}

export default {
	async fetch(request, env) {
		return getContainer(env.PROBE).fetch(request);
	},
};
