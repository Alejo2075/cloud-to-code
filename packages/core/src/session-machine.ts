import type { Session, SessionState } from './schemas/session.js';

/** Allowed state transitions. Terminal states have no outgoing transitions except explicit re-opening. */
const TRANSITIONS: Record<SessionState, readonly SessionState[]> = {
  DISCOVERING: ['ANALYZING', 'FAILED', 'BLOCKED'],
  ANALYZING: ['AWAITING_INPUT', 'PLANNING', 'FAILED', 'BLOCKED'],
  AWAITING_INPUT: ['ANALYZING', 'PLANNING', 'BLOCKED', 'FAILED'],
  PLANNING: ['AWAITING_INPUT', 'READY_FOR_REVIEW', 'BLOCKED', 'FAILED'],
  READY_FOR_REVIEW: ['GENERATING', 'AWAITING_INPUT', 'PLANNING', 'FAILED'],
  GENERATING: ['VALIDATING', 'FAILED', 'BLOCKED'],
  VALIDATING: ['COMPLETED', 'GENERATING', 'AWAITING_INPUT', 'FAILED', 'BLOCKED'],
  COMPLETED: ['AWAITING_INPUT', 'PLANNING'],
  BLOCKED: ['ANALYZING', 'AWAITING_INPUT', 'PLANNING', 'FAILED'],
  FAILED: ['ANALYZING', 'AWAITING_INPUT', 'PLANNING'],
};

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: SessionState,
    readonly to: SessionState,
  ) {
    super(`Illegal session transition ${from} -> ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

export function canTransition(from: SessionState, to: SessionState): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Returns a new session in state `to`, appending to history. Throws on illegal transitions. */
export function transitionSession(
  session: Session,
  to: SessionState,
  now: Date,
  reason?: string,
): Session {
  if (session.state === to) return session;
  if (!canTransition(session.state, to)) throw new IllegalTransitionError(session.state, to);
  const at = now.toISOString();
  const next: Session = {
    ...session,
    state: to,
    updatedAt: at,
    history: [...session.history, { from: session.state, to, at, ...(reason ? { reason } : {}) }],
  };
  if (reason && (to === 'BLOCKED' || to === 'FAILED')) next.stateReason = reason;
  else delete next.stateReason;
  return next;
}

export function createSession(params: {
  id: string;
  snapshotId: string;
  strategy: Session['strategy'];
  applicationId?: string;
  now: Date;
}): Session {
  const at = params.now.toISOString();
  return {
    schemaVersion: '1',
    id: params.id,
    state: 'DISCOVERING',
    snapshotId: params.snapshotId,
    ...(params.applicationId ? { applicationId: params.applicationId } : {}),
    strategy: params.strategy,
    createdAt: at,
    updatedAt: at,
    history: [{ from: null, to: 'DISCOVERING', at }],
  };
}
