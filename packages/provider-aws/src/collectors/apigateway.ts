import {
  GetApisCommand,
  GetIntegrationsCommand,
  GetRoutesCommand,
  GetStagesCommand,
  type GetApisCommandOutput,
  type GetIntegrationsCommandOutput,
  type GetRoutesCommandOutput,
  type GetStagesCommandOutput,
} from '@aws-sdk/client-apigatewayv2';
import { lambdaArnFromIntegrationUri, resourceFromArn } from '../arn.js';
import type { CollectContext } from '../sink.js';
import { paginate } from '../util.js';

export async function collectApiGateway(ctx: CollectContext): Promise<void> {
  const { sink, region } = ctx;
  const apis = await paginate(async (token) => {
    const out = await ctx.send<GetApisCommandOutput>(
      new GetApisCommand({ NextToken: token, MaxResults: '100' }),
    );
    return { items: out.Items ?? [], next: out.NextToken };
  });

  await ctx.map(apis, async (api) => {
    const apiId = api.ApiId;
    if (!apiId) return;
    const [routes, integrations, stages] = await Promise.all([
      ctx.soft(`apigatewayv2:GetRoutes(${apiId})`, () =>
        paginate(async (t) => {
          const out = await ctx.send<GetRoutesCommandOutput>(
            new GetRoutesCommand({ ApiId: apiId, NextToken: t, MaxResults: '100' }),
          );
          return { items: out.Items ?? [], next: out.NextToken };
        }),
      ),
      ctx.soft(`apigatewayv2:GetIntegrations(${apiId})`, () =>
        paginate(async (t) => {
          const out = await ctx.send<GetIntegrationsCommandOutput>(
            new GetIntegrationsCommand({ ApiId: apiId, NextToken: t, MaxResults: '100' }),
          );
          return { items: out.Items ?? [], next: out.NextToken };
        }),
      ),
      ctx.soft(`apigatewayv2:GetStages(${apiId})`, () =>
        paginate(async (t) => {
          const out = await ctx.send<GetStagesCommandOutput>(
            new GetStagesCommand({ ApiId: apiId, NextToken: t, MaxResults: '100' }),
          );
          return { items: out.Items ?? [], next: out.NextToken };
        }),
      ),
    ]);

    const cors = api.CorsConfiguration;
    const resource = sink.addResource({
      type: 'AWS::ApiGatewayV2::Api',
      region,
      physicalId: apiId,
      displayName: api.Name ?? apiId,
      arn: `arn:aws:apigateway:${region}::/apis/${apiId}`,
      operation: 'apigatewayv2:GetApis',
      tags: api.Tags,
      properties: {
        name: api.Name,
        protocolType: api.ProtocolType,
        apiEndpoint: api.ApiEndpoint,
        routeSelectionExpression: api.RouteSelectionExpression,
        description: api.Description || undefined,
        corsConfiguration: cors
          ? {
              allowOrigins: cors.AllowOrigins,
              allowMethods: cors.AllowMethods,
              allowHeaders: cors.AllowHeaders,
              exposeHeaders: cors.ExposeHeaders,
              maxAge: cors.MaxAge,
              allowCredentials: cors.AllowCredentials,
            }
          : undefined,
        integrations: (integrations ?? []).map((i) => ({
          integrationId: i.IntegrationId,
          integrationType: i.IntegrationType,
          integrationUri: i.IntegrationUri,
          payloadFormatVersion: i.PayloadFormatVersion,
        })),
        routes: (routes ?? []).map((r) => ({
          routeKey: r.RouteKey,
          target: r.Target,
          authorizationType: r.AuthorizationType ?? 'NONE',
        })),
        stages: (stages ?? []).map((s) => ({ stageName: s.StageName, autoDeploy: s.AutoDeploy })),
      },
    });

    for (const integration of integrations ?? []) {
      const fnArn = lambdaArnFromIntegrationUri(integration.IntegrationUri);
      const fn = fnArn ? resourceFromArn(fnArn, ctx.accountId) : undefined;
      if (fn)
        sink.relate(
          resource.id,
          fn.id,
          'routes-to',
          'confirmed',
          'apigatewayv2:GetIntegrations',
          `${api.Name ?? apiId} -> ${fn.physicalId}`,
        );
    }
  });
}
