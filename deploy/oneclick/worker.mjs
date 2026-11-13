// The site manager Worker entry (#414). The site front-door code is the existing
// deploy/wfp/dispatcher/worker.js, imported as TEXT (wrangler.toml rule) so each
// site's front door runs the same dispatcher as every deploy/wfp site.
import dispatcherSource from './vendor/wfp-dispatcher/worker.js';
import { handle } from './admin.mjs';

export default {
  fetch(request, env, ctx) {
    return handle(request, env, ctx, { dispatcherSource });
  },
};
