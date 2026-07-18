import * as path from 'node:path';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cdk from 'aws-cdk-lib';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as destinations from 'aws-cdk-lib/aws-lambda-destinations';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3vectors from 'aws-cdk-lib/aws-s3vectors';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { type Construct } from 'constructs';

const DOCUMENT_PREFIX = 'smithy-docs/';
const STATE_PREFIX = 'smithy-mcp-state/';
const STAGING_PREFIX = 'smithy-mcp-staging/';
const EMBEDDING_MODEL_ID = 'amazon.titan-embed-text-v2:0';
const EMBEDDING_DIMENSIONS = 1024;

export interface SmithyKnowledgeBaseStackProps extends cdk.StackProps {
  stage: string;
  resourcePrefix: string;
  budgetLimitUsd?: number;
  budgetNotificationEmail?: string;
  ingestionReservedConcurrency: number;
}

function repositoryRoot(): string {
  const fromSource = path.resolve(__dirname, '../../..');
  return __dirname.includes(`${path.sep}dist${path.sep}`)
    ? path.resolve(__dirname, '../../../..')
    : fromSource;
}

export class SmithyKnowledgeBaseStack extends cdk.Stack {
  public readonly bucket: s3.IBucket;
  public readonly knowledgeBaseId: string;
  public readonly dataSourceId: string;
  public readonly ingestionFunction: lambda.DockerImageFunction;

  constructor(scope: Construct, id: string, props: SmithyKnowledgeBaseStackProps) {
    super(scope, id, props);

    const embeddingModelArn = cdk.Stack.of(this).formatArn({
      service: 'bedrock',
      account: '',
      resource: 'foundation-model',
      resourceName: EMBEDDING_MODEL_ID
    });

    this.bucket = new s3.Bucket(this, 'SmithyDocsBucket', {
      bucketName: `${props.resourcePrefix}-docs-${this.account}-${this.region}`,
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
      lifecycleRules: [
        {
          id: 'ExpireOrphanedStagingObjects',
          prefix: STAGING_PREFIX,
          expiration: cdk.Duration.days(2),
          noncurrentVersionExpiration: cdk.Duration.days(2),
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(2)
        }
      ]
    });

    const vectorBucket = new s3vectors.CfnVectorBucket(this, 'SmithyVectorBucket', {
      vectorBucketName: `${props.resourcePrefix}-vectors-${this.account}-${this.region}`,
      encryptionConfiguration: { sseType: 'AES256' },
      tags: [{ key: 'Environment', value: props.stage }]
    });
    vectorBucket.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

    const vectorIndex = new s3vectors.CfnIndex(this, 'SmithyVectorIndex', {
      vectorBucketArn: vectorBucket.attrVectorBucketArn,
      indexName: `${props.resourcePrefix}-index`,
      dataType: 'float32',
      dimension: EMBEDDING_DIMENSIONS,
      distanceMetric: 'cosine',
      tags: [{ key: 'Environment', value: props.stage }]
    });
    vectorIndex.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
    vectorIndex.addDependency(vectorBucket);

    const knowledgeBaseRole = new iam.Role(this, 'KnowledgeBaseRole', {
      roleName: `${props.resourcePrefix}-bedrock-kb`,
      assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com').withConditions({
        StringEquals: { 'aws:SourceAccount': this.account },
        ArnLike: {
          'AWS:SourceArn': cdk.Stack.of(this).formatArn({
            service: 'bedrock',
            resource: 'knowledge-base',
            resourceName: '*'
          })
        }
      }),
      description: `${props.stage} Bedrock knowledge base access to Smithy documents and vectors`
    });
    knowledgeBaseRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadPublishedSmithyDocuments',
        actions: ['s3:GetObject'],
        resources: [this.bucket.arnForObjects(`${DOCUMENT_PREFIX}*`)]
      })
    );
    knowledgeBaseRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ListPublishedSmithyDocuments',
        actions: ['s3:ListBucket'],
        resources: [this.bucket.bucketArn],
        conditions: { StringLike: { 's3:prefix': [`${DOCUMENT_PREFIX}*`] } }
      })
    );
    knowledgeBaseRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'CreateEmbeddings',
        actions: ['bedrock:InvokeModel'],
        resources: [embeddingModelArn]
      })
    );
    knowledgeBaseRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'InspectSmithyVectorBucket',
        actions: ['s3vectors:GetVectorBucket'],
        resources: [vectorBucket.attrVectorBucketArn]
      })
    );
    knowledgeBaseRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'UseSmithyVectorIndex',
        actions: [
          's3vectors:GetIndex',
          's3vectors:QueryVectors',
          's3vectors:PutVectors',
          's3vectors:GetVectors',
          's3vectors:DeleteVectors'
        ],
        resources: [vectorIndex.attrIndexArn]
      })
    );

    const knowledgeBase = new bedrock.CfnKnowledgeBase(this, 'SmithyKnowledgeBase', {
      name: `${props.resourcePrefix}-kb`,
      description: `${props.stage} Smithy documentation knowledge base`,
      roleArn: knowledgeBaseRole.roleArn,
      knowledgeBaseConfiguration: {
        type: 'VECTOR',
        vectorKnowledgeBaseConfiguration: {
          embeddingModelArn,
          embeddingModelConfiguration: {
            bedrockEmbeddingModelConfiguration: { dimensions: EMBEDDING_DIMENSIONS }
          }
        }
      },
      storageConfiguration: {
        type: 'S3_VECTORS',
        s3VectorsConfiguration: {
          // CloudFormation's S3VectorsConfiguration schema is a oneOf: either
          // IndexArn alone, or VectorBucketArn + IndexName together. Supplying
          // all three matches both subschemas and fails "early validation"
          // with "2 subschemas matched instead of one". IndexArn alone
          // uniquely identifies the index, so it is sufficient here.
          indexArn: vectorIndex.attrIndexArn
        }
      },
      tags: { Environment: props.stage, Application: 'smithy-mcp' }
    });
    knowledgeBase.node.addDependency(knowledgeBaseRole, vectorIndex);

    const dataSource = new bedrock.CfnDataSource(this, 'SmithyDocsDataSource', {
      knowledgeBaseId: knowledgeBase.attrKnowledgeBaseId,
      name: `${props.resourcePrefix}-s3-source`,
      description: `${props.stage} published Smithy Markdown documents`,
      dataSourceConfiguration: {
        type: 'S3',
        s3Configuration: {
          bucketArn: this.bucket.bucketArn,
          inclusionPrefixes: [DOCUMENT_PREFIX]
        }
      },
      vectorIngestionConfiguration: {
        chunkingConfiguration: {
          chunkingStrategy: 'FIXED_SIZE',
          fixedSizeChunkingConfiguration: {
            maxTokens: 300,
            overlapPercentage: 20
          }
        }
      }
    });
    dataSource.addDependency(knowledgeBase);

    this.knowledgeBaseId = knowledgeBase.attrKnowledgeBaseId;
    this.dataSourceId = dataSource.attrDataSourceId;

    const ingestionLogGroup = new logs.LogGroup(this, 'IngestionLogGroup', {
      logGroupName: `/aws/lambda/${props.resourcePrefix}-ingestion`,
      retention: logs.RetentionDays.ONE_YEAR,
      removalPolicy: cdk.RemovalPolicy.RETAIN
    });

    this.ingestionFunction = new lambda.DockerImageFunction(this, 'IngestionFunction', {
      functionName: `${props.resourcePrefix}-ingestion`,
      description: `Publishes and synchronizes Smithy documentation for ${props.stage}`,
      code: lambda.DockerImageCode.fromImageAsset(repositoryRoot(), {
        file: 'packages/ingestion/Dockerfile',
        platform: ecrAssets.Platform.LINUX_AMD64,
        exclude: ['packages/cdk/cdk.out', 'packages/cdk/cdk.out/**']
      }),
      architecture: lambda.Architecture.X86_64,
      timeout: cdk.Duration.minutes(15),
      memorySize: 2048,
      ephemeralStorageSize: cdk.Size.gibibytes(4),
      reservedConcurrentExecutions: props.ingestionReservedConcurrency,
      tracing: lambda.Tracing.ACTIVE,
      logGroup: ingestionLogGroup,
      environment: {
        BUCKET_NAME: this.bucket.bucketName,
        KNOWLEDGE_BASE_ID: this.knowledgeBaseId,
        DATA_SOURCE_ID: this.dataSourceId,
        DOCS_PREFIX: DOCUMENT_PREFIX,
        SOURCE_REPOSITORY: 'https://github.com/smithy-lang/smithy.git',
        SOURCE_REF: 'main',
        FORCE_REFRESH: 'false',
        COMMAND_TIMEOUT_MS: '120000',
        COMMAND_MAX_OUTPUT_BYTES: String(16 * 1024 * 1024),
        CONVERSION_CONCURRENCY: '4',
        S3_CONCURRENCY: '8',
        INGESTION_POLL_INTERVAL_MS: '5000',
        INGESTION_POLL_MAX_INTERVAL_MS: '30000',
        INGESTION_TIMEOUT_MS: String(13 * 60 * 1000)
      }
    });

    this.ingestionFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'ListIngestionNamespaces',
        actions: ['s3:ListBucket'],
        resources: [this.bucket.bucketArn],
        conditions: {
          StringLike: {
            's3:prefix': [`${DOCUMENT_PREFIX}*`, `${STATE_PREFIX}*`, `${STAGING_PREFIX}*`]
          }
        }
      })
    );
    this.ingestionFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'PublishSmithyDocuments',
        actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
        resources: [
          this.bucket.arnForObjects(`${DOCUMENT_PREFIX}*`),
          this.bucket.arnForObjects(`${STATE_PREFIX}*`),
          this.bucket.arnForObjects(`${STAGING_PREFIX}*`)
        ]
      })
    );
    this.ingestionFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'SynchronizeKnowledgeBase',
        actions: ['bedrock:StartIngestionJob', 'bedrock:GetIngestionJob'],
        resources: [knowledgeBase.attrKnowledgeBaseArn]
      })
    );

    const ingestionDeadLetterQueue = new sqs.Queue(this, 'IngestionDeadLetterQueue', {
      queueName: `${props.resourcePrefix}-ingestion-dlq`,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: cdk.Duration.days(14)
    });

    ingestionDeadLetterQueue.grantSendMessages(this.ingestionFunction);
    this.ingestionFunction.configureAsyncInvoke({
      onFailure: new destinations.SqsDestination(ingestionDeadLetterQueue),
      retryAttempts: 2,
      maxEventAge: cdk.Duration.hours(2)
    });

    const schedule = new events.Rule(this, 'WeeklyIngestionSchedule', {
      ruleName: `${props.resourcePrefix}-monday-ingestion`,
      description: `Refresh ${props.stage} Smithy documentation every Monday at 06:00 UTC`,
      schedule: events.Schedule.cron({ minute: '0', hour: '6', weekDay: 'MON' })
    });
    schedule.addTarget(
      new targets.LambdaFunction(this.ingestionFunction, {
        deadLetterQueue: ingestionDeadLetterQueue,
        retryAttempts: 2,
        maxEventAge: cdk.Duration.hours(2)
      })
    );

    const alarmDefaults = {
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING
    };
    new cloudwatch.Alarm(this, 'IngestionErrorsAlarm', {
      ...alarmDefaults,
      alarmName: `${props.resourcePrefix}-ingestion-errors`,
      metric: this.ingestionFunction.metricErrors({ period: cdk.Duration.minutes(5) }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD
    });
    new cloudwatch.Alarm(this, 'IngestionDurationAlarm', {
      ...alarmDefaults,
      alarmName: `${props.resourcePrefix}-ingestion-duration`,
      metric: this.ingestionFunction.metricDuration({
        period: cdk.Duration.minutes(5),
        statistic: 'Maximum'
      }),
      threshold: cdk.Duration.minutes(14).toMilliseconds(),
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD
    });
    new cloudwatch.Alarm(this, 'IngestionDlqAlarm', {
      ...alarmDefaults,
      alarmName: `${props.resourcePrefix}-ingestion-dlq-visible`,
      metric: ingestionDeadLetterQueue.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(5)
      }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD
    });

    if (props.budgetLimitUsd !== undefined && props.budgetNotificationEmail !== undefined) {
      const subscribers = [
        {
          subscriptionType: 'EMAIL',
          address: props.budgetNotificationEmail
        }
      ];
      new budgets.CfnBudget(this, 'EnvironmentBudget', {
        budget: {
          budgetName: `${props.resourcePrefix}-monthly`,
          budgetType: 'COST',
          timeUnit: 'MONTHLY',
          budgetLimit: { amount: props.budgetLimitUsd, unit: 'USD' },
          costFilters: { TagKeyValue: [`user:Environment$${props.stage}`] }
        },
        notificationsWithSubscribers: [
          {
            notification: {
              comparisonOperator: 'GREATER_THAN',
              notificationType: 'FORECASTED',
              threshold: 80,
              thresholdType: 'PERCENTAGE'
            },
            subscribers
          }
        ]
      });
    }

    new cdk.CfnOutput(this, 'Environment', { value: props.stage });
    new cdk.CfnOutput(this, 'BucketName', {
      value: this.bucket.bucketName,
      description: `${props.stage} Smithy documentation bucket`
    });
    new cdk.CfnOutput(this, 'VectorBucketArn', {
      value: vectorBucket.attrVectorBucketArn,
      description: `${props.stage} S3 vector bucket ARN`
    });
    new cdk.CfnOutput(this, 'VectorIndexArn', {
      value: vectorIndex.attrIndexArn,
      description: `${props.stage} S3 vector index ARN`
    });
    new cdk.CfnOutput(this, 'KnowledgeBaseId', {
      value: this.knowledgeBaseId,
      description: `${props.stage} Bedrock knowledge base ID`
    });
    new cdk.CfnOutput(this, 'DataSourceId', {
      value: this.dataSourceId,
      description: `${props.stage} Bedrock data source ID`
    });
    new cdk.CfnOutput(this, 'IngestionFunctionName', {
      value: this.ingestionFunction.functionName,
      description: 'Scheduled ingestion Lambda function name'
    });
    new cdk.CfnOutput(this, 'InitialIngestionCommand', {
      value: `aws lambda invoke --region ${this.region} --function-name ${this.ingestionFunction.functionName} --invocation-type Event --cli-binary-format raw-in-base64-out --payload '{}' initial-ingestion.json`,
      description: 'Safe explicit first ingestion after the stack reaches CREATE_COMPLETE'
    });
    new cdk.CfnOutput(this, 'IngestionSchedule', {
      value: 'cron(0 6 ? * MON *)',
      description: 'Weekly ingestion schedule in UTC'
    });
  }
}
