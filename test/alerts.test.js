'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { pickAlertSound } = require('../alerts');

const config = {
  keywordSounds: { 'Jimmy': 'name.mp3', 'deadline': 'urgent.mp3' },
  vipSounds: { 'Boss Man': 'boss.mp3', 'Team Alpha': 'team.mp3' }
};

test('matches a keyword in the message body', () => {
  const r = pickAlertSound({ title: 'Sandra', body: 'can Jimmy take a look?' }, config);
  assert.strictEqual(r.sound, 'name.mp3');
  assert.strictEqual(r.matched, 'keyword');
  assert.strictEqual(r.urgent, true);
});

test('matches a keyword in the sender too', () => {
  const r = pickAlertSound({ title: 'deadline reminders', body: 'anything' }, config);
  assert.strictEqual(r.matched, 'keyword');
  assert.strictEqual(r.term, 'deadline');
});

test('keyword matching ignores case', () => {
  const r = pickAlertSound({ title: 'Sandra', body: 'JIMMY please review' }, config);
  assert.strictEqual(r.sound, 'name.mp3');
});

test('matches a VIP sender', () => {
  const r = pickAlertSound({ title: 'Boss Man', body: 'morning' }, config);
  assert.strictEqual(r.sound, 'boss.mp3');
  assert.strictEqual(r.matched, 'vip');
  assert.strictEqual(r.urgent, false, 'VIP alerts stay subject to the sound throttle');
});

test('a VIP is matched on the sender only, never the body', () => {
  // Someone merely mentioning the boss is not the boss messaging you.
  const r = pickAlertSound({ title: 'Sandra', body: 'Boss Man is out today' }, config);
  assert.strictEqual(r.matched, 'none');
});

test('keywords win over VIPs', () => {
  const r = pickAlertSound({ title: 'Boss Man', body: 'Jimmy can you look' }, config);
  assert.strictEqual(r.sound, 'name.mp3');
  assert.strictEqual(r.matched, 'keyword');
  assert.strictEqual(r.urgent, true);
});

test('falls through to the default sound when nothing matches', () => {
  const r = pickAlertSound({ title: 'Sandra', body: 'lunch?' }, config);
  assert.deepStrictEqual(r, { sound: null, urgent: false, matched: 'none', term: null });
});

test('a partial word still counts as a match', () => {
  // "deadlines" contains "deadline" -- substring matching is deliberate, so a
  // plural or possessive does not slip past a rule you set up.
  const r = pickAlertSound({ title: 'Sandra', body: 'the deadlines moved' }, config);
  assert.strictEqual(r.matched, 'keyword');
});

test('survives missing and empty fields', () => {
  assert.strictEqual(pickAlertSound({}, config).matched, 'none');
  assert.strictEqual(pickAlertSound({ title: null, body: undefined }, config).matched, 'none');
  assert.strictEqual(pickAlertSound({ title: 'Jimmy' }, config).matched, 'keyword');
});

test('survives an empty or absent config', () => {
  assert.strictEqual(pickAlertSound({ title: 'x', body: 'y' }).matched, 'none');
  assert.strictEqual(pickAlertSound({ title: 'x', body: 'y' }, {}).matched, 'none');
  assert.strictEqual(
    pickAlertSound({ title: 'x' }, { keywordSounds: {}, vipSounds: {} }).matched,
    'none'
  );
});

test('an empty-string rule never matches everything', () => {
  // Object keys can end up empty through a bad edit of the settings file; an
  // empty needle is a substring of every string, which would alert on all traffic.
  const r = pickAlertSound({ title: 'Sandra', body: 'lunch?' }, {
    keywordSounds: { '': 'oops.mp3' },
    vipSounds: { '': 'oops.mp3' }
  });
  assert.strictEqual(r.matched, 'none');
});

test('regex-special characters are treated literally', () => {
  const r = pickAlertSound({ title: 'Sandra', body: 'build failed: c++ (again)' }, {
    keywordSounds: { 'c++ (again)': 'build.mp3' }
  });
  assert.strictEqual(r.sound, 'build.mp3');
});
