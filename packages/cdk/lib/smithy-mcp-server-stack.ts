import * as path from 'node:path';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cdk from 'aws-cdk-lib';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';

export interface SmithyMcpServerStackProps extends cdk.StackProps {
  stage: string;
  resourcePrefix: string;
  bucket: s3.IBucket;
  knowledgeBaseId: string;
  resourceRegion: string;
  domainName: string;
  hostedZone: route53.IHostedZone;
  mcpReservedConcurrency: number;
  wafRateLimit: number;
}

function repositoryRoot(): string {
  return __dirname.includes(`${path.sep}dist${path.sep}`)
    ? path.resolve(__dirname, '../../../..')
    : path.resolve(__dirname, '../../..');
}

export class SmithyMcpServerStack extends cdk.Stack {
  public readonly websiteBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: SmithyMcpServerStackProps) {
    super(scope, id, props);

    this.websiteBucket = new s3.Bucket(this, 'WebsiteBucket', {
      bucketName: `${props.resourcePrefix}-website-${this.account}-${this.region}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: false
    });

    const mcpLogGroup = new logs.LogGroup(this, 'McpLogGroup', {
      logGroupName: `/aws/lambda/${props.resourcePrefix}-server`,
      retention: logs.RetentionDays.ONE_YEAR,
      removalPolicy: cdk.RemovalPolicy.RETAIN
    });

    const mcpFunction = new lambda.DockerImageFunction(this, 'McpServerFunction', {
      functionName: `${props.resourcePrefix}-server`,
      description: `${props.stage} Smithy MCP server; reachable only through CloudFront`,
      code: lambda.DockerImageCode.fromImageAsset(repositoryRoot(), {
        file: 'packages/cdk/docker/mcp.Dockerfile',
        platform: ecrAssets.Platform.LINUX_AMD64,
        exclude: ['packages/cdk/cdk.out', 'packages/cdk/cdk.out/**']
      }),
      architecture: lambda.Architecture.X86_64,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      reservedConcurrentExecutions: props.mcpReservedConcurrency,
      tracing: lambda.Tracing.ACTIVE,
      logGroup: mcpLogGroup,
      environment: {
        KNOWLEDGE_BASE_ID: props.knowledgeBaseId,
        BUCKET_NAME: props.bucket.bucketName,
        AWS_RESOURCE_REGION: props.resourceRegion,
        MCP_ALLOWED_ORIGINS: `https://${props.domainName}`,
        NODE_ENV: 'production',
        PORT: '8080'
      }
    });

    mcpFunction.addToRolePolicy(new iam.PolicyStatement({
      sid: 'ListPublishedSmithyDocuments',
      actions: ['s3:ListBucket'],
      resources: [props.bucket.bucketArn],
      conditions: { StringLike: { 's3:prefix': ['smithy-docs/*'] } }
    }));
    mcpFunction.addToRolePolicy(new iam.PolicyStatement({
      sid: 'ReadPublishedSmithyDocuments',
      actions: ['s3:GetObject'],
      resources: [props.bucket.arnForObjects('smithy-docs/*')]
    }));
    mcpFunction.addToRolePolicy(new iam.PolicyStatement({
      sid: 'RetrieveFromKnowledgeBaseOnly',
      actions: ['bedrock:Retrieve'],
      resources: [
        cdk.Stack.of(this).formatArn({
          service: 'bedrock',
          region: props.resourceRegion,
          resource: 'knowledge-base',
          resourceName: props.knowledgeBaseId
        })
      ]
    }));

    const functionUrl = mcpFunction.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.AWS_IAM,
      invokeMode: lambda.InvokeMode.BUFFERED
    });
    mcpFunction.addEnvironment('MCP_ALLOWED_HOSTS', props.domainName);

    // Lambda URL OAC requires a payload hash for requests with a body. Compute it
    // at the edge so ordinary MCP clients do not need AWS-specific headers.
    const payloadHashFunction = new lambda.Function(this, 'PayloadHashFunction', {
      functionName: `${props.resourcePrefix}-payload-hash`,
      description: 'Adds the content SHA-256 required for signed Lambda URL POST requests',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.X86_64,
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(5),
      memorySize: 128,
      code: lambda.Code.fromInline(`
        const { createHash } = require('node:crypto');
        exports.handler = async event => {
          const request = event.Records[0].cf.request;
          if (request.body && request.body.data) {
            const encoding = request.body.encoding === 'base64' ? 'base64' : 'utf8';
            const payload = Buffer.from(request.body.data, encoding);
            request.headers['x-amz-content-sha256'] = [{
              key: 'X-Amz-Content-Sha256',
              value: createHash('sha256').update(payload).digest('hex')
            }];
          }
          return request;
        };
      `)
    });
    const payloadHashVersion = payloadHashFunction.currentVersion;

    const certificate = new acm.Certificate(this, 'Certificate', {
      certificateName: `${props.resourcePrefix}-certificate`,
      domainName: props.domainName,
      validation: acm.CertificateValidation.fromDns(props.hostedZone)
    });

    const responseHeadersPolicy = new cloudfront.ResponseHeadersPolicy(
      this,
      'SecurityHeadersPolicy',
      {
        responseHeadersPolicyName: `${props.resourcePrefix}-security-headers`,
        securityHeadersBehavior: {
          contentSecurityPolicy: {
            contentSecurityPolicy: "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'",
            override: true
          },
          contentTypeOptions: { override: true },
          frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
          referrerPolicy: {
            referrerPolicy: cloudfront.HeadersReferrerPolicy.SAME_ORIGIN,
            override: true
          },
          strictTransportSecurity: {
            accessControlMaxAge: cdk.Duration.days(365),
            includeSubdomains: true,
            preload: true,
            override: true
          },
          xssProtection: { protection: true, modeBlock: true, override: true }
        },
        customHeadersBehavior: {
          customHeaders: [{
            header: 'Permissions-Policy',
            value: 'camera=(), geolocation=(), microphone=()',
            override: true
          }]
        }
      }
    );

    const webAcl = new wafv2.CfnWebACL(this, 'WebAcl', {
      name: `${props.resourcePrefix}-cloudfront`,
      description: `${props.stage} MCP edge protections`,
      scope: 'CLOUDFRONT',
      defaultAction: { allow: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: `${props.resourcePrefix}-waf`,
        sampledRequestsEnabled: true
      },
      rules: [
        {
          name: 'RateLimitByIp',
          priority: 0,
          action: { block: {} },
          statement: {
            rateBasedStatement: {
              aggregateKeyType: 'IP',
              evaluationWindowSec: 300,
              limit: props.wafRateLimit
            }
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: `${props.resourcePrefix}-rate-limit`,
            sampledRequestsEnabled: true
          }
        },
        {
          name: 'RejectOversizedBodies',
          priority: 1,
          action: { block: {} },
          statement: {
            sizeConstraintStatement: {
              comparisonOperator: 'GT',
              size: 65_536,
              fieldToMatch: { body: { oversizeHandling: 'MATCH' } },
              textTransformations: [{ priority: 0, type: 'NONE' }]
            }
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: `${props.resourcePrefix}-body-size`,
            sampledRequestsEnabled: true
          }
        }
      ]
    });
    webAcl.addPropertyOverride(
      'AssociationConfig.RequestBody.CLOUDFRONT.DefaultSizeInspectionLimit',
      'KB_64'
    );

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `${props.stage} Smithy MCP distribution`,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.websiteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy
      },
      additionalBehaviors: {
        '/mcp': {
          origin: origins.FunctionUrlOrigin.withOriginAccessControl(functionUrl, {
            readTimeout: cdk.Duration.seconds(30),
            customHeaders: { 'X-Mcp-Forwarded-Host': props.domainName }
          }),
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          responseHeadersPolicy,
          edgeLambdas: [{
            functionVersion: payloadHashVersion,
            eventType: cloudfront.LambdaEdgeEventType.ORIGIN_REQUEST,
            includeBody: true
          }]
        }
      },
      defaultRootObject: 'index.html',
      domainNames: [props.domainName],
      certificate,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      enableIpv6: true,
      webAclId: webAcl.attrArn
    });

    mcpFunction.addPermission('AllowCloudFrontInvokeFunctionUrlTarget', {
      principal: new iam.ServicePrincipal('cloudfront.amazonaws.com'),
      action: 'lambda:InvokeFunction',
      sourceAccount: this.account,
      sourceArn: distribution.distributionArn,
      invokedViaFunctionUrl: true
    });

    new route53.ARecord(this, 'Ipv4AliasRecord', {
      zone: props.hostedZone,
      recordName: props.domainName,
      target: route53.RecordTarget.fromAlias(new route53Targets.CloudFrontTarget(distribution))
    });
    new route53.AaaaRecord(this, 'Ipv6AliasRecord', {
      zone: props.hostedZone,
      recordName: props.domainName,
      target: route53.RecordTarget.fromAlias(new route53Targets.CloudFrontTarget(distribution))
    });

    new s3deploy.BucketDeployment(this, 'WebsiteDeployment', {
      sources: [s3deploy.Source.asset(path.join(repositoryRoot(), 'packages/cdk/src'))],
      destinationBucket: this.websiteBucket,
      distribution,
      distributionPaths: ['/*'],
      prune: true
    });

    const alarmDefaults = {
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING
    };
    new cloudwatch.Alarm(this, 'McpErrorsAlarm', {
      ...alarmDefaults,
      alarmName: `${props.resourcePrefix}-mcp-errors`,
      metric: mcpFunction.metricErrors({ period: cdk.Duration.minutes(5) }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD
    });
    new cloudwatch.Alarm(this, 'McpThrottlesAlarm', {
      ...alarmDefaults,
      alarmName: `${props.resourcePrefix}-mcp-throttles`,
      metric: mcpFunction.metricThrottles({ period: cdk.Duration.minutes(5) }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD
    });
    new cloudwatch.Alarm(this, 'McpDurationAlarm', {
      ...alarmDefaults,
      alarmName: `${props.resourcePrefix}-mcp-duration`,
      metric: mcpFunction.metricDuration({
        period: cdk.Duration.minutes(5),
        statistic: 'p99'
      }),
      threshold: cdk.Duration.seconds(25).toMilliseconds(),
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD
    });

    new cdk.CfnOutput(this, 'Environment', { value: props.stage });
    new cdk.CfnOutput(this, 'CustomDomainUrl', {
      value: `https://${props.domainName}`,
      description: `${props.stage} custom domain URL`
    });
    new cdk.CfnOutput(this, 'McpServerUrl', {
      value: `https://${props.domainName}/mcp`,
      description: 'The only public MCP endpoint'
    });
    new cdk.CfnOutput(this, 'CloudFrontDistributionId', {
      value: distribution.distributionId,
      description: `${props.stage} CloudFront distribution ID`
    });
    new cdk.CfnOutput(this, 'FunctionName', {
      value: mcpFunction.functionName,
      description: `${props.stage} MCP Lambda function name`
    });
  }
}
