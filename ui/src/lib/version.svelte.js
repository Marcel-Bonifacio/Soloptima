// The app's version (the engine's `info`), shown next to the logo and under the sign-in and landing pages, so a user can tell
// which build they run
import { getInfo } from './reports/capture.js';

export const ver = $state({ v: '' });
getInfo().then((i) => { ver.v = (i && i.version) || ''; }, () => {});
