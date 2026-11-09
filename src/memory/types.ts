export interface Provenance {
  /** Opaque caller-supplied reference. Never dereferenced or executed. */
  sourceRef: string;
  eventId: string;
  observedAt: string;
}

export interface Verification {
  check: string;
  result: 'passed';
  evidence: string;
  verifiedAt: string;
  source: Provenance;
}

interface BaseInput {
  summary: string;
  detail: string;
  provenance: Provenance;
}

export type MemoryInput = BaseInput & (
  | { kind: 'error'; status: 'observed_error' }
  | { kind: 'fix'; status: 'proposed_fix'; errorId: string }
  | { kind: 'fix'; status: 'tested_fix'; errorId: string; verification: Verification }
  | { kind: 'decision'; status: 'user_decision' | 'inferred_decision'; rationale: string }
);

export type MemoryKind = MemoryInput['kind'];
export type EpistemicStatus = MemoryInput['status'] | 'superseded';

export interface MemoryRecord {
  id: string;
  kind: MemoryKind;
  status: EpistemicStatus;
  /** The original epistemic claim survives supersession. */
  originalStatus: MemoryInput['status'];
  summary: string;
  detail: string;
  errorId?: string;
  rationale?: string;
  verification?: Verification;
  provenance: Provenance[];
  createdAt: string;
  supersededBy?: string;
  supersession?: { reason: string; source: Provenance; at: string };
  untrusted: true;
}
