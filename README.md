# Codex Frontier Memory (CFM)

Local, persistent project memory for **OpenAI Codex CLI**.

> **Status: repository skeleton only.** No runnable memory service, hooks, database, or MCP server is implemented yet.

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

The same isolation principle applies across machines. Runtime data belongs outside the Git checkout and must never be committed. Exact paths, dependencies, and supported OS versions will be established during implementation and acceptance testing.

## Planned layout

```text
src/
  hooks/       Codex lifecycle event adapters
  capture/     Event normalization, deduplication, capture policies
  memory/      Errors, fixes, decisions, session context
  storage/     Local SQLite persistence
  mcp/         Codex-facing stdio MCP interface
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

## Current state

Only project structure and policy documentation exist. Implementation, dependencies, platform tests, and security review are pending.

## License

Apache License 2.0. See [LICENSE](LICENSE). If upstream code is imported, preserve the applicable attribution and change notices.
