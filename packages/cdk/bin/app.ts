#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { SmithyDnsStack } from '../lib/smithy-dns-stack';
import { SmithyKnowledgeBaseStack } from '../lib/smithy-knowledge-base-stack';
import { SmithyMcpServerStack } from '../lib/smithy-mcp-server-stack';

interface EnvironmentConfig {
  account: string;
  region: string;
  domain: string;
  hostedZoneId: string;
  hostedZoneName: string;
  budgetLimitUsd?: number;
  budgetNotificationEmail?: string;
  mcpReservedConcurrency?: number;
  wafRateLimit?: number;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function optionalPositiveNumber(value: unknown, name: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return value;
}

function optionalPositiveInteger(value: unknown, name: string): number | undefined {
  const parsed = optionalPositiveNumber(value, name);
  if (parsed !== undefined && !Number.isInteger(parsed)) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function loadEnvironmentConfig(app: cdk.App, stage: string): EnvironmentConfig {
  const raw = app.node.tryGetContext(stage) as Record<string, unknown> | undefined;
  if (!raw) {
    throw new Error(`No CDK context found for environment: ${stage}`);
  }

  const account = requiredString(raw.account, `${stage}.account`);
  if (!/^\d{12}$/.test(account)) {
    throw new Error(`${stage}.account must be a 12-digit AWS account ID`);
  }

  const region = requiredString(raw.region, `${stage}.region`);
  if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(region)) {
    throw new Error(`${stage}.region must be a valid AWS region`);
  }
  const domain = requiredString(raw.domain, `${stage}.domain`).toLowerCase();
  const hostedZoneId = requiredString(raw.hostedZoneId, `${stage}.hostedZoneId`);
  const hostedZoneName = requiredString(raw.hostedZoneName, `${stage}.hostedZoneName`)
    .replace(/\.$/, '')
    .toLowerCase();

  if (domain !== hostedZoneName && !domain.endsWith(`.${hostedZoneName}`)) {
    throw new Error(`${stage}.domain must be within ${stage}.hostedZoneName`);
  }

  const budgetLimitUsd = optionalPositiveNumber(raw.budgetLimitUsd, `${stage}.budgetLimitUsd`);
  const budgetNotificationEmail = raw.budgetNotificationEmail === undefined
    ? undefined
    : requiredString(raw.budgetNotificationEmail, `${stage}.budgetNotificationEmail`);
  if ((budgetLimitUsd === undefined) !== (budgetNotificationEmail === undefined)) {
    throw new Error(
      `${stage}.budgetLimitUsd and ${stage}.budgetNotificationEmail must be configured together`
    );
  }

  return {
    account,
    region,
    domain,
    hostedZoneId,
    hostedZoneName,
    budgetLimitUsd,
    budgetNotificationEmail,
    mcpReservedConcurrency: optionalPositiveInteger(
      raw.mcpReservedConcurrency,
      `${stage}.mcpReservedConcurrency`
    ),
    wafRateLimit: optionalPositiveInteger(raw.wafRateLimit, `${stage}.wafRateLimit`)
  };
}

const app = new cdk.App();
const stage = requiredString(app.node.tryGetContext('environment') ?? 'staging', 'environment')
  .toLowerCase();
if (stage !== 'staging' && stage !== 'production') {
  throw new Error('environment must be either staging or production');
}

const config = loadEnvironmentConfig(app, stage);
const workloadEnv = { account: config.account, region: config.region };
const edgeEnv = { account: config.account, region: 'us-east-1' };
const resourcePrefix = `smithy-mcp-${stage}`;
const commonProps = {
  stage,
  resourcePrefix,
  terminationProtection: stage === 'production'
};

const dnsStack = new SmithyDnsStack(app, `SmithyDns-${stage}`, {
  ...commonProps,
  env: edgeEnv,
  stackName: `${resourcePrefix}-dns`,
  description: `${stage}: imported Route53 zone for ${config.domain}`,
  domainName: config.domain,
  hostedZoneId: config.hostedZoneId,
  hostedZoneName: config.hostedZoneName
});

const knowledgeBaseStack = new SmithyKnowledgeBaseStack(app, `SmithyKnowledgeBase-${stage}`, {
  ...commonProps,
  env: workloadEnv,
  crossRegionReferences: config.region !== 'us-east-1',
  stackName: `${resourcePrefix}-knowledge-base`,
  description: `${stage}: Smithy documentation, S3 Vectors, Bedrock, and ingestion`,
  budgetLimitUsd: config.budgetLimitUsd,
  budgetNotificationEmail: config.budgetNotificationEmail
});

new SmithyMcpServerStack(app, `SmithyMcpServer-${stage}`, {
  ...commonProps,
  env: edgeEnv,
  crossRegionReferences: config.region !== 'us-east-1',
  stackName: `${resourcePrefix}-server`,
  description: `${stage}: private-origin MCP server at ${config.domain}`,
  bucket: knowledgeBaseStack.bucket,
  knowledgeBaseId: knowledgeBaseStack.knowledgeBaseId,
  resourceRegion: config.region,
  domainName: config.domain,
  hostedZone: dnsStack.hostedZone,
  mcpReservedConcurrency: config.mcpReservedConcurrency ?? (stage === 'production' ? 50 : 10),
  wafRateLimit: config.wafRateLimit ?? (stage === 'production' ? 2_000 : 500)
});

cdk.Tags.of(app).add('Application', 'smithy-mcp');
cdk.Tags.of(app).add('Environment', stage);

app.synth();
