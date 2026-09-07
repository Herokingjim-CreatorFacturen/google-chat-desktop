# Google Chat Desktop

An Electron wrapper around `chat.google.com` with native Windows notifications,
an unread taskbar badge, and automatic updates.

## Alerts

Two kinds of rule, both managed from **🔔 Manage Alert Sounds** in the tray menu:

* **Keyword alerts** match anywhere in the sender *or* the message text — your
  own name, a project, "urgent". These are checked first, and they bypass the
  ten-second sound throttle, because they are the case you specifically asked to
  be interrupted for.
* **VIP senders** match the sender only. Someone mentioning your boss is not
  your boss messaging you.

Both are plain substring matches, case-insensitive. The logic lives in
[`alerts.js`](alerts.js) and is covered by `npm.cmd test`.

Do **not** add a mute or Do Not Disturb toggle here. Google Chat's own DND
already suppresses everything: sounds and banners are only ever raised from the
notification hook, which fires when Google's page calls `Notification()`. Under
DND it never does, so the wrapper goes quiet for free — and Google's version
also sets your status, which a local toggle could not.

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
* The code is pushed; `main` tracks `origin/main`.

Verified against the live repo: the packaged app reaches it and reports
*"No published versions"* rather than a 404, which is the correct response to a
repo with no releases yet.

> **On transport:** `origin` uses **HTTPS**, not the `git@github.com:` SSH
> address. This machine has no SSH keys — `ssh -T git@github.com` returns
> *Permission denied (publickey)* — so SSH pushes fail. Git Credential Manager
> handles HTTPS sign-in instead. To move to SSH later, generate a key, add it to
> GitHub, then:
>
> ```powershell
> git remote set-url origin git@github.com:Herokingjim-CreatorFacturen/google-chat-desktop.git
> ```
>
> This affects pushing only. Update clients always fetch over HTTPS regardless.

---

## Windows notes — read these first

This is developed and released on Windows/PowerShell. Two things bite every time
if you forget them.

**Use `npm.cmd`, not `npm`.** The PowerShell execution policy on this machine is
`Restricted`, which refuses to load npm's `npm.ps1` wrapper:

> `npm : File C:\Program Files\nodejs\npm.ps1 cannot be loaded because running
> scripts is disabled on this system.`

The `.cmd` batch wrapper isn't subject to the policy, so `npm.cmd run release`
works with no security settings changed. (`Set-ExecutionPolicy -Scope CurrentUser
RemoteSigned` would also fix it, but there's no need to touch that.)

**`export` is bash, not PowerShell.** Set the publish token like this, quoted —
unquoted, PowerShell tries to run the token as a command:

```powershell
$env:GH_TOKEN = "github_pat_..."
```

That lasts for the current window only, and the release must run in that same
window. To persist it for future terminals:

```powershell
[Environment]::SetEnvironmentVariable("GH_TOKEN", "your_token_here", "User")
```

> **Keep the token out of your scrollback and history.** Pasting it on the
> command line writes it to `(Get-PSReadLineOption).HistorySavePath` in plain
> text, and into anything you screenshot. If one leaks, revoke it at
> github.com/settings/personal-access-tokens and strip the history:
>
> ```powershell
> $h = (Get-PSReadLineOption).HistorySavePath
> (Get-Content $h) | Where-Object { $_ -notmatch 'github_pat_' } | Set-Content $h
> ```

The token needs **Contents: Read and write** on this repository — nothing else.
"Public repositories" access is read-only and will fail at the upload step with
a 401.

**Git needs an identity**, or `npm.cmd version patch` edits `package.json` and
then aborts before committing — leaving the bump uncommitted and untagged while
the build carries on regardless. Already configured at repo scope here; if you
clone this somewhere else:

```powershell
git config user.name "Jimmy de Heus"
git config user.email "herokingjim@gmail.com"
```

---

## Releasing a new version

The version in `package.json` is the single source of truth. Everything — the
installer filename, `latest.yml`, and the update check — derives from it.

**Push a tag and let CI do it.** `.github/workflows/release.yml` builds on
`windows-latest` and uploads to a draft release:

```powershell
npm.cmd version patch
git push --follow-tags
```

That is the whole release. No token in your shell, no execution-policy
surprises, no chance of two local builds racing each other. The workflow uses
the `GITHUB_TOKEN` that Actions mints per run, scoped to this repo only, so
there is no personal access token to create, store, or renew.

Before uploading it runs the tests and checks the tag matches `package.json` —
a mislabelled release is worse than a failed one. Afterwards it verifies the
`.exe`, `.exe.blockmap` and `latest.yml` all made it, and fails loudly if any
are missing.

Installed clients only see the update once you **publish the draft** by hand.

### Releasing from your own machine

Still supported, and needs a `GH_TOKEN` (see the Windows notes above):

```powershell
npm.cmd run release
```

Run it **once** per version. Running it twice against the same version is what
produced a release whose `latest.yml` described a different build than the
uploaded installer, with the blockmap missing entirely.

A draft is invisible to unauthenticated API calls, so "the release isn't there"
usually just means it hasn't been published yet. To list drafts:

```powershell
$h = @{ Authorization = "Bearer $env:GH_TOKEN" }
Invoke-RestMethod "https://api.github.com/repos/Herokingjim-CreatorFacturen/google-chat-desktop/releases" -Headers $h |
  Select-Object tag_name, draft, @{n='assets';e={ $_.assets.name -join ', ' }}
```

Because the `.blockmap` is uploaded, updates are differential: clients download
only the blocks that changed, not the full ~100 MB installer.

### Other scripts

| Command | What it does |
| --- | --- |
| `npm.cmd test` | Run the alert-matching tests. |
| `npm.cmd start` | Run from source. Auto-update is disabled here by design. |
| `npm.cmd run pack` | Build `dist/win-unpacked/` only — fast, no installer. |
| `npm.cmd run dist` | Build the installer locally without uploading anything. |
| `npm.cmd run release` | Build and publish to GitHub Releases. |

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

```powershell
npm.cmd install --save-dev electron@latest
```

Do that regularly. It is the main reason the auto-updater exists.

---

## Layout

| File | Role |
| --- | --- |
| `main.js` | Main process: window, tray, notifications, updater, settings. |
| `alerts.js` | Decides which sound a notification plays. Pure, and unit-tested. |
| `preload.js` | Isolated-world bridge that forwards notifications over IPC. |
| `audio.html` | Hidden helper window: caches sounds, renders badge PNGs. |
| `offline.html` | Shown while reconnecting after a failed load. |
| `vip.html` | Alert sounds UI — keyword alerts and VIP senders. |
| `test/` | `node --test` suite. Run with `npm.cmd test`. |

Settings and logs live in `%APPDATA%\Google Chat\`. The tray menu has an
**Open Log Folder** item — ask for `main.log` when someone reports a problem.
