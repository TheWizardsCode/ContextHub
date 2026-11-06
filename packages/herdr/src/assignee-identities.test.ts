/**
 * packages/herdr/src/assignee-identities.test.ts — the `dispatcher` claim
 * identity is an agent claim, never a scheduling hold (WL-0MW51OB1Y0073TLG,
 * child WL-0MW55V8PA000CD6P).
 *
 * The dispatcher used to claim with `Map`, the producer sentinel, so an
 * auto-dispatched item was treated as deliberately held: it was filtered out of
 * every dispatch candidate path and attributed to the all-held window even
 * after its session had ended. These tests pin the observable behaviour of the
 * public surface — the constants, the eligibility predicate, the selector
 * filters, the shared window classifier and the dispatch classifier — so the
 * two identities can never silently collapse back into one.
 */

import { describe, expect, it } from 'vitest';
import {
  AGENT_ASSIGNEE,
  DISPATCHER_ASSIGNEE,
  isDispatcherAssignee,
} from './assignee-identities.js';
import {
  classifyWindowHold,
  heldAssigneesOf,
  isAssigneeHeld,
  selectAuditCandidate,
} from './downtime-worker.selection.js';
import { classifyItemForDispatch, classifyItemForDispatchDetail } from './downtime-worker.gates.js';
import type { AuditCandidate, DowntimeItemInfo } from './downtime-worker.types.js';

/** An audit-eligible candidate (recent, no fresh audit) held by *assignee*. */
function auditCandidate(id: string, assignee?: string): AuditCandidate {
  return {
    id,
    title: id,
    status: 'completed',
    stage: 'in_review',
    updatedAt: new Date().toISOString(),
    ...(assignee === undefined ? {} : { assignee }),
  } as AuditCandidate;
}

/** A `plan_complete` item the dispatcher would implement. */
function implementable(id: string, assignee?: string): DowntimeItemInfo {
  return {
    id,
    title: id,
    status: 'open',
    stage: 'plan_complete',
    risk: 'Low',
    effort: 'S',
    ...(assignee === undefined ? {} : { assignee }),
  };
}

describe('assignee identities (WL-0MW55V8PA000CD6P AC1)', () => {
  it('defines the producer sentinel and the dispatcher claim as distinct values', () => {
    expect(AGENT_ASSIGNEE).toBe('Map');
    expect(DISPATCHER_ASSIGNEE).toBe('dispatcher');
    expect(DISPATCHER_ASSIGNEE).not.toBe(AGENT_ASSIGNEE);
  });

  it('recognises the dispatcher identity case- and whitespace-insensitively', () => {
    expect(isDispatcherAssignee('dispatcher')).toBe(true);
    expect(isDispatcherAssignee('Dispatcher')).toBe(true);
    expect(isDispatcherAssignee('  dispatcher ')).toBe(true);
    expect(isDispatcherAssignee('dispatchers')).toBe(false);
    expect(isDispatcherAssignee('Map')).toBe(false);
    expect(isDispatcherAssignee('')).toBe(false);
    expect(isDispatcherAssignee(null)).toBe(false);
    expect(isDispatcherAssignee(undefined)).toBe(false);
  });
});

describe('isAssigneeHeld treats the dispatcher claim as free (AC1/AC3)', () => {
  it('does not hold an item claimed by the dispatcher', () => {
    expect(isAssigneeHeld({ assignee: DISPATCHER_ASSIGNEE })).toBe(false);
    expect(isAssigneeHeld({ assignee: ' Dispatcher ' })).toBe(false);
  });

  it('still holds an item carrying the producer sentinel or an agent identity', () => {
    expect(isAssigneeHeld({ assignee: AGENT_ASSIGNEE })).toBe(true);
    expect(isAssigneeHeld({ assignee: 'map' })).toBe(true);
    expect(isAssigneeHeld({ assignee: 'implement' })).toBe(true);
  });

  it('treats blank and absent assignees as free', () => {
    expect(isAssigneeHeld({ assignee: '' })).toBe(false);
    expect(isAssigneeHeld({ assignee: '   ' })).toBe(false);
    expect(isAssigneeHeld({})).toBe(false);
    expect(isAssigneeHeld(null)).toBe(false);
  });
});

describe('a dispatcher-held item stays dispatchable (AC2)', () => {
  it('selects a dispatcher-claimed audit candidate but not a producer-held one', () => {
    const candidates = [
      auditCandidate('WL-HELD', AGENT_ASSIGNEE),
      auditCandidate('WL-DISPATCHER', DISPATCHER_ASSIGNEE),
    ];

    const selected = selectAuditCandidate(candidates);

    expect(selected?.id).toBe('WL-DISPATCHER');
  });

  it('classifies a dispatcher-claimed item as dispatchable, not assignee-held', () => {
    expect(classifyItemForDispatch(implementable('WL-DISPATCHER', DISPATCHER_ASSIGNEE))).toBe(
      'implement',
    );
    expect(
      classifyItemForDispatchDetail(implementable('WL-HELD', AGENT_ASSIGNEE)),
    ).toEqual({ kind: null, gate: 'assignee-hold' });
  });
});

describe('window-hold attribution excludes the dispatcher claim (AC4/AC5)', () => {
  it('names only genuine holds in heldAssigneesOf', () => {
    expect(
      heldAssigneesOf([
        { assignee: DISPATCHER_ASSIGNEE },
        { assignee: AGENT_ASSIGNEE },
        { assignee: '' },
      ]),
    ).toEqual([AGENT_ASSIGNEE]);
  });

  it('does not call a window of dispatcher claims "all held"', () => {
    expect(
      classifyWindowHold([
        { assignee: DISPATCHER_ASSIGNEE },
        { assignee: DISPATCHER_ASSIGNEE },
      ]),
    ).toEqual({ allHeld: false, heldAssignees: [], count: 2 });
  });

  it('still reports an all-held window of producer holds', () => {
    expect(
      classifyWindowHold([{ assignee: AGENT_ASSIGNEE }, { assignee: AGENT_ASSIGNEE }]),
    ).toEqual({ allHeld: true, heldAssignees: [AGENT_ASSIGNEE], count: 2 });
  });
});
