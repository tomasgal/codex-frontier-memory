# Codex Frontier Memory (CFM)

Local, persistent project memory for **OpenAI Codex CLI**.

> **Status: phase 1 storage library implemented.** Manual TypeScript/JavaScript APIs persist project-scoped memory using Node.js 24 and built-in `node:sqlite`. Hooks, Codex integration, and MCP are pending.

## Important notice

**The contents of real Codex memory must never be uploaded or committed to GitHub. Only the source code that operates on that memory and synthetic test data may be published.**

## Scope

CFM is an independent component for frontier Codex CLI. Its intended long-term memory covers:

- errors and unsuccessful attempts;
- verified fixes and their supporting tests;
- technical decisions, rationale, and revisions;
- bounded context from earlier Codex sessions.

Candidate observations are not automatically authoritative facts. A fix is *verified* only when backed by an appropriate successful check; prior decisions can be superseded.

CFM does **not** require Local Frontier Orchestrator, Ollama, Qwen, a web server, or cloud memory services. Relevant approaches may be adapted from [AgentMemory](https://github.com/rohitg00/agentmemory), with provenance recorded in [docs/UPSTREAM.md](docs/UPSTREAM.md).

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
  hooks/       Reserved for lifecycle adapters (unimplemented)
  capture/     Manual input normalization, redaction, capture policy
  memory/      Errors, fixes, decisions, deduplication, supersession
  storage/     OS-local paths and versioned SQLite schema
  mcp/         Reserved for stdio MCP (unimplemented)
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

TypeScript and Node type definitions are development dependencies. The runtime uses only built-in Node modules. `npm test` builds the library and runs Node's test runner. Tests create and remove isolated temporary projects, policies and databases outside the checkout. They never open Codex sessions, configuration, or credentials. Test subprocesses receive only the environment needed for their synthetic fixture.

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

Replace the placeholder with the result of `projectIdentity(absoluteProjectRoot)` from the library. It resolves directory links and folds Windows path casing. The allowlist matches **exact roots**; it grants no access to child directories or other repositories. Keep the policy outside Git and make it writable only by the local account. Phase 1 provides no automatic policy writer or enablement command.

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

## Phase 1 boundaries

Manual inputs are limited to 64 KiB, with smaller per-field bounds. Known token, password, bearer, private-key and email patterns receive best-effort redaction. This is not a comprehensive privacy filter; callers must supply minimal sanitized data. Provenance references and verification descriptions are opaque text, never dereferenced or executed. All recalled records carry `untrusted: true`; consumers must keep them subordinate to current instructions.

Hooks, session capture, session-state storage, MCP, automatic verification, full-text/vector search, retention, encryption, and Codex integration remain unimplemented. OFF gates apply to this library API; direct filesystem access by the owning OS account is outside its authorization boundary. Policy checks are synchronous per operation, so revocation takes effect on the next operation. Same-account filesystem races or malicious database/policy tampering are outside the security boundary.

## License

Apache License 2.0. See [LICENSE](LICENSE). If upstream code is imported, preserve the applicable attribution and change notices.
