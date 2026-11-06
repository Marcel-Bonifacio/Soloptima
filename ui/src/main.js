// Entry of the interface (docs/ui.md): the app with its workspace, the ⓘ popups and the capture of errors, then the start of the
// workspace and of the profiles.
import { mount } from 'svelte';
import App from './App.svelte';
import { startInfoPop } from './lib/infopop.js';
import { startCapture } from './lib/reports/capture.js';
import { boot } from './lib/session.svelte.js';
import { placeholder } from './lib/ws/project.js';
import { bootWorkspace } from './lib/ws/boot.svelte.js';

startInfoPop();
startCapture();
placeholder();
mount(App, { target: document.getElementById('ui-root') });
bootWorkspace().then(boot);
