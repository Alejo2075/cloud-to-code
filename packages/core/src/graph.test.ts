import { describe, expect, it } from 'vitest';
import { EvidenceGraph, normalizeRelationships } from './graph.js';
import { rel, res, snap } from './test-helpers.js';

const api = res('AWS::ApiGatewayV2::Api', 'orders-api');
const handler = res('AWS::Lambda::Function', 'orders-handler');
const table = res('AWS::DynamoDB::Table', 'orders-table', {
  arn: 'arn:aws:dynamodb:us-east-1:123456789012:table/orders-table',
});
const worker = res('AWS::Lambda::Function', 'orders-worker');
const billing = res('AWS::Lambda::Function', 'billing-handler');
const bus = res('AWS::Events::EventBus', 'shared-events');
const ordersRule = res('AWS::Events::Rule', 'orders-rule');
const billingRule = res('AWS::Events::Rule', 'billing-rule');
const roleA = res('AWS::IAM::Role', 'role-a');

describe('normalizeRelationships', () => {
  it('deduplicates, keeps the strongest confidence and merges evidence', () => {
    const a = { ...rel(api, handler, 'routes-to', 'derived'), evidenceIds: ['e2'] };
    const b = { ...rel(api, handler, 'routes-to', 'confirmed'), evidenceIds: ['e1'] };
    const out = normalizeRelationships([a, b, rel(api, api, 'routes-to')]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ confidence: 'confirmed', evidenceIds: ['e1', 'e2'] });
  });
});

describe('EvidenceGraph', () => {
  const s = snap(
    [api, handler, table, worker, billing, bus, ordersRule, billingRule, roleA],
    [
      rel(api, handler, 'routes-to'),
      rel(table, worker, 'triggers'),
      rel(handler, table, 'possible-access', 'hypothesis'),
      rel(handler, roleA, 'assumes-role'),
      rel(handler, worker, 'same-stack', 'derived'),
      rel(ordersRule, bus, 'rule-on-bus'),
      rel(ordersRule, worker, 'targets'),
      rel(billingRule, bus, 'rule-on-bus'),
      rel(billingRule, billing, 'targets'),
    ],
  );

  it('is deterministic regardless of input order', () => {
    const reversed = snap([...s.resources].reverse(), [...s.relationships].reverse());
    expect(new EvidenceGraph(reversed).applicationCandidates()).toEqual(
      new EvidenceGraph(s).applicationCandidates(),
    );
  });

  it('does not treat possible-access as structure', () => {
    const g = new EvidenceGraph(
      snap([handler, table], [rel(handler, table, 'possible-access', 'hypothesis')]),
    );
    expect(g.applicationCandidates().candidates).toHaveLength(2);
    expect(g.directlyConnected(handler.id, table.id)).toBe(false);
  });

  it('forms candidates and flags hubs touching two candidates as shared', () => {
    const { candidates, shared, unassignedHubs } = new EvidenceGraph(s).applicationCandidates();
    expect(candidates.map((c) => c.name)).toEqual(['billing-handler', 'orders-api']);
    const orders = candidates.find((c) => c.name === 'orders-api')!;
    expect(orders.resourceIds).toEqual(
      expect.arrayContaining([api.id, handler.id, table.id, worker.id, ordersRule.id, roleA.id]),
    );
    expect(shared).toHaveLength(1);
    expect(shared[0]!.resourceId).toBe(bus.id);
    expect(shared[0]!.candidateIds).toHaveLength(2);
    expect(orders.sharedResourceIds).toEqual([bus.id]);
    expect(unassignedHubs).toEqual([]);
  });

  it('assigns a hub used by a single candidate to that candidate', () => {
    const g = new EvidenceGraph(snap([handler, roleA], [rel(handler, roleA, 'assumes-role')]));
    const { candidates, shared } = g.applicationCandidates();
    expect(shared).toEqual([]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.resourceIds).toContain(roleA.id);
  });

  it('reports unresolved endpoints and resolves ARNs', () => {
    const missing = '123456789012/us-east-1/AWS::SQS::Queue/gone';
    const g = new EvidenceGraph(snap([handler, table], [rel(handler, missing, 'triggers')]));
    expect(g.unresolvedEndpoints()).toMatchObject([{ missing }]);
    expect(g.resolveArn(table.arn!)).toBe(table.id);
  });

  it('keeps global resources and unassigned hubs visible', () => {
    const g = new EvidenceGraph(snap([bus], []));
    expect(g.applicationCandidates().unassignedHubs).toEqual([bus.id]);
  });
});
