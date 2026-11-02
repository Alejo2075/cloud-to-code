import { describe, expect, it } from 'vitest';
import { buildResourceId, normalizeArn, parseArn, parseResourceId } from './ids.js';

describe('resource ids', () => {
  it('builds and parses stable IDs', () => {
    const id = buildResourceId({
      accountId: '123456789012',
      region: 'us-east-1',
      type: 'AWS::Lambda::Function',
      physicalId: 'orders-handler',
    });
    expect(id).toBe('123456789012/us-east-1/AWS::Lambda::Function/orders-handler');
    expect(parseResourceId(id)).toEqual({
      accountId: '123456789012',
      region: 'us-east-1',
      type: 'AWS::Lambda::Function',
      physicalId: 'orders-handler',
    });
  });

  it('rejects invalid parts', () => {
    expect(() =>
      buildResourceId({ accountId: '1', region: 'r', type: 'AWS::A::B', physicalId: 'x' }),
    ).toThrow();
    expect(() =>
      buildResourceId({
        accountId: '123456789012',
        region: '',
        type: 'AWS::A::B',
        physicalId: 'x',
      }),
    ).toThrow();
    expect(() =>
      buildResourceId({ accountId: '123456789012', region: 'r', type: 'bad', physicalId: 'x' }),
    ).toThrow();
  });
});

describe('ARNs', () => {
  it('parses ARNs with colons in the resource part', () => {
    expect(parseArn('arn:aws:lambda:us-east-1:123456789012:function:orders:live')).toEqual({
      partition: 'aws',
      service: 'lambda',
      region: 'us-east-1',
      accountId: '123456789012',
      resource: 'function:orders:live',
    });
  });

  it('returns undefined for non-ARNs', () => {
    expect(parseArn('not-an-arn')).toBeUndefined();
    expect(parseArn('arn:aws:s3')).toBeUndefined();
  });

  it('strips Lambda qualifiers so alias and version ARNs join the function', () => {
    const base = 'arn:aws:lambda:us-east-1:123456789012:function:orders';
    expect(normalizeArn(`${base}:live`)).toBe(base);
    expect(normalizeArn(`${base}:12`)).toBe(base);
    expect(normalizeArn(base)).toBe(base);
  });

  it('handles region-less ARNs (S3, IAM) and leaves non-ARNs alone', () => {
    expect(normalizeArn('arn:aws:s3:::my-bucket/')).toBe('arn:aws:s3:::my-bucket');
    expect(normalizeArn('arn:aws:iam::123456789012:role/app')).toBe(
      'arn:aws:iam::123456789012:role/app',
    );
    expect(normalizeArn('plain')).toBe('plain');
  });
});
