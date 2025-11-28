import * as cdk from 'aws-cdk-lib';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';

interface SmithyDnsStackProps extends cdk.StackProps {
  domainName: string;
}

export class SmithyDnsStack extends cdk.Stack {
  public readonly hostedZone: route53.IHostedZone;

  constructor(scope: Construct, id: string, props: SmithyDnsStackProps) {
    super(scope, id, props);

    this.hostedZone = new route53.PublicHostedZone(this, 'HostedZone', {
      zoneName: props.domainName,
    });

    new cdk.CfnOutput(this, 'HostedZoneId', {
      value: this.hostedZone.hostedZoneId,
      description: 'Route53 Hosted Zone ID',
    });
  }
}
