'use strict';

// Which URLs may load inside the app window. Pure, so it can be unit-tested;
// main.js applies it to in-place navigation and to popups.
//
// Hostnames are compared exactly or by dot-suffix, never by substring: a check
// like url.includes('chat.google.com') also matches
// https://example.com/?chat.google.com, and the app window has no address bar
// to show the user where they really are.

// Popups (target=_blank, window.open) for these hosts replace the main window
// instead of opening the browser: Chat itself and Google sign-in.
const IN_APP_POPUP_HOSTS = new Set(['chat.google.com', 'accounts.google.com']);

function httpsUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/** May the main window navigate here in place? Google's own sites only. */
function isGoogleHost(rawUrl) {
  const url = httpsUrl(rawUrl);
  if (!url) return false;
  const host = url.hostname;
  return host === 'google.com'
    || host.endsWith('.google.com')
    || host.endsWith('.googleusercontent.com')
    || host === 'accounts.youtube.com';
}

/** Should a popup for this URL load in the main window rather than the browser? */
function opensInApp(rawUrl) {
  const url = httpsUrl(rawUrl);
  return Boolean(url && IN_APP_POPUP_HOSTS.has(url.hostname));
}

module.exports = { isGoogleHost, opensInApp };
