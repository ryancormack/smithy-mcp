import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { SmithyKnowledgeBaseStack } from '../lib/smithy-knowledge-base-stack';
import { SmithyMcpServerStack } from '../lib/smithy-mcp-server-stack';

const env = { account: '111111111111', region: 'us-east-1' };

function knowledgeBaseTemplate(stage = 'staging', withBudget = true): Template {
  const app = new cdk.App();
  const stack = new SmithyKnowledgeBaseStack(app, `Knowledge-${stage}`, {
    env,
    stage,
    resourcePrefix: `smithy-mcp-${stage}`,
    ...(withBudget
      ? {
          budgetLimitUsd: 25,
          budgetNotificationEmail: 'alerts@example.com'
        }
      : {})
  });
  return Template.fromStack(stack);
}

function mcpTemplate(stage = 'staging'): Template {
  const app = new cdk.App();
  const support = new cdk.Stack(app, `Support-${stage}`, { env });
  const bucket = new s3.Bucket(support, 'Docs');
  const hostedZone = route53.HostedZone.fromHostedZoneAttributes(support, 'Zone', {
    hostedZoneId: 'Z0123456789EXAMPLE',
    zoneName: 'example.com'
  });
  const stack = new SmithyMcpServerStack(app, `Mcp-${stage}`, {
    env,
    stage,
    resourcePrefix: `smithy-mcp-${stage}`,
    bucket,
    knowledgeBaseId: 'ABCDEFGHIJ',
    resourceRegion: 'us-west-2',
    domainName: stage === 'production' ? 'mcp.example.com' : 'staging.example.com',
    hostedZone,
    mcpReservedConcurrency: stage === 'production' ? 50 : 10,
    wafRateLimit: 500
  });
  return Template.fromStack(stack);
}

test('creates an isolated S3 Vectors Bedrock knowledge base and data source', () => {
  const template = knowledgeBaseTemplate();
  template.resourceCountIs('AWS::S3Vectors::VectorBucket', 1);
  template.hasResourceProperties('AWS::S3Vectors::Index', {
    DataType: 'float32',
    Dimension: 1024,
    DistanceMetric: 'cosine',
    IndexName: 'smithy-mcp-staging-index'
  });
  template.hasResourceProperties('AWS::Bedrock::KnowledgeBase', {
    Name: 'smithy-mcp-staging-kb',
    KnowledgeBaseConfiguration: Match.objectLike({ Type: 'VECTOR' }),
    StorageConfiguration: Match.objectLike({
      Type: 'S3_VECTORS',
      S3VectorsConfiguration: Match.objectLike({
        IndexArn: Match.anyValue(),
        VectorBucketArn: Match.anyValue()
      })
    })
  });
  template.hasResourceProperties('AWS::Bedrock::DataSource', {
    Name: 'smithy-mcp-staging-s3-source',
    DataSourceConfiguration: {
      Type: 'S3',
      S3Configuration: Match.objectLike({ InclusionPrefixes: ['smithy-docs/'] })
    }
  });
  template.resourceCountIs('AWS::Budgets::Budget', 1);
  knowledgeBaseTemplate('staging-no-budget', false).resourceCountIs('AWS::Budgets::Budget', 0);
  const renderedKnowledgeBase = JSON.stringify(template.toJSON());
  assert.match(renderedKnowledgeBase, /s3vectors:GetVectorBucket/);
  assert.match(renderedKnowledgeBase, /s3vectors:GetIndex/);
  template.hasResourceProperties('AWS::IAM::Role', {
    AssumeRolePolicyDocument: {
      Statement: [
        Match.objectLike({
          Principal: { Service: 'bedrock.amazonaws.com' },
          Condition: {
            StringEquals: { 'aws:SourceAccount': '111111111111' },
            ArnLike: { 'AWS:SourceArn': Match.anyValue() }
          }
        })
      ]
    }
  });
});

test('configures scheduled root-context ingestion with bounded retries and exact access', () => {
  const template = knowledgeBaseTemplate();
  template.hasResourceProperties('AWS::S3::Bucket', {
    LifecycleConfiguration: {
      Rules: [
        {
          Id: 'ExpireOrphanedStagingObjects',
          Prefix: 'smithy-mcp-staging/',
          Status: 'Enabled',
          ExpirationInDays: 2,
          NoncurrentVersionExpiration: { NoncurrentDays: 2 },
          AbortIncompleteMultipartUpload: { DaysAfterInitiation: 2 }
        }
      ]
    }
  });
  const bucket = Object.values(
    template.findResources('AWS::S3::Bucket') as Record<
      string,
      { Properties?: { LifecycleConfiguration?: unknown } }
    >
  ).find(resource => resource.Properties?.LifecycleConfiguration);
  assert.ok(bucket);
  assert.doesNotMatch(
    JSON.stringify(bucket.Properties?.LifecycleConfiguration),
    /smithy-docs|smithy-mcp-state/
  );

  template.hasResourceProperties('AWS::Lambda::Function', {
    FunctionName: 'smithy-mcp-staging-ingestion',
    PackageType: 'Image',
    Architectures: ['x86_64'],
    MemorySize: 2048,
    Timeout: 900,
    ReservedConcurrentExecutions: 1,
    TracingConfig: { Mode: 'Active' },
    EphemeralStorage: { Size: 4096 },
    Environment: {
      Variables: Match.objectLike({
        KNOWLEDGE_BASE_ID: Match.anyValue(),
        DATA_SOURCE_ID: Match.anyValue(),
        DOCS_PREFIX: 'smithy-docs/'
      })
    }
  });
  template.hasResourceProperties('AWS::Events::Rule', {
    ScheduleExpression: 'cron(0 6 ? * MON *)',
    Targets: [
      Match.objectLike({
        DeadLetterConfig: Match.objectLike({ Arn: Match.anyValue() }),
        RetryPolicy: { MaximumEventAgeInSeconds: 7200, MaximumRetryAttempts: 2 }
      })
    ]
  });
  template.hasResourceProperties('AWS::Lambda::EventInvokeConfig', {
    MaximumEventAgeInSeconds: 7200,
    MaximumRetryAttempts: 2,
    DestinationConfig: {
      OnFailure: { Destination: Match.anyValue() }
    }
  });
  template.hasResourceProperties('AWS::SQS::Queue', {
    QueueName: 'smithy-mcp-staging-ingestion-dlq',
    MessageRetentionPeriod: 1209600,
    SqsManagedSseEnabled: true
  });
  template.hasOutput('InitialIngestionCommand', {
    Value: Match.objectLike({
      'Fn::Join': Match.arrayWith([
        Match.arrayWith([
          Match.stringLikeRegexp('--region us-east-1'),
          Match.stringLikeRegexp('--invocation-type Event')
        ])
      ])
    })
  });
  template.resourceCountIs('AWS::CloudWatch::Alarm', 3);

  const policies = template.findResources('AWS::IAM::Policy') as Record<string, unknown>;
  const ingestionPolicy = Object.values(policies).find(policy =>
    JSON.stringify(policy).includes('SynchronizeKnowledgeBase')
  );
  assert.ok(ingestionPolicy);
  const rendered = JSON.stringify(ingestionPolicy);
  assert.match(rendered, /bedrock:StartIngestionJob/);
  assert.match(rendered, /bedrock:GetIngestionJob/);
  assert.match(rendered, /s3:GetObject/);
  assert.match(rendered, /s3:PutObject/);
  assert.match(rendered, /s3:DeleteObject/);
  assert.doesNotMatch(rendered, /s3:\*/);
  assert.doesNotMatch(rendered, /bedrock:\*/);
});

test('exposes only exact mcp path through CloudFront and an IAM-authenticated function URL', () => {
  const template = mcpTemplate();
  template.hasResourceProperties('AWS::Lambda::Url', { AuthType: 'AWS_IAM' });
  template.hasResourceProperties('AWS::Lambda::Function', {
    FunctionName: 'smithy-mcp-staging-server',
    PackageType: 'Image',
    ReservedConcurrentExecutions: 10,
    TracingConfig: { Mode: 'Active' },
    Environment: {
      Variables: Match.objectLike({
        AWS_RESOURCE_REGION: 'us-west-2',
        MCP_ALLOWED_HOSTS: 'staging.example.com',
        MCP_ALLOWED_ORIGINS: 'https://staging.example.com'
      })
    }
  });
  template.hasResourceProperties('AWS::CloudFront::Distribution', {
    DistributionConfig: Match.objectLike({
      Aliases: ['staging.example.com'],
      Enabled: true,
      CacheBehaviors: [
        Match.objectLike({
          PathPattern: '/mcp',
          LambdaFunctionAssociations: [
            Match.objectLike({
              EventType: 'origin-request',
              IncludeBody: true
            })
          ]
        })
      ],
      WebACLId: Match.anyValue()
    })
  });
  template.resourceCountIs('AWS::Route53::RecordSet', 2);
  template.hasResourceProperties('AWS::Route53::RecordSet', { Type: 'A' });
  template.hasResourceProperties('AWS::Route53::RecordSet', { Type: 'AAAA' });
  template.hasResourceProperties('AWS::WAFv2::WebACL', {
    AssociationConfig: {
      RequestBody: {
        CLOUDFRONT: { DefaultSizeInspectionLimit: 'KB_64' }
      }
    }
  });
  template.hasResourceProperties('AWS::Lambda::Permission', {
    Action: 'lambda:InvokeFunctionUrl',
    Principal: 'cloudfront.amazonaws.com',
    SourceArn: Match.anyValue()
  });
  template.hasResourceProperties('AWS::Lambda::Permission', {
    Action: 'lambda:InvokeFunction',
    Principal: 'cloudfront.amazonaws.com',
    InvokedViaFunctionUrl: true,
    SourceAccount: '111111111111',
    SourceArn: Match.anyValue()
  });

  const renderedTemplate = template.toJSON();
  const rendered = JSON.stringify(renderedTemplate);
  const mcpFunction = Object.values(
    renderedTemplate.Resources as Record<
      string,
      { Type: string; Properties: Record<string, unknown> }
    >
  ).find(
    resource =>
      resource.Type === 'AWS::Lambda::Function' &&
      resource.Properties.FunctionName === 'smithy-mcp-staging-server'
  );
  assert.ok(mcpFunction);
  assert.equal(mcpFunction.Properties.Layers, undefined);
  assert.match(rendered, /bedrock:us-west-2:111111111111:knowledge-base/);
  assert.doesNotMatch(rendered, /\/mcp\*/);
  assert.match(rendered, /RejectOversizedBodies/);
  assert.match(rendered, /RateLimitByIp/);
  assert.match(rendered, /bedrock:Retrieve/);
  assert.doesNotMatch(rendered, /bedrock:RetrieveAndGenerate/);
  assert.doesNotMatch(rendered, /bedrock:InvokeModel/);
  const outputs = template.toJSON().Outputs ?? {};
  assert.ok(
    !Object.keys(outputs).some(name => name.toLowerCase().includes('functionurl')),
    'the direct Lambda Function URL must not be output'
  );
  assert.doesNotMatch(JSON.stringify(outputs), /FunctionUrl/);

  template.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
    ResponseHeadersPolicyConfig: Match.objectLike({
      SecurityHeadersConfig: Match.objectLike({
        ContentSecurityPolicy: {
          ContentSecurityPolicy:
            "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'",
          Override: true
        }
      })
    })
  });
  const indexHtml = readFileSync(path.resolve(__dirname, '../src/index.html'), 'utf8');
  const styles = readFileSync(path.resolve(__dirname, '../src/styles.css'), 'utf8');
  assert.match(indexHtml, /<link rel="stylesheet" href="\/styles\.css" \/>/);
  assert.doesNotMatch(indexHtml, /<style(?:\s|>)/i);
  assert.match(styles, /\.container\s*\{/);

  template.hasResourceProperties('AWS::CloudWatch::Alarm', {
    AlarmName: 'smithy-mcp-staging-cloudfront-5xx-error-rate',
    Namespace: 'AWS/CloudFront',
    MetricName: '5xxErrorRate',
    Dimensions: [{ Name: 'DistributionId', Value: Match.anyValue() }],
    Statistic: 'Average',
    Period: 300,
    Threshold: 5,
    EvaluationPeriods: 2,
    DatapointsToAlarm: 2,
    ComparisonOperator: 'GreaterThanOrEqualToThreshold',
    TreatMissingData: 'notBreaching'
  });
  template.resourceCountIs('AWS::CloudWatch::Alarm', 4);
});

test('retains logs and isolates stage-qualified names and concurrency', () => {
  const staging = mcpTemplate('staging').toJSON();
  const production = mcpTemplate('production').toJSON();
  const stagingText = JSON.stringify(staging);
  const productionText = JSON.stringify(production);

  assert.match(stagingText, /smithy-mcp-staging-server/);
  assert.match(productionText, /smithy-mcp-production-server/);
  assert.match(stagingText, /"ReservedConcurrentExecutions":10/);
  assert.match(productionText, /"ReservedConcurrentExecutions":50/);

  for (const template of [staging, production]) {
    const logGroups = Object.values(
      template.Resources as Record<string, { Type: string; DeletionPolicy?: string }>
    ).filter(resource => resource.Type === 'AWS::Logs::LogGroup');
    assert.ok(logGroups.length >= 1);
    assert.ok(logGroups.every(resource => resource.DeletionPolicy === 'Retain'));
  }
});
