import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';
import * as path from 'path';

interface SmithyMcpServerStackProps extends cdk.StackProps {
  bucket: s3.IBucket;
  knowledgeBaseId: string;
  domainName: string;
  hostedZone: route53.IHostedZone;
}

export class SmithyMcpServerStack extends cdk.Stack {
  public readonly functionUrl: string;
  public readonly websiteBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: SmithyMcpServerStackProps) {
    super(scope, id, props);

    this.websiteBucket = new s3.Bucket(this, 'WebsiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const webAdapterLayer = lambda.LayerVersion.fromLayerVersionArn(
      this,
      'LambdaAdapterLayer',
      `arn:aws:lambda:${this.region}:753240598075:layer:LambdaAdapterLayerArm64:25`
    );

    const mcpFunction = new lambdaNodejs.NodejsFunction(this, 'McpServerFunction', {
      entry: path.join(__dirname, '../../functions/src/mcp-server/index.ts'),
      handler: 'run.sh',
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      layers: [webAdapterLayer],
      environment: {
        KNOWLEDGE_BASE_ID: props.knowledgeBaseId,
        BUCKET_NAME: props.bucket.bucketName,
        NODE_ENV: 'production',
        PORT: '8080',
        AWS_LAMBDA_EXEC_WRAPPER: '/opt/bootstrap',
      },
      bundling: {
        minify: false,
        sourceMap: true,
        externalModules: ['@aws-sdk/*'],
        format: lambdaNodejs.OutputFormat.ESM,
        banner: "import { createRequire } from 'module';const require = createRequire(import.meta.url);",
        commandHooks: {
          beforeBundling: () => [],
          afterBundling: (inputDir: string, outputDir: string) => [
            `cp ${path.join(__dirname, '../../functions/src/mcp-server/run.sh')} ${outputDir}/run.sh`,
            `chmod +x ${outputDir}/run.sh`,
          ],
          beforeInstall: () => [],
        },
      },
    });

    props.bucket.grantRead(mcpFunction);

    mcpFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['bedrock:Retrieve', 'bedrock:RetrieveAndGenerate'],
      resources: [`arn:aws:bedrock:${this.region}:${this.account}:knowledge-base/${props.knowledgeBaseId}`]
    }));

    mcpFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['bedrock:InvokeModel'],
      resources: [`arn:aws:bedrock:${this.region}::foundation-model/amazon.titan-embed-text-v2:0`]
    }));

    const functionUrl = mcpFunction.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      invokeMode: lambda.InvokeMode.BUFFERED,
      cors: {
        allowedOrigins: ['*'],
        allowedMethods: [lambda.HttpMethod.ALL],
        allowedHeaders: ['*']
      }
    });

    this.functionUrl = functionUrl.url;

    const certificate = new acm.Certificate(this, 'Certificate', {
      domainName: props.domainName,
      subjectAlternativeNames: [`*.${props.domainName}`],
      validation: acm.CertificateValidation.fromDns(props.hostedZone),
    });

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.websiteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      additionalBehaviors: {
        '/mcp*': {
          origin: new origins.HttpOrigin(cdk.Fn.select(2, cdk.Fn.split('/', this.functionUrl))),
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
      },
      defaultRootObject: 'index.html',
      domainNames: [props.domainName],
      certificate: certificate,
    });

    new s3deploy.BucketDeployment(this, 'WebsiteDeployment', {
      sources: [s3deploy.Source.asset(path.join(__dirname, '../src'))],
      destinationBucket: this.websiteBucket,
      distribution,
      distributionPaths: ['/*'],
    });

    new cdk.CfnOutput(this, 'CustomDomainUrl', {
      value: `https://${props.domainName}`,
      description: 'Custom domain URL',
    });

    new cdk.CfnOutput(this, 'McpServerUrl', {
      value: `https://${props.domainName}/mcp`,
      description: 'MCP Server URL',
    });

    new cdk.CfnOutput(this, 'WebsiteBucketName', {
      value: this.websiteBucket.bucketName,
      description: 'Website S3 bucket name',
    });

    new cdk.CfnOutput(this, 'CloudFrontDistributionId', {
      value: distribution.distributionId,
      description: 'CloudFront distribution ID',
    });

    new cdk.CfnOutput(this, 'FunctionUrl', {
      value: this.functionUrl,
      description: 'Lambda Function URL (direct)',
    });

    new cdk.CfnOutput(this, 'FunctionName', {
      value: mcpFunction.functionName,
      description: 'Lambda function name'
    });
  }
}
