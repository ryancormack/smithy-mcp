import * as cdk from 'aws-cdk-lib';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';

export interface SmithyDnsStackProps extends cdk.StackProps {
  stage: string;
  resourcePrefix: string;
  domainName: string;
  hostedZoneId: string;
  hostedZoneName: string;
}

export class SmithyDnsStack extends cdk.Stack {
  public readonly hostedZone: route53.IHostedZone;

  constructor(scope: Construct, id: string, props: SmithyDnsStackProps) {
    super(scope, id, props);

    this.hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
      hostedZoneId: props.hostedZoneId,
      zoneName: props.hostedZoneName
    });

    new cdk.CfnOutput(this, 'Environment', {
      value: props.stage,
      description: 'Deployment environment'
    });
    new cdk.CfnOutput(this, 'DomainName', {
      value: props.domainName,
      description: 'Environment-specific application domain'
    });
    new cdk.CfnOutput(this, 'HostedZoneId', {
      value: this.hostedZone.hostedZoneId,
      description: 'Imported Route53 hosted zone ID'
    });
    new cdk.CfnOutput(this, 'HostedZoneName', {
      value: this.hostedZone.zoneName,
      description: 'Imported Route53 hosted zone name'
    });
  }
}
