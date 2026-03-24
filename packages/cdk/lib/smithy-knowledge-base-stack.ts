import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import * as s3vectors from 'aws-cdk-lib/aws-s3vectors';
import { Construct } from 'constructs';

export class SmithyKnowledgeBaseStack extends cdk.Stack {
  public readonly bucket: s3.IBucket;
  public readonly knowledgeBaseId: string;
  public readonly dataSourceId: string;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.bucket = new s3.Bucket(this, 'SmithyDocsBucket', {
      bucketName: `smithy-docs-${this.account}-${this.region}`,
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: false
    });

    const kbRole = new iam.Role(this, 'KnowledgeBaseRole', {
      assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com'),
      description: 'Role for Bedrock Knowledge Base to access S3 and S3 Vectors'
    });

    this.bucket.grantRead(kbRole);
    kbRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['bedrock:InvokeModel'],
      resources: [`arn:aws:bedrock:${this.region}::foundation-model/amazon.titan-embed-text-v2:0`]
    }));

    // S3 Vector bucket for embeddings storage
    const vectorBucket = new s3vectors.CfnVectorBucket(this, 'SmithyVectorBucket', {
      vectorBucketName: `smithy-vectors-${this.account}-${this.region}`,
    });

    kbRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        's3vectors:CreateVectorBucket',
        's3vectors:GetVectorBucket',
        's3vectors:PutVectors',
        's3vectors:GetVectors',
        's3vectors:DeleteVectors',
        's3vectors:QueryVectors',
        's3vectors:ListVectors',
      ],
      resources: [vectorBucket.attrVectorBucketArn, `${vectorBucket.attrVectorBucketArn}/*`]
    }));

    const knowledgeBase = new bedrock.CfnKnowledgeBase(this, 'SmithyKnowledgeBase', {
      name: 'smithy-docs-kb',
      description: 'Smithy CLI Documentation Knowledge Base',
      roleArn: kbRole.roleArn,
      knowledgeBaseConfiguration: {
        type: 'VECTOR',
        vectorKnowledgeBaseConfiguration: {
          embeddingModelArn: `arn:aws:bedrock:${this.region}::foundation-model/amazon.titan-embed-text-v2:0`
        }
      },
      storageConfiguration: {
        type: 'S3_VECTORS',
        s3VectorsConfiguration: {
          vectorBucketArn: vectorBucket.attrVectorBucketArn,
        }
      }
    });
    knowledgeBase.addDependency(vectorBucket);

    const dataSource = new bedrock.CfnDataSource(this, 'SmithyDocsDataSource', {
      knowledgeBaseId: knowledgeBase.attrKnowledgeBaseId,
      name: 'smithy-docs-s3-source',
      dataSourceConfiguration: {
        type: 'S3',
        s3Configuration: {
          bucketArn: this.bucket.bucketArn,
          inclusionPrefixes: ['smithy-docs/']
        }
      }
    });

    this.knowledgeBaseId = knowledgeBase.attrKnowledgeBaseId;
    this.dataSourceId = dataSource.attrDataSourceId;

    new cdk.CfnOutput(this, 'BucketName', {
      value: this.bucket.bucketName,
      description: 'S3 bucket for Smithy documentation',
      exportName: 'SmithyDocsBucketName'
    });

    new cdk.CfnOutput(this, 'KnowledgeBaseId', {
      value: this.knowledgeBaseId,
      description: 'Bedrock Knowledge Base ID',
      exportName: 'SmithyKnowledgeBaseId'
    });

    new cdk.CfnOutput(this, 'DataSourceId', {
      value: this.dataSourceId,
      description: 'Bedrock Data Source ID',
      exportName: 'SmithyDataSourceId'
    });

    new cdk.CfnOutput(this, 'VectorBucketArn', {
      value: vectorBucket.attrVectorBucketArn,
      description: 'S3 Vectors bucket ARN',
      exportName: 'SmithyVectorBucketArn'
    });
  }
}
