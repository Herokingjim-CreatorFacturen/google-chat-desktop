'use strict';

// Launches the packed app (dist/win-unpacked, from `npm run pack`) and checks it
// actually starts on the Electron that is installed, before anything built from
// it is published. Unit tests cannot catch an Electron upgrade that breaks the
// app on launch; this can.
//
// It uses a throwaway profile, so it never touches a real signed-in one, and
// runs alongside an installed copy without tripping the single-instance lock.
//
// Passes once the main window has loaded a page and the notification hook went
// in, and the Chromium reported in the log matches the user agent we send.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const TIMEOUT_MS = 90 * 1000;

const root = path.join(__dirname, '..');
const exe = path.join(root, 'dist', 'win-unpacked', 'Google Chat.exe');
const expectedElectron = require('../node_modules/electron/package.json').version;

function fail(message, log) {
  console.error(`Smoke test FAILED: ${message}`);
  if (log) console.error(`--- main.log ---\n${log}`);
  process.exitCode = 1;
}

async function run() {
  if (!fs.existsSync(exe)) return fail(`${exe} not found. Run \`npm run pack\` first.`);

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-smoke-'));
  // A fresh profile would otherwise go looking for an old signed-in one to copy in.
  fs.writeFileSync(path.join(profile, '.profile-migration.json'),
    JSON.stringify({ status: 'done', outcome: 'smoke-test' }));
  const logFile = path.join(profile, 'logs', 'main.log');
  const readLog = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '');

  console.log(`Launching ${exe} (expecting Electron ${expectedElectron})`);
  const child = spawn(exe, [`--user-data-dir=${profile}`], { stdio: 'ignore' });
  let exited = null;
  child.on('exit', (code) => { exited = code; });

  try {
    const deadline = Date.now() + TIMEOUT_MS;
    let log = '';
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
      log = readLog();
      if (/Notification hook: installed/.test(log)) break;
      if (/Notification hook failed/.test(log)) return fail('the notification hook threw.', log);
      if (exited !== null) return fail(`the app exited on its own (code ${exited}).`, log);
    }
    if (!/Notification hook: installed/.test(log)) {
      return fail(`no page loaded within ${TIMEOUT_MS / 1000}s.`, log);
    }

    const start = log.match(/Starting Google Chat \S+ \(Electron (\S+), Chromium (\d+)\./);
    const ua = log.match(/User agent pinned to real engine: Chrome\/(\d+)/);
    if (!start) return fail('no startup line in the log.', log);
    if (start[1] !== expectedElectron) {
      return fail(`the app ran Electron ${start[1]}, expected ${expectedElectron}.`, log);
    }
    if (!ua || ua[1] !== start[2]) {
      return fail(`user agent says Chrome/${ua && ua[1]}, engine is Chromium ${start[2]}.`, log);
    }

    console.log(`Smoke test passed: Electron ${start[1]}, Chromium ${start[2]}, page loaded.`);
  } finally {
    try {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch { /* already gone */ }
    // Chromium can hold files for a moment after exit; a leftover temp folder is harmless.
    await new Promise((r) => setTimeout(r, 1500));
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

run().catch((err) => fail(err.stack || String(err)));
