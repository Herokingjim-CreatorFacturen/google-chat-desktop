# Google Chat Desktop

An Electron wrapper around `chat.google.com` with native Windows notifications,
per-person ("VIP") alert sounds, an unread taskbar badge, and automatic updates.

---

## One-time setup before the first release

Automatic updates fetch from **GitHub Releases** at
[Herokingjim-CreatorFacturen/google-chat-desktop](https://github.com/Herokingjim-CreatorFacturen/google-chat-desktop)
— a public repo, so installed copies can read releases anonymously with no token
embedded in the app.

### Already done

* `build.publish` names the owner and repo explicitly, so nothing depends on
  parsing the git remote.
* `repository.url` matches.
* The `origin` remote is set, and the local branch is `main` to match the repo's
  default.

Verified against the live repo: the packaged app reaches it and reports
*"No published versions"* rather than a 404, which is the correct response to a
repo with no releases yet.

### Still to do

**1. Push the code.** The repo is currently empty:

```bash
git push -u origin main
```

> **On transport:** you supplied the `git@github.com:` SSH address, but this
> machine has no SSH keys (`ssh -T git@github.com` → *Permission denied
> (publickey)*), so `origin` is set to HTTPS instead — Git Credential Manager is
> already configured and will handle the sign-in. To switch to SSH later,
> generate a key, add it to GitHub, then:
> ```bash
> git remote set-url origin git@github.com:Herokingjim-CreatorFacturen/google-chat-desktop.git
> ```
> This only affects pushing. Clients always fetch updates over HTTPS regardless.

**2. Create a GitHub token** with the `repo` scope and expose it as `GH_TOKEN`
when publishing. `.env` is git-ignored; never commit it.

```bash
export GH_TOKEN=your_token_here
```

---

## Releasing a new version

The version in `package.json` is the single source of truth. Everything — the
installer filename, `latest.yml`, and the update check — derives from it.

```bash
npm version patch
npm run release
```

`npm run release` builds the NSIS installer and uploads `GoogleChat-Setup-<v>.exe`,
`latest.yml`, and the `.blockmap` to a **draft** GitHub release. Installed clients
only see the update once you publish that release.

Because the `.blockmap` is uploaded, updates are differential: clients download
only the blocks that changed, not the full ~100 MB installer.

### Other scripts

| Command | What it does |
| --- | --- |
| `npm start` | Run from source. Auto-update is disabled here by design. |
| `npm run pack` | Build `dist/win-unpacked/` only — fast, no installer. |
| `npm run dist` | Build the installer locally without uploading anything. |
| `npm run release` | Build and publish to GitHub Releases. |

---

## How updating works

* Checks on launch, then every 6 hours.
* Downloads in the background; the tray menu shows progress.
* When ready, a notification offers a restart. If it's ignored, the update
  installs the next time the app quits (including Windows shutdown).
* Users can opt out via **Install Updates Automatically** in the tray menu. A
  manual **Check for updates…** always works regardless.

The installer is **per-user** (`%LOCALAPPDATA%\Programs\Google Chat`), which is
what makes silent updates possible — a Program Files install would raise a UAC
prompt for every single update.

### Code signing

The build is unsigned, so Windows SmartScreen warns on first install. Updates
still apply. To remove the warning, get an OV/EV code-signing certificate or use
Azure Trusted Signing, then set `win.certificateFile`/`certificatePassword` (or
the `CSC_LINK`/`CSC_KEY_PASSWORD` environment variables).

---

## Rolling out to people already on 1.3.x

The old build stored its profile under `%APPDATA%\google-Eddie-1.3.x`. On first
run the app copies that across to `%APPDATA%\Google Chat`, so people keep their
Google session and settings instead of being signed out.

**The old app must not be running.** While it is, Windows keeps its cookie
database locked and the copy cannot happen. The app detects this, leaves the
profile untouched, explains it in a dialog, and retries on the next two launches.

So the instruction to give people is: **quit the old Google Chat from the system
tray first, then install.** Nothing breaks if they don't — they just sign in again.

Uninstalling the old Inno Setup version from *Add or remove programs* is safe; it
does not touch `%APPDATA%`.

---

## A note on the user agent

`main.js` reports the **real** Chromium version that Electron is running:

```js
const chromeMajor = process.versions.chrome.split('.')[0];
```

It is tempting to claim a newer Chrome to avoid Google's "this browser may not be
secure" sign-in block. Don't. `navigator.userAgentData` and the `Sec-CH-UA`
request headers are generated from the actual engine and cannot be moved by
`userAgentFallback`, so a spoofed UA string simply disagrees with them — an
easier signal to detect than the real version ever was.

The durable defence is keeping Chromium current, which means keeping Electron
current:

```bash
npm install --save-dev electron@latest
```

Do that regularly. It is the main reason the auto-updater exists.

---

## Layout

| File | Role |
| --- | --- |
| `main.js` | Main process: window, tray, notifications, updater, settings. |
| `preload.js` | Isolated-world bridge that forwards notifications over IPC. |
| `audio.html` | Hidden helper window: caches sounds, renders badge PNGs. |
| `offline.html` | Shown while reconnecting after a failed load. |
| `vip.html` | VIP sound manager UI. |

Settings and logs live in `%APPDATA%\Google Chat\`. The tray menu has an
**Open Log Folder** item — ask for `main.log` when someone reports a problem.
