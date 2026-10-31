# Upstream provenance and reuse

## Status

**No AgentMemory source files have been imported into CFM yet.** This document records the candidates for selective adaptation. The repository skeleton, README and AGENTS instructions are new CFM project material.

## Candidate upstream

- Project: [rohitg00/agentmemory](https://github.com/rohitg00/agentmemory)
- Original project author: [Rohit Ghumare](https://github.com/rohitg00) (as identified in upstream plugin metadata).
- Repository: `https://github.com/rohitg00/agentmemory`
- Upstream licensing: [Apache License 2.0](https://github.com/rohitg00/agentmemory/blob/main/LICENSE)
- Reviewed package version: `0.9.31` (historical observation; lock a source commit before copying)
- Intended use: small Codex-only event capture and memory components, **not** the upstream daemon or the complete plugin.

| Upstream source | Considered purpose | Status |
| --- | --- | --- |
| `src/capture/event-id.ts` | Stable event IDs and deduplication | Candidate only |
| `src/hooks/_capture-filter.ts` | Capture allow/deny and payload limits | Candidate only |
| `src/hooks/post-tool-use.ts` | Codex hook event intake | Candidate only |
| `src/capture/spool.ts` | Durable capture retry mechanisms | Candidate only |
| `src/functions/privacy.ts` | Pattern-based redaction (must be independently hardened) | Candidate only |
| `src/functions/lessons.ts` | Lesson representation and recall/ranking | Candidate only |
| `src/functions/patterns.ts` | Recurring-error and file-pattern analysis | Candidate only |
| `src/state/search-index.ts` | BM25 lexical retrieval | Candidate only |

## Source adaptation procedure

1. Before importing a file, pin its exact **upstream commit SHA** and record the file path and source link.
2. Review runtime dependencies, transitive imports, file/network access, and hook payloads. Do not assume modules are independently installable.
3. Copy only the necessary parts or reimplement the algorithm. Preserve applicable attribution and notices; identify substantial changes clearly.
4. Validate Windows PowerShell and WSL **independently**. Do not share their live memory stores.
5. Use synthetic data in tests; do not copy real Codex transcripts, secrets, personal information, or local database contents.
6. Record security limitations and tests in this document before enabling automatic capture.

## License

The project currently includes the Apache License 2.0 text in `LICENSE`. Keep this notice and all required source-specific notices if upstream code is adopted. A repository being Apache-2.0 licensed does not by itself mean all prospective third-party dependencies have been cleared.
