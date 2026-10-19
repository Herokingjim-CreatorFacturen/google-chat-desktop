'use strict';

// Decides whether the app should move to a newer Electron, and to which one.
//
// Google Chat shows "This version of Chrome is outdated" once the Chromium
// inside Electron falls a few majors behind real Chrome. Chrome now ships a
// major every two weeks and Electron every eight, so that gap reopens by itself
// unless every Electron major is picked up.
//
// Run daily by .github/workflows/electron-update.yml. decide() is pure and
// covered by test/electron-update.test.js; the bottom of this file only gathers
// its inputs and hands the answer to the workflow.

// A brand-new release gets this long to collect its first hotfix before it
// goes out to everyone automatically.
const SOAK_DAYS = 2;
// Same-major updates carry security fixes but nothing for the "outdated" nag,
// so they go out at most once a month rather than every week.
const FIX_INTERVAL_DAYS = 30;
// A new major due this soon is worth waiting for: one update instead of two.
const MAJOR_WAIT_DAYS = 3;
// ...but if its date slips by more than this, stop waiting for it.
const MAJOR_SLIP_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

function parseVersion(version) {
  const [core, pre] = String(version).split('-');
  return { parts: core.split('.').map(Number), pre: pre || null };
}

function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (let i = 0; i < 3; i += 1) {
    if (x.parts[i] !== y.parts[i]) return x.parts[i] - y.parts[i];
  }
  // 45.0.0-beta.5 comes before 45.0.0.
  if (x.pre && !y.pre) return -1;
  if (!x.pre && y.pre) return 1;
  return 0;
}

const majorOf = (version) => parseVersion(version).parts[0];
const daysBetween = (from, to) => (new Date(to) - new Date(from)) / DAY_MS;
const isStable = (version) => /^\d+\.\d+\.\d+$/.test(version);

/**
 * @param {object}   input
 * @param {string}   input.current      Electron version the app ships today.
 * @param {object[]} input.releases     releases.electronjs.org/releases.json:
 *                                      { version, date, chrome }.
 * @param {object[]} [input.schedule]   releases.electronjs.org/schedule.json:
 *                                      { version, stableDate }.
 * @param {string}   [input.lastRelease] When this app last shipped (ISO date).
 * @param {Date}     [input.now]
 * @returns {{ update: boolean, reason: string, target?: string, chrome?: string }}
 */
function decide({ current, releases, schedule = [], lastRelease, now = new Date() }) {
  const newest = releases
    .filter((r) => isStable(r.version))
    .sort((a, b) => compareVersions(b.version, a.version))[0];

  if (!newest || compareVersions(newest.version, current) <= 0) {
    return { update: false, reason: `Electron ${current} is the newest stable release.` };
  }

  // Never fall back to an older release while the newest one soaks: that would
  // mean shipping twice in a few days.
  const age = daysBetween(newest.date, now);
  if (age < SOAK_DAYS) {
    return {
      update: false,
      reason: `Electron ${newest.version} came out on ${newest.date}; `
        + `waiting until it is ${SOAK_DAYS} days old.`
    };
  }

  const upcoming = schedule.find((s) => {
    if (majorOf(s.version) <= majorOf(newest.version)) return false;
    const daysUntil = daysBetween(now, s.stableDate);
    return daysUntil <= MAJOR_WAIT_DAYS && daysUntil >= -MAJOR_SLIP_DAYS;
  });
  if (upcoming) {
    return {
      update: false,
      reason: `Electron ${majorOf(upcoming.version)} is due on ${upcoming.stableDate}; `
        + `waiting for it rather than shipping ${newest.version} first.`
    };
  }

  const found = { update: true, target: newest.version, chrome: newest.chrome };

  if (majorOf(newest.version) > majorOf(current)) {
    return {
      ...found,
      reason: `New Electron major: ${current} -> ${newest.version} (Chromium ${newest.chrome}).`
    };
  }

  const sinceRelease = lastRelease ? daysBetween(lastRelease, now) : Infinity;
  if (sinceRelease >= FIX_INTERVAL_DAYS) {
    return {
      ...found,
      reason: `Monthly fixes: ${current} -> ${newest.version} (Chromium ${newest.chrome}).`
    };
  }

  return {
    update: false,
    reason: `Electron ${newest.version} has fixes, but the last release was `
      + `${Math.floor(sinceRelease)} days ago; fix-only updates wait ${FIX_INTERVAL_DAYS} days.`
  };
}

module.exports = { decide, compareVersions };

// ---------------------------------------------------------------------------
// CLI: `node scripts/electron-update.js`
// ---------------------------------------------------------------------------
async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

async function main() {
  const fs = require('fs');
  const path = require('path');
  const { execFileSync } = require('child_process');

  const root = path.join(__dirname, '..');
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const current = lock.packages['node_modules/electron'].version;

  const releases = await getJson('https://releases.electronjs.org/releases.json');

  // Only used to hold off for an imminent major, so carry on without it.
  let schedule = [];
  try {
    schedule = await getJson('https://releases.electronjs.org/schedule.json');
  } catch (err) {
    console.warn(`Could not read Electron's release schedule (${err.message}); not waiting on it.`);
  }

  // The newest v* tag is when this app last shipped. Needs tags fetched.
  const lastRelease = execFileSync('git', [
    'for-each-ref', '--sort=-creatordate', '--count=1',
    '--format=%(creatordate:iso-strict)', 'refs/tags/v*'
  ], { cwd: root, encoding: 'utf8' }).trim() || undefined;

  // A version asked for by hand (the workflow's "target" input) skips the
  // timing rules, but still has to be a real stable release that moves us on.
  const requested = (process.env.ELECTRON_TARGET || '').trim().replace(/^v/, '');
  let result;
  if (requested) {
    const release = releases.find((r) => r.version === requested && isStable(r.version));
    if (!release) throw new Error(`Electron ${requested} is not a stable release.`);
    result = compareVersions(requested, current) > 0
      ? { update: true, target: requested, chrome: release.chrome,
        reason: `Requested by hand: ${current} -> ${requested} (Chromium ${release.chrome}).` }
      : { update: false, reason: `Requested ${requested}, but the app already ships ${current}.` };
  } else {
    result = decide({ current, releases, schedule, lastRelease });
  }
  console.log(result.reason);

  if (process.env.GITHUB_OUTPUT) {
    const lines = [`update=${result.update}`, `reason=${result.reason}`];
    if (result.update) lines.push(`target=${result.target}`, `chrome=${result.chrome}`);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${result.reason}\n`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
