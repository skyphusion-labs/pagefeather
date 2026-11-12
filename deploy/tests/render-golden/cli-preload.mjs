// Loaded with node --import before deploy/provision/cli.mjs (#328 PR 0). It puts the stand-in API
// of capture.mjs in place of the global fetch, so the CLI runs unchanged and makes no network
// call. At exit it writes the recorded calls to the file GOLDEN_CAPTURE names.
import { writeFileSync } from 'node:fs';
import { makeRecorder, stable } from './capture.mjs';

const rec = makeRecorder();
globalThis.fetch = rec.fetchImpl;
process.on('exit', () => {
  if (process.env.GOLDEN_CAPTURE) writeFileSync(process.env.GOLDEN_CAPTURE, stable(rec.calls));
});
