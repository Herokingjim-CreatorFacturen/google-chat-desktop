'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { decide, compareVersions } = require('../scripts/electron-update');

const now = new Date('2026-11-01T05:00:00Z');

const releases = [
  { version: '43.1.0', date: '2026-07-07', chrome: '150.0.7871.47' },
  { version: '43.8.0', date: '2026-10-16', chrome: '150.0.7871.250' },
  { version: '44.9.0', date: '2026-10-17', chrome: '152.0.7977.167' },
  { version: '45.0.0-beta.5', date: '2026-10-16', chrome: '156.0.8078.36' },
  { version: '45.0.0', date: '2026-10-20', chrome: '156.0.8078.40' }
];

test('a new major goes out straight away, whatever the monthly window says', () => {
  const r = decide({ current: '44.9.0', releases, lastRelease: '2026-10-30', now });
  assert.strictEqual(r.update, true);
  assert.strictEqual(r.target, '45.0.0');
  assert.strictEqual(r.chrome, '156.0.8078.40');
  assert.match(r.reason, /New Electron major/);
});

test('skips majors in between and goes to the newest', () => {
  const r = decide({ current: '43.1.0', releases, now });
  assert.strictEqual(r.target, '45.0.0');
});

test('betas and alphas are never picked', () => {
  const r = decide({
    current: '45.0.0',
    releases: [...releases, { version: '46.0.0-alpha.3', date: '2026-10-25', chrome: '160.0.1.0' }],
    now
  });
  assert.strictEqual(r.update, false);
});

test('up to date means nothing to do', () => {
  const r = decide({ current: '45.0.0', releases, now });
  assert.strictEqual(r.update, false);
  assert.match(r.reason, /newest stable/);
});

test('a release younger than the soak period waits, and does not fall back to an older one', () => {
  // 45.0.0 is one day old here; shipping 44.9.0 now would mean two updates in two days.
  const r = decide({ current: '43.1.0', releases, now: new Date('2026-10-21T05:00:00Z') });
  assert.strictEqual(r.update, false);
  assert.match(r.reason, /45\.0\.0 came out/);
});

test('ships once the soak period has passed', () => {
  const r = decide({ current: '43.1.0', releases, now: new Date('2026-10-22T05:00:00Z') });
  assert.strictEqual(r.update, true);
  assert.strictEqual(r.target, '45.0.0');
});

test('waits for a major that is due within a few days', () => {
  const r = decide({
    current: '43.1.0',
    releases: releases.filter((x) => x.version !== '45.0.0'),
    schedule: [{ version: '45.0.0', stableDate: '2026-10-20' }],
    now: new Date('2026-10-19T05:00:00Z')
  });
  assert.strictEqual(r.update, false);
  assert.match(r.reason, /Electron 45 is due on 2026-10-20/);
});

test('stops waiting for a major that slipped by more than a week', () => {
  const r = decide({
    current: '43.1.0',
    releases: releases.filter((x) => x.version !== '45.0.0'),
    schedule: [{ version: '45.0.0', stableDate: '2026-10-20' }],
    now: new Date('2026-10-28T05:00:00Z')
  });
  assert.strictEqual(r.update, true);
  assert.strictEqual(r.target, '44.9.0');
});

test('a major due far in the future does not hold anything up', () => {
  const r = decide({
    current: '45.0.0',
    releases: [...releases, { version: '45.2.0', date: '2026-11-20', chrome: '156.0.8078.90' }],
    schedule: [{ version: '46.0.0', stableDate: '2027-01-05' }],
    lastRelease: '2026-10-22',
    now: new Date('2026-12-01T05:00:00Z')
  });
  assert.strictEqual(r.update, true);
  assert.strictEqual(r.target, '45.2.0');
});

test('same-major fixes wait until a month after the last release', () => {
  const withFix = [...releases, { version: '45.1.0', date: '2026-10-27', chrome: '156.0.8078.60' }];

  const early = decide({ current: '45.0.0', releases: withFix, lastRelease: '2026-10-22', now });
  assert.strictEqual(early.update, false);
  assert.match(early.reason, /fix-only updates wait 30 days/);

  const later = decide({
    current: '45.0.0', releases: withFix, lastRelease: '2026-10-22', now: new Date('2026-11-21T05:00:00Z')
  });
  assert.strictEqual(later.update, true);
  assert.strictEqual(later.target, '45.1.0');
  assert.match(later.reason, /Monthly fixes/);
});

test('no previous release counts as the monthly window being open', () => {
  const withFix = [...releases, { version: '45.1.0', date: '2026-10-27', chrome: '156.0.8078.60' }];
  const r = decide({ current: '45.0.0', releases: withFix, now });
  assert.strictEqual(r.update, true);
});

test('version comparison is numeric and puts prereleases first', () => {
  assert.ok(compareVersions('44.10.0', '44.9.0') > 0, '10 > 9, not "1" < "9"');
  assert.ok(compareVersions('45.0.0-beta.5', '45.0.0') < 0);
  assert.strictEqual(compareVersions('45.0.0', '45.0.0'), 0);
});
