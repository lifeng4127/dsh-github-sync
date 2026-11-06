# dsh-github-sync

Sync your DeepSeek Harness (DSH) sessions and workspace files to a **private GitHub repository**, so you can pick a task up on another machine — Windows or macOS.

> Local DSH has no cloud. This plugin gives it one, using a repo you already own.

![GitHub Sync — move DSH sessions to a private repo, continue on another machine](https://raw.githubusercontent.com/mount9527/dsh-github-sync/main/docs/hero.png)

## What it does

![The panel: remote repo on the left, local sessions on the right, status badges at a glance](https://raw.githubusercontent.com/mount9527/dsh-github-sync/main/docs/panel.png)

- **Sessions → repo**: upload selected conversations to `<project>/sessions/<id>.jsonl.zstd`.
- **Repo → sessions**: download them back on another machine, with the session's `cwd` rewritten for that machine, then auto-attach to the workspace.
- **Attachments travel with the session** (images, PDFs, …), content-addressed by sha256.
- **Per-device index**: `manifest.json` records projects, sessions, attachments and the devices that uploaded them.
- **Manual by design**: every write is preview → confirm. Nothing uploads silently.
- **Files/folders are opt-in**: disabled by default; enable it in settings if you want workspace files too.

![Features at a glance](https://raw.githubusercontent.com/mount9527/dsh-github-sync/main/docs/features.png)

## How it works

![How it works: this machine → private repo → another machine](https://raw.githubusercontent.com/mount9527/dsh-github-sync/main/docs/flow.png)

A session on disk is just a file (`session.v4.jsonl.zstd`), so no server is involved:

1. **Upload** — the session file, the attachments it references, and the updated index go up as **one commit**.
2. **Download** — the file is restored, the `cwd` inside its header frame is rewritten for this machine (every other frame stays byte-identical), and the session is attached to the workspace.
3. **Multiple devices** — each device merges the remote index before uploading, so records are never silently overwritten.

## Install

From the **DSH plugin market**: search `dsh-github-sync`, install, enable.

From a **local checkout**: point DSH's plugin manager at this folder, or add the package to your profile's `dsh.profile.bundles`.

![Three steps: create a private repo → add a token → upload / download](https://raw.githubusercontent.com/mount9527/dsh-github-sync/main/docs/quickstart.png)

## Configure

1. Create an **empty private** GitHub repo (no README, no .gitignore).
2. Create a **fine-grained PAT** for that repo only:
   - Contents: Read and write
   - Metadata: Read-only (automatic)
3. In the DSH sidebar open **GitHub Sync** → paste `owner/repo` and the token → **Test connection**.

The token is stored by DSH in `$DSH_HOME/.credentials.yaml` and never shown again in the panel.

## Use

- Local column lists this workspace's sessions with a sync badge: `synced / local-ahead / remote-ahead / not-uploaded / active`.
- Search, `only unsynced`, select-all, and **Sync this workspace** for bulk uploads.
- Click a session row's trash icon to delete it **locally only**; the remote row's trash deletes it **from the repo only**. Attachments are garbage-collected with their session.
- Conflicts surface as `blocked` rows with **keep mine / keep theirs** buttons.
- **Diagnostics** exports version, repo, token state, remote index, recent transfers and history.

## Safety boundary

The plugin writes only to:

| Path | Purpose |
|---|---|
| `$DSH_HOME/github-sync/` | its own state, history, diagnostics |
| `$DSH_HOME/sessions/` | sessions you download or delete |
| `$DSH_HOME/attachments/v1/objects/` | restoring / collecting attachments |
| the current workspace (**off by default**) | file & folder sync |

It never spawns processes, runs shell commands, touches the registry or hosts file, mutates environment variables, installs a global proxy, or talks to anything except `api.github.com` / `github.com`.

These invariants are enforced by [`tools/audit-safety.mjs`](tools/audit-safety.mjs) and path guards in `lib/guard.mjs`.

## Cross-platform

Pure JavaScript, no native modules, no platform-specific code — the same code runs on Windows and macOS.

The only OS-dependent detail is how a workspace path maps to a sessions directory. `lib/sessiondir.mjs` falls back to reading the absolute `cwd` stored in the session header, so a key-algorithm difference between platforms can never make your sessions invisible.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `fetch failed` | The host can't reach `api.github.com`. HTTPS proxy is read from DSH's environment or `$DSH_HOME/.env` (that file affects DSH only) |
| `Git Repository is empty` (409) | First commit is seeded through the Contents API; if it persists, create an initial commit on GitHub |
| `its cwd resolves to ...` | That session id already belongs to another workspace. Restart DSH after deleting a session and re-downloading it |
| Token shows as corrupted | Re-paste the PAT in settings; the plugin rejects non-token content instead of sending it |

## License

MIT — see [LICENSE](LICENSE). Release checklist: [PUBLISHING.md](PUBLISHING.md).
