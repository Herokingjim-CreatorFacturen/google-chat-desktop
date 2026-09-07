// Runs in the isolated world of the Google Chat page.
//
// It cannot touch the page's own `window` (that is the main world), but it does
// share the DOM with it. The notification hook injected into the main world
// dispatches a CustomEvent carrying a JSON string; we pick it up here and hand
// it to the main process over IPC.
//
// This replaces the old console.log('ELECTRON_NOTIF|...') + 'console-message'
// bridge, whose listener signature is deprecated in Electron and will stop
// firing on a future upgrade -- taking every notification with it.

const { ipcRenderer } = require('electron');

window.addEventListener('gcw-notification', (event) => {
  // `detail` is always a JSON string: only primitives cross world boundaries
  // reliably, so the main-world hook stringifies before dispatching.
  if (typeof event.detail !== 'string') return;
  ipcRenderer.send('gcw:notification', event.detail);
});
