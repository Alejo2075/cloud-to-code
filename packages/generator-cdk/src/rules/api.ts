import type { GenContext } from '../context.js';
import { quote } from '../ts.js';
import { GenerationError } from '../types.js';
import { RuleRun, type RuleResult } from './common.js';

interface Route {
  routeKey: string;
  target?: string;
  authorizationType?: string;
}
interface Integration {
  integrationId: string;
  integrationType?: string;
  integrationUri?: string;
  payloadFormatVersion?: string;
}
interface Stage {
  stageName: string;
  autoDeploy?: boolean;
}
interface Cors {
  allowOrigins?: string[];
  allowMethods?: string[];
  allowHeaders?: string[];
  exposeHeaders?: string[];
  maxAge?: number;
  allowCredentials?: boolean;
}

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', 'ANY']);
const CORS_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']);

export function emitHttpApi(ctx: GenContext, id: string): RuleResult {
  const run = new RuleRun(ctx, id, 'api/http-api@1');
  const { t } = run;
  const out = ctx.out;
  const v = ctx.varName(id);
  const logical = ctx.logicalId(id);
  out.use('apigwv2');
  out.use('integrations');
  out.use('cdk');

  const protocol = t.take<string>('protocolType');
  if (protocol !== 'HTTP') {
    run.unresolve(
      'protocolType',
      `Only HTTP APIs are supported (found ${String(protocol)}); WebSocket and REST APIs are not generated.`,
    );
    throw new GenerationError('unsupported-api', `API ${run.r.displayName} is not an HTTP API.`);
  }

  const props: string[] = [];
  const name = t.take<string>('name');
  if (name) props.push(`apiName: ${ctx.str(name)},`);
  const description = t.take<string>('description');
  if (description) props.push(`description: ${ctx.str(description)},`);

  const cors = t.take<Cors>('corsConfiguration');
  if (cors) {
    const parts: string[] = [];
    if (cors.allowOrigins)
      parts.push(`allowOrigins: [${cors.allowOrigins.map((o) => ctx.str(o)).join(', ')}],`);
    if (cors.allowMethods) {
      const methods = cors.allowMethods.filter((m) => CORS_METHODS.has(m));
      parts.push(
        `allowMethods: [${methods.map((m) => `apigwv2.CorsHttpMethod.${m}`).join(', ')}],`,
      );
      if (methods.length !== cors.allowMethods.length)
        run.unresolve(
          'corsConfiguration.allowMethods',
          'Unsupported CORS method (e.g. "*") skipped; review CORS manually.',
        );
    }
    if (cors.allowHeaders)
      parts.push(`allowHeaders: [${cors.allowHeaders.map((h) => ctx.str(h)).join(', ')}],`);
    if (cors.exposeHeaders)
      parts.push(`exposeHeaders: [${cors.exposeHeaders.map((h) => ctx.str(h)).join(', ')}],`);
    if (typeof cors.maxAge === 'number')
      parts.push(`maxAge: cdk.Duration.seconds(${cors.maxAge}),`);
    if (typeof cors.allowCredentials === 'boolean')
      parts.push(`allowCredentials: ${cors.allowCredentials},`);
    props.push(`corsPreflight: { ${parts.join(' ')} },`);
  }

  const stages = t.take<Stage[]>('stages') ?? [];
  const defaultStage = stages.find((s) => s.stageName === '$default');
  props.push(`createDefaultStage: ${!!defaultStage},`);
  if (defaultStage && defaultStage.autoDeploy === false)
    run.unresolve(
      'stages',
      '$default stage without auto-deploy cannot be created with the L2 HttpApi default stage.',
    );
  t.omitted('apiEndpoint', 'Endpoint is assigned by AWS; the new API will have a different URL.');
  t.omitted(
    'routeSelectionExpression',
    'HTTP APIs always use the default route selection expression.',
  );

  run.header();
  out.line(`const ${v} = new apigwv2.HttpApi(this, ${ctx.str(logical)}, {`);
  for (const p of props) out.line(`  ${p}`);
  out.line('});');

  for (const stage of stages.filter((s) => s.stageName !== '$default')) {
    out.line(
      `${v}.addStage(${ctx.str(`${logical}Stage${stage.stageName.replace(/[^A-Za-z0-9]/g, '')}`)}, { stageName: ${ctx.str(stage.stageName)}, autoDeploy: ${stage.autoDeploy !== false} });`,
    );
  }

  const integrations = new Map(
    (t.take<Integration[]>('integrations') ?? []).map((i) => [i.integrationId, i]),
  );
  const made = new Map<string, string>();
  const integrationVar = (integrationId: string): string | undefined => {
    const existing = made.get(integrationId);
    if (existing) return existing;
    const integration = integrations.get(integrationId);
    const fnId = ctx.resolveArn(integration?.integrationUri);
    if (
      !integration ||
      integration.integrationType !== 'AWS_PROXY' ||
      !fnId ||
      ctx.entry(fnId).resource.type !== 'AWS::Lambda::Function'
    )
      return undefined;
    const name = `${v}Integration${made.size + 1}`;
    const pfv = integration.payloadFormatVersion === '1.0' ? 'VERSION_1_0' : 'VERSION_2_0';
    out.line(
      `const ${name} = new integrations.HttpLambdaIntegration(${ctx.str(`${logical}Integration${integrationId.replace(/[^A-Za-z0-9]/g, '')}`)}, ${ctx.ref(fnId)}, { payloadFormatVersion: apigwv2.PayloadFormatVersion.${pfv} });`,
    );
    made.set(integrationId, name);
    return name;
  };

  const routes = t.take<Route[]>('routes') ?? [];
  routes.forEach((route, index) => {
    const label = `routes[${quote(route.routeKey)}]`;
    if (route.authorizationType && route.authorizationType !== 'NONE') {
      run.unresolve(
        label,
        `Route uses ${route.authorizationType} authorization, which is not generated yet. The route was NOT created so it cannot become unauthenticated; add it with its authorizer manually.`,
      );
      return;
    }
    const integrationId = route.target?.replace(/^integrations\//, '');
    const integration = integrationId ? integrationVar(integrationId) : undefined;
    if (!integration) {
      run.unresolve(
        label,
        'Route integration is not a Lambda proxy to a function in this plan; add it manually.',
      );
      return;
    }
    if (route.routeKey === '$default') {
      out.line(
        `new apigwv2.HttpRoute(this, ${ctx.str(`${logical}Route${index + 1}Default`)}, { httpApi: ${v}, routeKey: apigwv2.HttpRouteKey.DEFAULT, integration: ${integration} });`,
      );
      return;
    }
    const m = /^([A-Z]+) (\/\S*)$/.exec(route.routeKey);
    if (!m || !HTTP_METHODS.has(m[1]!)) {
      run.unresolve(label, 'Route key is not in "METHOD /path" form; add it manually.');
      return;
    }
    out.line(
      `${v}.addRoutes({ path: ${ctx.str(m[2]!)}, methods: [apigwv2.HttpMethod.${m[1]}], integration: ${integration} });`,
    );
  });

  run.tags(v);
  run.register('apis', v);
  return run.result('L2');
}
