#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { SmithyKnowledgeBaseStack } from '../lib/smithy-knowledge-base-stack';
import { SmithyMcpServerStack } from '../lib/smithy-mcp-server-stack';
import { SmithyDnsStack } from '../lib/smithy-dns-stack';

const app = new cdk.App();

const environment = app.node.tryGetContext('environment') || 'staging';
const envConfig = app.node.tryGetContext(environment);

if (!envConfig) {
  throw new Error(`No config found for environment: ${environment}`);
}

if (!envConfig.knowledgeBaseId) {
  throw new Error(`Knowledge Base ID not set for ${environment} in cdk.context.json`);
}

// DNS Stack (creates hosted zone for this environment's domain)
const dnsStack = new SmithyDnsStack(app, 'SmithyDnsStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'us-east-1',
  },
  description: `Route53 Hosted Zone for ${envConfig.domain}`,
  domainName: envConfig.domain,
});

// Knowledge Base Stack
const kbStack = new SmithyKnowledgeBaseStack(app, 'SmithyKnowledgeBaseStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'us-east-1',
  },
  description: `${environment}: S3 bucket for Smithy documentation`,
});

// MCP Server Stack
new SmithyMcpServerStack(app, 'SmithyMcpServerStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'us-east-1',
  },
  description: `${environment}: MCP Server at ${envConfig.domain}`,
  bucket: kbStack.bucket,
  knowledgeBaseId: envConfig.knowledgeBaseId,
  domainName: envConfig.domain,
  hostedZone: dnsStack.hostedZone,
});

app.synth();
