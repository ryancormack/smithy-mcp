#!/usr/bin/env node
import { chmod, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [environment] = process.argv.slice(2);
const outputPath = path.resolve(process.env.CDK_CONTEXT_PATH ?? 'packages/cdk/cdk.context.json');

function fail(message) {
  throw new Error(message);
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    fail(`${name} is required`);
  }
  return value;
}

function optionalPositiveNumber(name, integer = false) {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || (integer && !Number.isInteger(value))) {
    fail(`${name} must be a positive ${integer ? 'integer' : 'number'}`);
  }
  return value;
}

if (environment !== 'staging' && environment !== 'production') {
  fail('environment argument must be staging or production');
}

const account = required('CDK_ACCOUNT');
const region = required('CDK_WORKLOAD_REGION');
const domain = required('CDK_DOMAIN').toLowerCase();
const hostedZoneId = required('CDK_HOSTED_ZONE_ID');
const hostedZoneName = required('CDK_HOSTED_ZONE_NAME').replace(/\.$/, '').toLowerCase();

if (!/^\d{12}$/.test(account)) {
  fail('CDK_ACCOUNT must be a 12-digit AWS account ID');
}
if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(region)) {
  fail('CDK_WORKLOAD_REGION must be a valid AWS region');
}
function isDnsName(value) {
  return (
    value.length <= 253 &&
    value.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  );
}

if (!isDnsName(domain)) {
  fail('CDK_DOMAIN must be a valid DNS name');
}
if (!/^Z[A-Z0-9]+$/.test(hostedZoneId)) {
  fail('CDK_HOSTED_ZONE_ID must be a valid Route 53 hosted zone ID');
}
if (!isDnsName(hostedZoneName)) {
  fail('CDK_HOSTED_ZONE_NAME must be a valid DNS name');
}
if (domain !== hostedZoneName && !domain.endsWith(`.${hostedZoneName}`)) {
  fail('CDK_DOMAIN must be within CDK_HOSTED_ZONE_NAME');
}

const budgetLimitUsd = optionalPositiveNumber('CDK_BUDGET_LIMIT_USD');
const budgetNotificationEmail = process.env.CDK_BUDGET_NOTIFICATION_EMAIL?.trim();
if ((budgetLimitUsd === undefined) !== !budgetNotificationEmail) {
  fail('CDK_BUDGET_LIMIT_USD and CDK_BUDGET_NOTIFICATION_EMAIL must be set together');
}
if (budgetNotificationEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(budgetNotificationEmail)) {
  fail('CDK_BUDGET_NOTIFICATION_EMAIL must be a valid email address');
}

const mcpReservedConcurrency = optionalPositiveNumber('CDK_MCP_RESERVED_CONCURRENCY', true);
const ingestionReservedConcurrency = optionalPositiveNumber(
  'CDK_INGESTION_RESERVED_CONCURRENCY',
  true
);
const wafRateLimit = optionalPositiveNumber('CDK_WAF_RATE_LIMIT', true);
const config = {
  account,
  region,
  domain,
  hostedZoneId,
  hostedZoneName,
  ...(budgetLimitUsd === undefined ? {} : { budgetLimitUsd, budgetNotificationEmail }),
  ...(mcpReservedConcurrency === undefined ? {} : { mcpReservedConcurrency }),
  ...(ingestionReservedConcurrency === undefined ? {} : { ingestionReservedConcurrency }),
  ...(wafRateLimit === undefined ? {} : { wafRateLimit })
};

await writeFile(outputPath, `${JSON.stringify({ [environment]: config }, null, 2)}\n`, {
  mode: 0o600
});
await chmod(outputPath, 0o600);
console.log(`Wrote validated CDK context for ${environment}.`);
