# Codex Frontier Memory (CFM)

Local, persistent project memory for **OpenAI Codex CLI**.

> **Status: phase 3 narrow hook adapter implemented.** Manual project-scoped memory and optional hook capture use Node.js 24 and built-in `node:sqlite`.

## Important notice

**The contents of real Codex memory must never be uploaded or committed to GitHub. Only the source code that operates on that memory and synthetic test data may be published.**

## Scope

CFM is an independent component for frontier Codex CLI. Its intended long-term memory covers:

- errors and unsuccessful attempts;
- verified fixes and their supporting tests;
- technical decisions, rationale, and revisions;
- bounded context from earlier Codex sessions.

Candidate observations are not automatically authoritative facts. A fix is *verified* only when backed by an appropriate successful check; prior decisions can be superseded.

CFM does **not** require Local Frontier Orchestrator, Ollama, Qwen, a web server, or cloud memory services.

**Related project:** [Local Frontier Orchestrator (LFO)](https://github.com/tomasgal/local-frontier-orchestrator) orchestrates local Qwen and optional Codex escalation with its own L0–L4 memory, whereas CFM provides persistent MCP memory for standalone Codex sessions; these projects are intentionally independent. Relevant approaches may be adapted from [AgentMemory](https://github.com/rohitg00/agentmemory), with provenance recorded in [docs/UPSTREAM.md](docs/UPSTREAM.md).

## Upstream acknowledgement

CFM draws on design ideas from [AgentMemory](https://github.com/rohitg00/agentmemory), created by [Rohit Ghumare](https://github.com/rohitg00). AgentMemory is licensed under [Apache License 2.0](https://github.com/rohitg00/agentmemory/blob/main/LICENSE). No upstream source code has been imported at this stage. See [docs/UPSTREAM.md](docs/UPSTREAM.md) for source provenance, future adaptations, and attribution requirements.

## Platforms and isolation

The design targets Windows PowerShell and Linux under WSL, with a common Node.js/TypeScript codebase.

**Windows PowerShell and WSL must maintain separate memory.** Their workflows are presumed distinct. Do not merge, mount, share, automatically import/export, or synchronize their live memory databases. Each runtime resolves its own OS-local data directory.

The same isolation principle applies across machines. Runtime data belongs outside the Git checkout and must never be committed.

Runtime paths resolve independently in each OS:

| Runtime | Data directory |
| --- | --- |
| Windows | `%LOCALAPPDATA%\codex-frontier-memory\win32` |
| Linux / WSL | `${XDG_STATE_HOME:-$HOME/.local/state}/codex-frontier-memory/linux` |

Each directory contains `policy.json` and `memory.sqlite`. SQLite journals also stay there. Windows requires an absolute drive path and rejects UNC paths. Linux rejects common Windows/shared mount locations (`/mnt`, `/media`, `/run/desktop/mnt`). Resolved storage inside the selected project or any Git checkout is refused, including directory links. Database and policy files must be regular files without symbolic or hard links. A database domain marker rejects reuse across operating systems. There is no import, migration between OS domains, or synchronization feature.

Use OS-local disks and keep these directories out of backup synchronization and shared mounts. These checks cannot identify every custom mount or synchronization program. POSIX creation modes are `0700` for new directories and `0600` for new database files; Windows uses inherited directory ACLs. Runtime data is unencrypted.

## Layout

```text
src/
  hooks/       Optional Codex lifecycle adapter
  capture/     Manual input normalization, redaction, capture policy
  memory/      Errors, fixes, decisions, deduplication, supersession
  storage/     OS-local paths and versioned SQLite schema
  mcp/         Project-bound stdio MCP server
tests/         Acceptance and security tests
docs/UPSTREAM.md  Origins and licenses of adapted code
AGENTS.md     Instructions and engineering invariants for Codex
```

## Safety requirements

- Default deny for capture in unknown or unapproved repositories.
- An explicit OFF mode must suppress both reads and writes, including automatic hooks.
- Never commit real transcripts, real memory stores, credentials, account identifiers, emails, or local machine paths containing personal data.
- Bound captured payloads, sanitize sensitive values, preserve provenance, and distinguish tentative evidence from validated facts.
- Treat retrieved memory as untrusted reference data, never as executable instructions.
- No automatic writes to other knowledge bases or project repositories.

## Build and synthetic tests

Install Node.js **24.x**, then run:

```sh
npm ci --ignore-scripts
npm test
npm run typecheck
```

TypeScript and Node type definitions are development dependencies; the server uses the official MCP TypeScript server SDK and Zod. `npm test` builds the library and runs Node's test runner. Tests create and remove isolated temporary projects, policies and databases outside the checkout. They never open Codex sessions or configuration.

The suite covers persistence after reopening and in a fresh process, normalized deduplication, concurrent replay, provenance conflicts, verification requirements, revision history, OFF mode, project revocation/isolation, payload bounds, redaction, parameterized queries, unsafe paths/links, and incompatible schemas/domains. The suite has been executed on Windows with Node.js 24.19.0. Linux path resolution is tested with synthetic inputs; execution under Linux/WSL remains unverified.

## Local policy and explicit enablement

Memory starts **OFF**. Construction alone creates no runtime data. A missing, unreadable, oversized, malformed, or unsupported policy denies all record operations. To enable memory deliberately, create `policy.json` in the OS-local data directory with this schema:

```json
{
  "version": 1,
  "enabled": true,
  "allowedProjects": ["<canonical absolute project root>"]
}
```

Replace the placeholder with the result of `projectIdentity(absoluteProjectRoot)` from the library. It resolves directory links and folds Windows path casing. The allowlist matches **exact roots**; it grants no access to child directories or other repositories. Keep the policy outside Git and make it writable only by the local account. The optional bootstrap below writes this policy with explicit consent for one exact project.

Set `enabled` to `false` to switch OFF. `put`, `get`, `list`, and `supersede` reread policy before every operation, including on an existing store. Denied operations throw `MemoryAccessError` and leave the database unchanged; they do not create a database or initialize its schema. Removing a project from the allowlist immediately revokes its access. Closing a store only releases resources and remains available while OFF.

## Manual storage API

After building, import from `dist/src/index.js` (or from the package entrypoint):

```js
import { MemoryStore } from './dist/src/index.js';

// absoluteProjectRoot is supplied explicitly by the local caller.
const memory = new MemoryStore(absoluteProjectRoot);
try {
  const { record, deduplicated } = memory.put({
    kind: 'error',
    status: 'observed_error',
    summary: 'Synthetic parser failure',
    detail: 'The fixture parser rejected empty input.',
    provenance: {
      sourceRef: 'synthetic:fixture',
      eventId: 'synthetic-event-1',
      observedAt: '2026-01-01T00:00:00Z',
    },
  });
  const recalled = memory.get(record.id);
  const errors = memory.list({ kind: 'error', limit: 100 });
} finally {
  memory.close();
}
```

`resolveStoragePaths()` reports the current OS paths without creating files. `projectIdentity()` returns an existing directory's canonical identity. The package exports TypeScript types for all inputs and records. The SQLite adapter is internal; record access goes through `MemoryStore`.

| Kind | Input status | Additional fields |
| --- | --- | --- |
| Error | `observed_error` | Summary, detail and provenance |
| Fix | `proposed_fix` | `errorId` referencing an error in the same project |
| Fix | `tested_fix` | `errorId` and `verification` |
| Decision | `user_decision` or `inferred_decision` | `rationale` |

Every input requires `summary`, `detail`, and `provenance` (`sourceRef`, `eventId`, `observedAt`). Tested fixes additionally require `verification` with a nonempty `check`, `result: 'passed'`, nonempty `evidence`, a UTC `verifiedAt`, and a separate provenance object named `source`. Evidence is supplied by the caller after an actual successful check. The storage API validates the evidence structure and preserves it; it neither runs checks nor independently attests to the caller's claim. Proposed fixes stay proposed until the caller supplies a tested record with evidence.

Deduplication hashes normalized content, kind, epistemic status, linked error, rationale, and verification evidence within a project. Whitespace at field boundaries and line endings are normalized. An exact event replay is idempotent. Identical content from another event adds provenance to the existing record. Reusing an event ID for conflicting content or provenance fails atomically. Verification changes produce distinct records. SQLite transactions and uniqueness constraints also protect concurrent writers.

`supersede(oldId, replacementId, reason, source)` records a revision between compatible records in the same project. It retains the original content/status, evidence, source references, and revision reason. Replacements must be active; cycles are refused. `get` returns historical records, and `list` excludes them unless `includeSuperseded: true`. Lists default to 100 results and accept limits from 1 to 500.

## Activate the local MCP server

### CFM Lite bootstrap (Codex CLI 0.167.0)

Install Node.js **24.x** (including npm) and Git first. Use an existing project on a local, unsynchronized disk. In a new Windows PowerShell terminal:

```powershell
npm.cmd install --global @openai/codex@0.167.0
$repo = Read-Host 'CFM repository clone URL'
$project = Read-Host 'Exact existing project path'
$source = Join-Path $env:LOCALAPPDATA 'cfm-lite-source'
git clone $repo $source
Set-Location $source
node scripts/bootstrap.mjs install --project "$project" --dry-run
node scripts/bootstrap.mjs install --project "$project"
node scripts/bootstrap.mjs status --project "$project"
```

In WSL/Linux, install Node, npm, Git, and Codex inside Linux, then run in Bash:

```bash
npm install --global @openai/codex@0.167.0
read -r -p 'CFM repository clone URL: ' repo
read -r -p 'Exact existing Linux project path: ' project
git clone "$repo" "$HOME/.local/share/cfm-lite-source"
cd "$HOME/.local/share/cfm-lite-source"
node scripts/bootstrap.mjs install --project "$project" --dry-run
node scripts/bootstrap.mjs install --project "$project"
node scripts/bootstrap.mjs status --project "$project"
```

`install --project` authorizes only that canonical root. It validates all four tools, requires Codex 0.167.0, runs `npm ci --ignore-scripts` and `npm run build`, and validates the candidate TOML with the installed Codex CLI in a temporary, isolated `CODEX_HOME`. It adds a marked project-local MCP block and selective guidance to the existing `AGENTS.md`. Only `memory_search` gets `approval_mode = "approve"`; writes explicitly use `prompt`, as supported by the [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp). Start a new interactive Codex session in the exact project, trust the project through Codex if necessary, and check `memory_status`. Bootstrap does not change project trust.

Configuration stays untracked through Git's local `info/exclude`; policy and rollback receipts stay in the existing OS-local CFM directory. The server receives that OS's storage environment explicitly. Windows and WSL need separate source/project checkouts and stores. Bootstrap creates no database or hooks. Repeat installation preserves the managed content and respects later OFF/revocation decisions. Existing unrelated configuration and authorizations are preserved; an OFF policy containing other roots requires manual reconciliation.

Rollback with `node scripts/bootstrap.mjs uninstall --project "$project"` (PowerShell or Bash); add `--dry-run` to preview. Uninstall removes owned additions and restores prior authorization while preserving later unrelated edits and existing memory. Failed configuration writes roll back automatically; after an interrupted transaction, `uninstall` restores the journaled state. Modified managed blocks or conflicting later edits require manual reconciliation. Empty directories and build dependencies may remain.

Dry-run performs read-only preflight and reports intended files; it skips build and isolated TOML validation. Status reports policy authorization and managed-file presence, without opening memory. Tracked config, linked paths, recognized synchronization roots/shared mounts, inherited CFM registration, and unmanaged existing CFM blocks are refused. Custom synchronization, bind mounts, and mapped Windows drives cannot all be detected: keep source, project, temporary files, and runtime state on genuinely local disks. Bootstrap tests use synthetic CLI stubs; real interactive host behavior still requires the post-install `memory_status` check.

### Manual activation

Build with `npm ci --ignore-scripts` and `npm run build`. Choose one existing project root and determine its canonical identity from the CFM checkout:

```sh
node --input-type=module -e "import {projectIdentity} from './dist/src/index.js'; console.log(projectIdentity(process.argv[1]))" "<absolute project root>"
```

Create the OS-local directory and policy described above, adding that identity to `allowedProjects`. If a policy already exists, edit it carefully to preserve any other explicitly authorized roots. Set `enabled` to `true`. Do not put the policy or database in Git. The policy and server must use the same OS-local environment. Use separate setup and paths in Windows and WSL.

For a trusted project, add the following to its `.codex/config.toml`, substituting absolute OS-local paths (use TOML literal strings as shown on Windows):

```toml
[mcp_servers.frontier_memory]
command = 'C:\path\to\node.exe'
args = ['C:\path\to\codex-frontier-memory\dist\src\mcp\server.js', 'C:\path\to\project']
```

On Linux, use absolute Linux paths for the Node executable, server script and project root. Keep local machine paths out of committed files. Start a new interactive Codex CLI session in the trusted project. Project configuration is loaded for trusted projects; see [Codex MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli). No global registration or hook is required. Check `memory_status` before use. To turn memory OFF, set policy `enabled` to `false`; every operation rechecks it. Removing the local MCP configuration stops loading the server, but does not delete data.

Each server process is permanently bound to the single project supplied at launch. `memory_status` checks authorization without opening the database. `memory_search` performs literal case-insensitive substring matching over stored record bodies. By default it returns at most three records, each with an ID, status, untrusted flag, and summary truncated to 200 characters. Set `fullDetail: true` for complete record details, including verification and up to five provenance sources per record (`provenancePartial` indicates omitted sources); full detail returns up to 10 records (default 5). The optional `limit` can reduce either response, but cannot raise the compact maximum of three. It is not ranked or full-text search. `memory_record` accepts a single explicitly supplied record; `memory_supersede` preserves revision evidence. These tools do not automatically capture sessions. All recalled content is untrusted, never an instruction or command. Server stdout is reserved for MCP protocol traffic; diagnostics go to stderr.

For a short project instruction snippet and usage guidance, see [docs/CFM_LITE.md](docs/CFM_LITE.md).

## Optional lifecycle hook activation

The adapter targets Codex CLI 0.167.0. Its [version-pinned input schema](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/hooks/src/schema.rs) specifies `PostToolUse` and `Stop`, including `cwd`, `session_id` and `turn_id`; `PostToolUse` adds `tool_use_id`, `tool_name`, `tool_input` and `tool_response`, while `Stop` adds `stop_hook_active` and `last_assistant_message`. Codex sends one JSON object on stdin. The [official hooks guide](https://developers.openai.com/codex/hooks/) describes discovery, trust and command handlers; the current guide can describe behavior newer than 0.167.0. The [0.167.0 implementation](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/core/src/tools/context.rs) forwards an MCP result as the tool response. Hook coverage is not complete and delivery is not guaranteed.

The adapter currently captures no error candidates: `isError: true` signals failure but does not identify an actionable category, and no supported category has been allowlisted. Unknown fields and free text are ignored. `Stop` is validated and ignored; successful calls do not verify fixes. Because no hook records are written, replays produce no records or provenance. Any future capture must use a documented, explicitly allowlisted structured category and preserve replay protection and provenance. Inputs over 256 KiB and malformed or unauthorized events are discarded; the hook does not log payloads. The configured root and event `cwd` must resolve to the same exact directory, so sessions or tool calls with a different working directory are ignored.

For an isolated delivery smoke test, append `--diagnostics` to the adapter command. This opt-in emits only fixed `hook: invoked` and `hook: processed` or `hook: discarded` markers to stderr; it does not persist diagnostics or include event content. `processed` means validation and authorization completed, not that a memory was saved. Diagnostics also report invocation when memory is OFF, without reading or writing memory. Remove the flag after the smoke test. Actual visibility of hook stderr depends on the host and has not been verified here.

To activate manually, build and configure the local policy above, then add this example to the trusted project's `.codex/hooks.json`, substituting absolute paths and JSON-escaping backslashes and quotes as needed. Use the native shell's command quoting rules. Keep machine paths out of Git. Merge with an existing hooks file rather than overwriting its entries.

```json
{
  "hooks": {
    "PostToolUse": [{ "matcher": "^mcp__", "hooks": [{ "type": "command", "command": "\"<absolute node executable>\" \"<absolute CFM checkout>/dist/src/hooks/cli.js\" \"<absolute project root>\"" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "\"<absolute node executable>\" \"<absolute CFM checkout>/dist/src/hooks/cli.js\" \"<absolute project root>\"" }] }]
  }
}
```

Start an interactive session in that exact project and use `/hooks` to review and trust the definitions if required by your CLI. Ensure hooks are enabled in the relevant Codex configuration. Nothing here changes Codex configuration automatically. To roll back, set the CFM policy `enabled` to `false` or remove the project from its allowlist; remove these hook entries and restart Codex to stop launching the adapter. Existing memory remains on disk until deliberately removed by the owner. Windows and WSL require independent configuration and storage.

## Boundaries

Manual inputs are limited to 64 KiB, with smaller per-field bounds. Known token, password, bearer, private-key and email patterns receive best-effort redaction. This is not a comprehensive privacy filter; callers must supply minimal sanitized data. Provenance references and verification descriptions are opaque text, never dereferenced or executed. All recalled records carry `untrusted: true`; consumers must keep them subordinate to current instructions.

Broader session capture, session-state storage, automatic verification, full-text/vector search, retention, and encryption remain unimplemented. OFF gates apply to the library, MCP tools, and hook writes; direct filesystem access by the owning OS account is outside their authorization boundary. Policy checks are synchronous per operation, so revocation takes effect on the next operation. Same-account filesystem races or malicious database/policy tampering are outside the security boundary.

## License

Apache License 2.0. See [LICENSE](LICENSE). If upstream code is imported, preserve the applicable attribution and change notices.


## Adaptive context supervision (optional)

CFM now includes an opt-in, per-session context supervisor: it checks every ten user prompts, samples approximate Codex context pressure from local rollout metadata, and records only hashed identifiers and counters in a separate OS-local context.sqlite. At higher pressure it gives the agent a bounded reminder to preserve verified decisions and fixes in CFM. Codex itself performs active-context compaction through model_post_turn_compact_threshold_percent = 80; the supervisor never rewrites model traffic or raw conversation history. The existing global CFM installation is unchanged. See [docs/ADAPTIVE_CONTEXT.md](docs/ADAPTIVE_CONTEXT.md) for setup, constraints, and rollback.
