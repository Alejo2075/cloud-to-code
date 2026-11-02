import { describe, expect, it } from 'vitest';
import {
  IllegalTransitionError,
  canTransition,
  createSession,
  transitionSession,
} from './session-machine.js';

const now = new Date('2026-01-01T00:00:00Z');
const base = () => createSession({ id: 's1', snapshotId: 'snap-1', strategy: 'balanced', now });

describe('session state machine', () => {
  it('starts in DISCOVERING and records history', () => {
    const s = base();
    expect(s.state).toBe('DISCOVERING');
    expect(s.history).toEqual([{ from: null, to: 'DISCOVERING', at: now.toISOString() }]);
  });

  it('walks the happy path', () => {
    let s = base();
    for (const to of [
      'ANALYZING',
      'AWAITING_INPUT',
      'PLANNING',
      'READY_FOR_REVIEW',
      'GENERATING',
      'VALIDATING',
      'COMPLETED',
    ] as const) {
      s = transitionSession(s, to, now);
    }
    expect(s.state).toBe('COMPLETED');
    expect(s.history).toHaveLength(8);
  });

  it('rejects illegal transitions', () => {
    const s = base();
    expect(() => transitionSession(s, 'COMPLETED', now)).toThrow(IllegalTransitionError);
    expect(canTransition('GENERATING', 'AWAITING_INPUT')).toBe(false);
  });

  it('records a reason for BLOCKED and clears it afterwards', () => {
    let s = transitionSession(base(), 'ANALYZING', now);
    s = transitionSession(s, 'BLOCKED', now, 'Blocking question unanswered');
    expect(s.stateReason).toBe('Blocking question unanswered');
    s = transitionSession(s, 'AWAITING_INPUT', now);
    expect(s.stateReason).toBeUndefined();
  });

  it('is a no-op when already in the target state', () => {
    const s = base();
    expect(transitionSession(s, 'DISCOVERING', now)).toBe(s);
  });
});
