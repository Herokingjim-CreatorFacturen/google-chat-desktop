'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { isGoogleHost, opensInApp } = require('../navigation');

test('Chat and sign-in popups open in the app', () => {
  assert.strictEqual(opensInApp('https://chat.google.com/room/AAAA/xyz'), true);
  assert.strictEqual(opensInApp('https://accounts.google.com/ServiceLogin?continue=x'), true);
});

test('a lookalike URL never opens in the app', () => {
  // The old substring check let all of these load into the app window.
  assert.strictEqual(opensInApp('https://example.com/?next=chat.google.com'), false);
  assert.strictEqual(opensInApp('https://chat.google.com.example.com/'), false);
  assert.strictEqual(opensInApp('https://example.com/accounts.google.com/login'), false);
  assert.strictEqual(opensInApp('https://notchat.google.com.evil/'), false);
});

test('other Google sites open in the browser, not the app', () => {
  assert.strictEqual(opensInApp('https://docs.google.com/document/d/1'), false);
  assert.strictEqual(opensInApp('https://meet.google.com/abc-defg-hij'), false);
});

test('only https counts', () => {
  assert.strictEqual(opensInApp('http://chat.google.com/'), false);
  assert.strictEqual(isGoogleHost('http://chat.google.com/'), false);
});

test('in-place navigation is allowed on Google hosts', () => {
  assert.strictEqual(isGoogleHost('https://chat.google.com/'), true);
  assert.strictEqual(isGoogleHost('https://google.com/'), true);
  assert.strictEqual(isGoogleHost('https://accounts.google.com/x'), true);
  assert.strictEqual(isGoogleHost('https://lh3.googleusercontent.com/a/x'), true);
  assert.strictEqual(isGoogleHost('https://accounts.youtube.com/accounts/CheckConnection'), true);
});

test('lookalike hosts are not Google', () => {
  assert.strictEqual(isGoogleHost('https://evilgoogle.com/'), false);
  assert.strictEqual(isGoogleHost('https://google.com.example.com/'), false);
  assert.strictEqual(isGoogleHost('https://example.com/?google.com'), false);
});

test('junk and non-web URLs are refused', () => {
  for (const url of ['', 'not a url', 'javascript:alert(1)', 'file:///C:/Windows/', undefined, null]) {
    assert.strictEqual(isGoogleHost(url), false, String(url));
    assert.strictEqual(opensInApp(url), false, String(url));
  }
});
