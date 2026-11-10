# Installation

CFM is a local MCP extension for **OpenAI Codex CLI**. It requires no private GitHub repository or cloud memory service. Only public source code and synthetic fixtures belong in Git.

| Mode | Windows | WSL / Linux | Memory scope |
| --- | --- | --- | --- |
| **Global** (recommended for native Windows) | Public installer | Not yet supported | One local SQLite store shared across working directories for that OS user |
| Project-scoped | Public installer | Public installer; runtime not yet verified | Exact project root only |

Both modes register the same MCP name, `frontier_memory`. **Do not install both modes in one Codex profile.** The global installer refuses to overwrite existing unmanaged registrations (including earlier private/global installations); reconcile those manually.

## Global installation: Windows PowerShell

Prerequisites: Windows 11, **Node.js 24.x** with npm, **Git**, and **Codex CLI 0.167.0**. This Codex version is pinned because the bootstrap validates its configuration format. Keep both sources and memory on an unsynchronized local disk, not OneDrive, Dropbox, or network storage.

Open a new PowerShell terminal:

```powershell
node --version
git --version
npm.cmd install --global @openai/codex@0.167.0

$source = Join-Path $env:LOCALAPPDATA 'cfm-lite-source'
git clone https://github.com/tomasgal/codex-frontier-memory.git $source
Set-Location $source

node scripts/global-bootstrap.mjs install --dry-run
node scripts/global-bootstrap.mjs install
node scripts/global-bootstrap.mjs status
```

If `$source` already exists, update the clean checkout with `git -C $source pull --ff-only` rather than cloning on top of it. Review `--dry-run` before installing. The installer builds with `npm ci --ignore-scripts` and `npm run build` and validates an isolated Codex MCP configuration before any persistent changes.

**Restart Codex** (new session, any trusted working directory), inspect `/mcp`, and call `memory_status`. Expect `authorized: true` and `untrustedMemory: true`. Installer `status` checks registration and policy without opening a memory database; only the live Codex check verifies MCP communication. An actual memory write creates the SQLite database lazily.

Local installation paths (resolved from the receiving user's environment):

- User-wide MCP registration: `%CODEX_HOME%\config.toml` or `%USERPROFILE%\.codex\config.toml`.
- Fixed identity: `%LOCALAPPDATA%\codex-frontier-memory\identity\global`.
- Consent and memory: `%LOCALAPPDATA%\codex-frontier-memory\win32\policy.json` and `memory.sqlite`.
- Rollback receipt: `%LOCALAPPDATA%\codex-frontier-memory\win32\bootstrap\global-public-v1.json`.

The local identity directory is separate from the memory database and stable across working directories. Global memory **is shared between projects**, so records are not project-isolated. Only record concise, sanitized experiences; do not store raw prompts, secrets, private identifiers or transcripts.

### Update, uninstall and OFF mode

From the installed public checkout:

```powershell
Set-Location (Join-Path $env:LOCALAPPDATA 'cfm-lite-source')
git pull --ff-only
node scripts/global-bootstrap.mjs status
node scripts/global-bootstrap.mjs uninstall --dry-run
node scripts/global-bootstrap.mjs uninstall
```

Repeated installation is idempotent. An installer never silently re-enables a deliberately disabled/revoked policy. Uninstall removes only its managed configuration and consent changes, preserving unrelated settings and **never deleting `memory.sqlite`**. Modified managed blocks cause a safe failure. Interrupted transactions can be rolled back using `uninstall` when no later edits conflict.

To turn CFM OFF immediately, set `"enabled": false` in the local `policy.json`. All memory reads and writes recheck this consent. Runtime SQLite files are not encrypted and must not be synchronized across computers. Windows and WSL retain independent memory domains.

### Public edition boundaries

The public global installer exposes **four** tools: `memory_status`, `memory_search`, `memory_record` and `memory_supersede`. It provides no private archives, Handoff integration, cloud sync, automatic transcript capture, global hooks or optional adaptive context supervisor. Install does not read or migrate existing memory. It never requires personal GitHub credentials and does not transmit memory data.

The installer reads only relevant local Codex configuration and CFM policy to preserve them. It rejects recognizable synced folders and linked/nonregular paths, but custom synchronization and unusual reparse paths still require manual review.

## Project-scoped installation: Windows and WSL

For strict single-project authorization, use the existing `scripts/bootstrap.mjs`, described in [README](README.md#cfm-lite-project-scoped-bootstrap-codex-cli-01670). Install Node.js 24.x, Git and Codex CLI 0.167.0. Clone this public repository to a separate, genuinely local checkout on each OS.

Windows PowerShell, from the checkout:

```powershell
$project = Read-Host 'Existing absolute project directory'
node scripts/bootstrap.mjs install --project "$project" --dry-run
node scripts/bootstrap.mjs install --project "$project"
node scripts/bootstrap.mjs status --project "$project"
```

WSL/Linux, from its own Linux checkout:

```bash
read -r -p 'Existing absolute Linux project directory: ' project
node scripts/bootstrap.mjs install --project "$project" --dry-run
node scripts/bootstrap.mjs install --project "$project"
node scripts/bootstrap.mjs status --project "$project"
```

This installer adds an MCP block to the exact project's `.codex/config.toml` and selected guidance to `AGENTS.md`, and authorizes only the chosen canonical root. Uninstall with `node scripts/bootstrap.mjs uninstall --project "$project"` (optionally `--dry-run`). Windows and WSL have separate policy/SQLite stores.

## Tests and limitations

```powershell
npm.cmd ci --ignore-scripts
npm.cmd run typecheck
npm.cmd test
```

Synthetic tests run in GitHub Actions on Windows and Ubuntu with Node.js 24. Global Windows installation has not yet been end-to-end validated on a separate real user machine. The global setup test stubs external tools; a new interactive Codex `/mcp` and `memory_status` verification remains necessary. Linux/WSL global registration is not implemented.

See [README](README.md) for data model, authorization, API, and known privacy limitations.
