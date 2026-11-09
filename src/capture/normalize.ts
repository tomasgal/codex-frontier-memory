import { createHash } from 'node:crypto';
import type { MemoryInput, Provenance, Verification } from '../memory/types.js';

export const MAX_PAYLOAD_BYTES = 64 * 1024;

// Best-effort defense in depth for manual input; this is not a secret detector.
export function text(value: unknown, max = 16_384): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new Error('Invalid or oversized text field');
  }
  return value.normalize('NFC').replace(/\r\n?/g, '\n').trim()
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED KEY]')
    .replace(/\bBearer\s+[^\s]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk-[a-zA-Z0-9_-]{12,}|gh[pousr]_[a-zA-Z0-9_]{12,})\b/g, '[REDACTED TOKEN]')
    .replace(/\b(api[_-]?key|password|secret|token)\s*[:=]\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi, '$1=[REDACTED]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED EMAIL]');
}

function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)
      || !Number.isFinite(Date.parse(value))) throw new Error('Invalid UTC timestamp');
  const normalized = new Date(value).toISOString();
  const padded = value.includes('.') ? value.replace(/\.(\d{1,3})Z$/, (_, fraction: string) => `.${fraction.padEnd(3, '0')}Z`)
    : value.replace('Z', '.000Z');
  if (normalized !== padded) throw new Error('Invalid UTC timestamp');
  return normalized;
}

export function provenance(value: Provenance): Provenance {
  if (!value || typeof value !== 'object') throw new Error('Provenance is required');
  return { sourceRef: text(value.sourceRef, 2048), eventId: text(value.eventId, 512), observedAt: timestamp(value.observedAt) };
}

export function bounded(value: unknown): void {
  if (Buffer.byteLength(JSON.stringify(value) ?? '') > MAX_PAYLOAD_BYTES) throw new Error('Payload exceeds 64 KiB');
}

export function normalize(input: MemoryInput): MemoryInput {
  bounded(input);
  const base = { summary: text(input.summary, 2048), detail: text(input.detail), provenance: provenance(input.provenance) };
  if (input.kind === 'error' && input.status === 'observed_error') return { ...base, kind: input.kind, status: input.status };
  if (input.kind === 'decision' && ['user_decision', 'inferred_decision'].includes(input.status)) {
    return { ...base, kind: input.kind, status: input.status, rationale: text(input.rationale) };
  }
  if (input.kind === 'fix') {
    const errorId = text(input.errorId, 128);
    if (input.status === 'proposed_fix') return { ...base, kind: 'fix', status: input.status, errorId };
    if (input.status === 'tested_fix') {
      const v = input.verification;
      if (!v || v.result !== 'passed') throw new Error('Tested fixes require successful verification evidence');
      const verification: Verification = {
        check: text(v.check, 2048), result: 'passed', evidence: text(v.evidence),
        verifiedAt: timestamp(v.verifiedAt), source: provenance(v.source),
      };
      return { ...base, kind: 'fix', status: input.status, errorId, verification };
    }
  }
  throw new Error('Invalid memory kind or epistemic status');
}

export function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
