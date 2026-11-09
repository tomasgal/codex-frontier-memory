import { authorize } from '../capture/policy.js';
import { projectIdentity, resolveStoragePaths } from '../storage/paths.js';

const MAX_EVENT_BYTES = 256 * 1024;
const permissions = new Set(['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions']);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 4096;
const nullableString = (v: unknown) => v === null || typeof v === 'string';

/** Accept the 0.167.0 wire shape; input and messages are never retained. */
export function captureHook(projectRoot: string, raw: string): 'captured' | 'ignored' {
  if (Buffer.byteLength(raw) > MAX_EVENT_BYTES) throw new Error('Hook input too large');
  const event: unknown = JSON.parse(raw);
  if (!object(event) || !str(event.cwd) || !str(event.session_id) || !str(event.turn_id)
      || !str(event.model) || typeof event.permission_mode !== 'string' || !permissions.has(event.permission_mode)
      || !('transcript_path' in event) || !nullableString(event.transcript_path)) throw new Error('Invalid hook input');
  const project = projectIdentity(projectRoot);
  // Bind to an explicit root, never infer a root from an untrusted event or a parent directory.
  if (projectIdentity(event.cwd) !== project) throw new Error('Hook project mismatch');
  authorize(resolveStoragePaths(), project);
  if (event.hook_event_name === 'Stop') {
    if (typeof event.stop_hook_active !== 'boolean' || !('last_assistant_message' in event)
        || !nullableString(event.last_assistant_message)) throw new Error('Invalid Stop input');
    return 'ignored';
  }
  if (event.hook_event_name !== 'PostToolUse' || !str(event.tool_name) || !str(event.tool_use_id)
      || !('tool_input' in event) || !('tool_response' in event)
      || (event.agent_id !== undefined && !str(event.agent_id))
      || (event.agent_type !== undefined && !str(event.agent_type))) throw new Error('Invalid PostToolUse input');
  // The pinned hook schema defines no allowlisted machine-readable tool-error
  // category. Ignore isError, unknown fields and content without inference.
  return 'ignored';
}

export { MAX_EVENT_BYTES };
