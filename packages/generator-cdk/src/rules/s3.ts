import type { GenContext } from '../context.js';
import { RuleRun, type RuleResult } from './common.js';

interface PublicAccessBlock {
  blockPublicAcls?: boolean;
  ignorePublicAcls?: boolean;
  blockPublicPolicy?: boolean;
  restrictPublicBuckets?: boolean;
}

export function emitBucket(ctx: GenContext, id: string): RuleResult {
  const run = new RuleRun(ctx, id, 'data/s3-bucket@1');
  const { t } = run;
  const out = ctx.out;
  const v = ctx.varName(id);
  out.use('s3');
  out.use('cdk');

  const props: string[] = [];
  if (t.take<string>('versioning') === 'Enabled') props.push('versioned: true,');
  const enc = t.take<{ sseAlgorithm?: string; kmsMasterKeyId?: string }>('encryption');
  if (enc?.sseAlgorithm === 'AES256') props.push('encryption: s3.BucketEncryption.S3_MANAGED,');
  else if (enc?.sseAlgorithm === 'aws:kms') {
    props.push('encryption: s3.BucketEncryption.KMS_MANAGED,');
    if (enc.kmsMasterKeyId) {
      run.unresolve(
        'encryption',
        'A customer-managed KMS key was used; the AWS-managed key is generated instead. Configure the key manually.',
      );
    }
  } else if (enc?.sseAlgorithm)
    run.unresolve('encryption', `Unknown encryption algorithm ${enc.sseAlgorithm}.`);

  const pab = t.take<PublicAccessBlock>('publicAccessBlock');
  if (pab) {
    const all =
      pab.blockPublicAcls &&
      pab.ignorePublicAcls &&
      pab.blockPublicPolicy &&
      pab.restrictPublicBuckets;
    if (all) props.push('blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,');
    else {
      props.push(
        `blockPublicAccess: new s3.BlockPublicAccess({ blockPublicAcls: ${!!pab.blockPublicAcls}, ignorePublicAcls: ${!!pab.ignorePublicAcls}, blockPublicPolicy: ${!!pab.blockPublicPolicy}, restrictPublicBuckets: ${!!pab.restrictPublicBuckets} }),`,
      );
    }
  }
  t.omitted(
    'bucketName',
    'Physical name not set: bucket names are global and the existing bucket would collide.',
  );
  props.push('removalPolicy: cdk.RemovalPolicy.RETAIN,');

  run.header();
  out.line(`const ${v} = new s3.Bucket(this, ${ctx.str(ctx.logicalId(id))}, {`);
  for (const p of props) out.line(`  ${p}`);
  out.line('});');
  run.tags(v);
  run.register('buckets', v);
  return run.result('L2');
}
