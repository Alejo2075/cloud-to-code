import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ALLOWED_COMMANDS,
  NEVER_ALLOWED,
  ForbiddenAwsOperationError,
  guardSender,
  isAllowed,
  type ServiceKey,
} from './index.js';

const forbidden = [
  ['dynamodb', 'PutItemCommand'],
  ['dynamodb', 'ScanCommand'],
  ['dynamodb', 'GetItemCommand'],
  ['dynamodb', 'DeleteTableCommand'],
  ['lambda', 'InvokeCommand'],
  ['lambda', 'GetFunctionCommand'],
  ['lambda', 'UpdateFunctionCodeCommand'],
  ['sqs', 'ReceiveMessageCommand'],
  ['sqs', 'SendMessageCommand'],
  ['sqs', 'DeleteQueueCommand'],
  ['s3', 'GetObjectCommand'],
  ['s3', 'ListObjectsV2Command'],
  ['s3', 'PutBucketPolicyCommand'],
  ['iam', 'ListRolesCommand'],
  ['iam', 'CreateRoleCommand'],
  ['iam', 'AttachRolePolicyCommand'],
  ['eventbridge', 'PutEventsCommand'],
  ['eventbridge', 'PutRuleCommand'],
  ['apigatewayv2', 'CreateApiCommand'],
  ['apigatewayv2', 'DeleteApiCommand'],
  ['sts', 'AssumeRoleCommand'],
] as const;

describe('read-only allowlist', () => {
  it('only contains List/Get/Describe commands and none of the never-allowed ones', () => {
    for (const [service, commands] of Object.entries(ALLOWED_COMMANDS)) {
      for (const c of commands) {
        expect(c, `${service}:${c}`).toMatch(/^(Get|List|Describe)[A-Z]\w*Command$/);
        expect(NEVER_ALLOWED).not.toContain(c);
      }
    }
  });

  it.each(forbidden)('rejects %s %s before anything is sent', async (service, name) => {
    const sent: string[] = [];
    const sender = guardSender(service as ServiceKey, {
      async send(command) {
        sent.push(command.constructor.name);
        return {};
      },
    });
    const Command = { [name]: class {} }[name]!;
    await expect(sender.send(new Command())).rejects.toBeInstanceOf(ForbiddenAwsOperationError);
    expect(sent).toEqual([]);
    expect(isAllowed(service as ServiceKey, name)).toBe(false);
  });

  it('does not let a command through under the wrong service', () => {
    expect(isAllowed('lambda', 'ListTablesCommand')).toBe(false);
    expect(isAllowed('dynamodb', 'ListTablesCommand')).toBe(true);
  });

  it('every command the collectors construct is allowlisted (no mutation reachable from the scan path)', () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), 'collectors');
    const used = new Set<string>();
    for (const file of [
      ...readdirSync(dir).map((f) => join(dir, f)),
      join(dirname(dir), 'discover.ts'),
    ]) {
      for (const m of readFileSync(file, 'utf8').matchAll(/new (\w+Command)\(/g)) used.add(m[1]!);
    }
    expect(used.size).toBeGreaterThan(25);
    const allowed = new Set(Object.values(ALLOWED_COMMANDS).flat());
    expect([...used].filter((c) => !allowed.has(c))).toEqual([]);
    // And every allowlisted command is actually used (no dead permissions).
    expect([...allowed].filter((c) => !used.has(c))).toEqual([]);
  });
});

import { IAM_ACTION_FOR_COMMAND, leastPrivilegePolicy } from './index.js';

describe('least-privilege IAM policy', () => {
  it('maps every allowlisted command to an action (or none for STS) and only to read actions', () => {
    const allowed = Object.values(ALLOWED_COMMANDS).flat();
    expect(Object.keys(IAM_ACTION_FOR_COMMAND).sort()).toEqual([...allowed].sort());
    const actions = leastPrivilegePolicy().Statement[0]!.Action;
    for (const a of actions) {
      expect(a, a).toMatch(/^(apigateway:GET|[a-z0-9]+:(Get|List|Describe)\w+)$/);
    }
    expect(actions).not.toContain('s3:GetObject');
    expect(actions).not.toContain('dynamodb:Scan');
  });

  it('narrows to the requested services', () => {
    const actions = leastPrivilegePolicy(['sqs']).Statement[0]!.Action;
    expect(actions).toEqual(['sqs:GetQueueAttributes', 'sqs:ListQueueTags', 'sqs:ListQueues']);
  });
});
