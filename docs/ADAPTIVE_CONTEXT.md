# Adaptive context supervision (opt-in)

This component adds a local context-pressure observer to CFM without changing
the established memory.sqlite schema or proxying model traffic. It is designed
for Codex CLI 0.167.0 hooks. It is NOT an alternative compaction engine.

## Mechanism

* Native Codex compaction protects the actual model context window.
* UserPromptSubmit records an idempotent per-session prompt count in a separate
  OS-local context.sqlite file. Every tenth prompt is reviewed.
* At 50-74% estimated window use, prompt 10/20/... may inject a short suggestion
  to preserve important verified facts via the existing memory_record tool.
  At 75-79%, this is a stronger checkpoint reminder.
  At >=80%, the reminder can occur earlier, at most every two prompts.
  With unknown usage, every tenth prompt receives a conservative review.
* PreCompact / PostCompact store event metadata, never raw conversation text.
* The reminder is advisory and does not force the model to call memory_record.
  A recorded checkpoint is telemetry, not proof that semantic notes were saved.
* Do not assume the counter controls compaction: large tool outputs can fill
  the context window between prompts. Codex's internal auto-compaction remains
  enabled independently.

The observer reads at most the final 1 MiB of a Codex-local rollout JSONL
file under CODEX_HOME/sessions, looking solely for token_count metadata. It
does not persist prompts, tool responses or transcript content. Usage data
are approximate and may be absent or stale; never use the observer as a hard
overflow safety mechanism. The OS-local SQLite database is not encrypted.

## Public global Windows installer (opt-in)

The source-only public [installation workflow](../INSTALL.md) supports adaptive
context supervision as an **explicit option** of the global CFM installer:

```powershell
# Install MCP memory without context hooks (default)
node scripts/global-bootstrap.mjs install

# Explicitly add the optional context supervisor on a new or existing public
# global installation; the dry-run must not modify Codex configuration.
node scripts/global-bootstrap.mjs install --adaptive-context --dry-run
node scripts/global-bootstrap.mjs install --adaptive-context
node scripts/global-bootstrap.mjs status
```

This adds three global Codex hooks in `CODEX_HOME/hooks.json` and the native
`model_post_turn_compact_threshold_percent = 80` key in the user-level
`config.toml`. The installer preserves unrelated hook groups and settings,
refuses incompatible unmanaged compaction values, and leaves all memory
databases untouched. Hooks may need approval via `/hooks` in the next Codex
session. Check `/mcp`, `memory_status`, and `/hooks` separately: configuration
success alone is not proof that the current runtime delivered any hooks.

The installer `status` reports `adaptiveContext: installed`, `not-installed`,
or `inconsistent`. Its global `uninstall --dry-run` previews removal,
and `uninstall` removes both owned context settings and the MCP registration
when both were installed, without deleting `context.sqlite` or `memory.sqlite`.
An existing global installation created by another bootstrap is **not**
silently replaced. Those installations require explicit manual reconciliation.

The lower-level `scripts/cfm-context-config.mjs` remains available to advanced
operators for independent adaptive-config management; its argument order is
`MODE CODEX_HOME NODE_EXE CONTEXT_CLI IDENTITY_ROOT` for
`install`, `dry-run`, `status`, `uninstall-dry-run`, and `uninstall`.

### Token-efficiency scope

The supervisor may reduce repeated long-context reconstruction by encouraging
short verified checkpoints and selective retrieval. It does **not** compress
model traffic, truncate tool outputs, guarantee context retention, or measure
saved billable tokens. No benchmark demonstrating a specific token reduction
percentage is available. The cost of context hooks and optional recall itself
must be accounted for in any future benchmark.

## Enable on a trusted project (manual installation)

First build CFM with Node 24: npm ci --ignore-scripts && npm run build.

In ~/.codex/config.toml (or CODEX_HOME/config.toml), set:

    model_post_turn_compact_threshold_percent = 80

This key is supported in Codex CLI 0.167.0 and requests native compaction
after the final answer at 80% of the usable window. Do not disable the default
native token-limit auto-compaction. A hook or MCP tool cannot replace it.

Merge the three handlers below into the existing trusted project's
.codex/hooks.json (do not overwrite unrelated hooks). Use JSON-escaped
absolute paths for NODE, CFM_CHECKOUT and PROJECT:

    {
      "hooks": {
        "UserPromptSubmit": [{ "hooks": [{
          "type": "command",
          "command": "\"NODE\" \"CFM_CHECKOUT/dist/src/hooks/context-cli.js\" \"PROJECT\""
        }] }],
        "PreCompact": [{ "hooks": [{
          "type": "command",
          "command": "\"NODE\" \"CFM_CHECKOUT/dist/src/hooks/context-cli.js\" \"PROJECT\""
        }] }],
        "PostCompact": [{ "hooks": [{
          "type": "command",
          "command": "\"NODE\" \"CFM_CHECKOUT/dist/src/hooks/context-cli.js\" \"PROJECT\""
        }] }]
      }
    }

A policy.json with enabled=true must already explicitly authorize the exact
PROJECT root. OFF and revocation deny all observer operations. On Windows
and WSL, storage remains OS-local and independent.

The active CFM Windows global identity adapter is a separate deployment
from the original project-scoped CFM module. Do not replace its global MCP
registration. If consciously using the authorized global identity root,
a hook launcher may pass --global to the context CLI; it then partitions
metadata by canonical event cwd + session id, without storing either in
plaintext. Global hook registration and scope must be reviewed separately.

## Safety and rollback

* Disabling/removing the hooks stops context.sqlite writes, while leaving
  existing memory.sqlite and all existing CFM MCP tools untouched.
* Removing the model_post_turn_compact_threshold_percent override restores
  normal Codex defaults; native token-limit auto-compaction is unaffected.
* No changes to the Codex history file, model API transport, TLS settings,
  Git repositories, private user content or machine-global installation.
* Unit and CLI integration tests use synthetic data only.
* Confirm hook discovery with /hooks in Codex. Validate PreCompact and
  PostCompact event delivery in a controlled session; schema support alone
  does not guarantee hook execution in every situation.

Source of version-pinned contracts:
https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/hooks/src/schema.rs
https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/config/src/config_toml.rs
