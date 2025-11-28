import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import { Construct } from 'constructs';

export class SmithyKnowledgeBaseStack extends cdk.Stack {
  public readonly bucket: s3.IBucket;
  //public readonly knowledgeBaseId: string;

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

    // const kbRole = new iam.Role(this, 'KnowledgeBaseRole', {
    //   assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com'),
    //   description: 'Role for Bedrock Knowledge Base to access S3'
    // });

    // this.bucket.grantRead(kbRole);
    // kbRole.addToPolicy(new iam.PolicyStatement({
    //   effect: iam.Effect.ALLOW,
    //   actions: ['bedrock:InvokeModel'],
    //   resources: [`arn:aws:bedrock:${this.region}::foundation-model/amazon.titan-embed-text-v2:0`]
    // }));

    // // S3 Vector bucket for embeddings storage
    // const vectorBucket = new s3.Bucket(this, 'SmithyVectorBucket', {
    //   bucketName: `smithy-vectors-${this.account}-${this.region}`,
    //   versioned: false,
    //   encryption: s3.BucketEncryption.S3_MANAGED,
    //   blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    //   removalPolicy: cdk.RemovalPolicy.DESTROY,
    //   autoDeleteObjects: true
    // });

    // vectorBucket.grantReadWrite(kbRole);

    // const knowledgeBase = new bedrock.CfnKnowledgeBase(this, 'SmithyKnowledgeBase', {
    //   name: 'smithy-docs-kb',
    //   description: 'Smithy CLI Documentation Knowledge Base',
    //   roleArn: kbRole.roleArn,
    //   knowledgeBaseConfiguration: {
    //     type: 'VECTOR',
    //     vectorKnowledgeBaseConfiguration: {
    //       embeddingModelArn: `arn:aws:bedrock:${this.region}::foundation-model/amazon.titan-embed-text-v2:0`
    //     }
    //   },
    //   storageConfiguration: {
    //     type: 'S3_VECTORS',
    //     s3VectorsConfiguration: {
    //       vectorBucketArn: vectorBucket.bucketArn
    //     }
    //   } as any // S3 Vectors is in preview, types not yet available
    // });

    // new bedrock.CfnDataSource(this, 'SmithyDocsDataSource', {
    //   knowledgeBaseId: knowledgeBase.attrKnowledgeBaseId,
    //   name: 'smithy-docs-s3-source',
    //   dataSourceConfiguration: {
    //     type: 'S3',
    //     s3Configuration: {
    //       bucketArn: this.bucket.bucketArn,
    //       inclusionPrefixes: ['smithy-docs/']
    //     }
    //   }
    // });

    // this.knowledgeBaseId = knowledgeBase.attrKnowledgeBaseId;

    new cdk.CfnOutput(this, 'BucketName', {
      value: this.bucket.bucketName,
      description: 'S3 bucket for Smithy documentation',
      exportName: 'SmithyDocsBucketName'
    });

    // new cdk.CfnOutput(this, 'KnowledgeBaseId', {
    //   value: this.knowledgeBaseId,
    //   description: 'Bedrock Knowledge Base ID',
    //   exportName: 'SmithyKnowledgeBaseId'
    // });
  }
}
