import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as events from 'aws-cdk-lib/aws-events';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import { ApiGatewayToLambda } from '@aws-solutions-constructs/aws-apigateway-lambda';
import { EventbridgeToLambda } from '@aws-solutions-constructs/aws-eventbridge-lambda';
import { Construct } from 'constructs';
import { GitLabAuthorizer } from './gitlab-authorizer';

export class DmarcAnalyserCdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const domainName = process.env.DOMAIN_NAME ?? 'api.dmarc.dylanw.net';
    const vaultServerAccountId = '197315783321';

    const hostedZone = new route53.HostedZone(this, 'HostedZone', {
      zoneName: 'dmarc.dylanw.net',
    });

    new route53.CaaRecord(this, 'AcmCaaRecord', {
      zone: hostedZone,
      values: [
        { flag: 0, tag: route53.CaaTag.ISSUE, value: 'amazon.com' },
        { flag: 0, tag: route53.CaaTag.ISSUE, value: 'amazontrust.com' },
        { flag: 0, tag: route53.CaaTag.ISSUE, value: 'awstrust.com' },
        { flag: 0, tag: route53.CaaTag.ISSUE, value: 'amazonaws.com' },
      ],
    });

    new cdk.CfnOutput(this, 'HostedZoneNameServers', {
      description: 'NS records to add to dylanw.net to delegate dmarc.dylanw.net to Route 53',
      value: cdk.Fn.join(', ', hostedZone.hostedZoneNameServers!),
    });

    const certificate = new acm.Certificate(this, 'ApiCertificate', {
      domainName,
      validation: acm.CertificateValidation.fromDns(hostedZone),
    });

    const verificationRole = new iam.Role(this, 'VaultVerificationRole', {
      assumedBy: new iam.AccountPrincipal(vaultServerAccountId),
    });

    verificationRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'iam:GetRole',
        'iam:GetUser',
      ],
      resources: ['*'],
    }));

    const reportsTable = new dynamodb.Table(this, 'ReportsTable', {
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const artifactsBucket = new s3.Bucket(this, 'ArtifactsBucket', {
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [{
        noncurrentVersionExpiration: cdk.Duration.days(1),
        noncurrentVersionsToRetain: 5,
      }],
    });

    new cdk.CfnOutput(this, 'ArtifactsBucketName', {
      value: artifactsBucket.bucketName,
    });

    const rawReportsBucket = new s3.Bucket(this, 'RawReportsBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const eventbridgeToLambda = new EventbridgeToLambda(this, 'Cron', {
      lambdaFunctionProps: {
        runtime: lambda.Runtime.PYTHON_3_13,
        handler: 'main.handler',
        code: lambda.Code.fromBucket(
          artifactsBucket,
          'dmarc-analyser-cron/email_scrape_cron/function.zip',
          ssm.StringParameter.valueForStringParameter(this, '/dmarc-analyser/artifacts/cron/email_scrape_cron/version'),
        ),
        timeout: cdk.Duration.minutes(1),
        environment: {
          S3_BUCKET: rawReportsBucket.bucketName,
          VAULT_ADDR: process.env.VAULT_ADDR ?? (() => { throw new Error('VAULT_ADDR must be set'); })(),
          VAULT_ROLE: 'dmarc-analyser-cron',
          VAULT_ENGINE_MOUNT_POINT: 'secrets/dmarc-analyser/cron',
        },
      },
      eventRuleProps: {
        schedule: events.Schedule.rate(cdk.Duration.hours(1)),
      },
    });

    rawReportsBucket.grantReadWrite(eventbridgeToLambda.lambdaFunction)

    const s3PutHandlerFn = new lambda.Function(this, 'S3PutHandlerLambda', {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'main.handler',
      code: lambda.Code.fromBucket(
        artifactsBucket,
        'dmarc-analyser-cron/s3_put_handler/function.zip',
        ssm.StringParameter.valueForStringParameter(this, '/dmarc-analyser/artifacts/cron/s3_put_handler/version'),
      ),
      environment: {
        DYNAMODB_TABLE: reportsTable.tableName,
      },
    });

    rawReportsBucket.grantRead(s3PutHandlerFn);
    reportsTable.grantWriteData(s3PutHandlerFn);

    rawReportsBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(s3PutHandlerFn),
    );

    const gitlabUrl = process.env.CI_SERVER_URL ?? process.env.GITLAB_URL;
    if (!gitlabUrl) throw new Error('CI_SERVER_URL (or GITLAB_URL) must be set');

    const { authorizer } = new GitLabAuthorizer(this, 'GitLabAuthorizer', { gitlabUrl });

    const api = new ApiGatewayToLambda(this, 'Api', {
      lambdaFunctionProps: {
        runtime: lambda.Runtime.PYTHON_3_13,
        handler: 'dmarc_analyser_api.main.handler',
        code: lambda.Code.fromBucket(
          artifactsBucket,
          'dmarc-analyser-api/function.zip',
          ssm.StringParameter.valueForStringParameter(this, '/dmarc-analyser/artifacts/api/version'),
        ),
        environment: {
          DYNAMODB_TABLE: reportsTable.tableName,
        },
      },
      apiGatewayProps: {
        defaultMethodOptions: {
          authorizationType: apigw.AuthorizationType.CUSTOM,
          authorizer,
        },
        defaultCorsPreflightOptions: {
          allowOrigins: apigw.Cors.ALL_ORIGINS,
          allowMethods: apigw.Cors.ALL_METHODS,
          allowHeaders: ['Authorization', 'Content-Type'],
        },
      },
    });

    reportsTable.grantReadData(api.lambdaFunction);

    const customDomain = new apigw.DomainName(this, 'ApiDomainName', {
      domainName,
      certificate,
      endpointType: apigw.EndpointType.REGIONAL,
    });

    customDomain.addBasePathMapping(api.apiGateway);

    new route53.ARecord(this, 'ApiAliasRecord', {
      zone: hostedZone,
      recordName: 'api',
      target: route53.RecordTarget.fromAlias(
        new route53Targets.ApiGatewayDomain(customDomain),
      ),
    });

    // Route 53 does not support ALIAS to external hostnames, so we use A/AAAA
    // records pointing to the GitLab Pages server (dmarc-analyser.pages.dylanw.dev).
    new route53.ARecord(this, 'FrontendARecord', {
      zone: hostedZone,
      target: route53.RecordTarget.fromIpAddresses('51.38.73.143'),
    });

    new route53.AaaaRecord(this, 'FrontendAaaaRecord', {
      zone: hostedZone,
      target: route53.RecordTarget.fromIpAddresses('2001:41d0:800:3f6d:d23b:35f2:84ea:9e58'),
    });
  }
}
