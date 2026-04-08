import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as events from 'aws-cdk-lib/aws-events';
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

    const domainName = process.env.DOMAIN_NAME ?? 'api.dmarc.dylanw.dev';
    const vaultServerAccountId = '197315783321';

    new acm.Certificate(this, 'ApiCertificate', {
      domainName,
      validation: acm.CertificateValidation.fromDns(),
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

    const eventbridgeToLambda = new EventbridgeToLambda(this, 'CronLambda', {
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

    const api = new ApiGatewayToLambda(this, 'ApiLambda', {
      lambdaFunctionProps: {
        runtime: lambda.Runtime.PYTHON_3_13,
        handler: 'dmarc_analyser_api.main.handler',
        code: lambda.Code.fromBucket(
          artifactsBucket,
          'dmarc-analyser-api/function.zip',
          ssm.StringParameter.valueForStringParameter(this, '/dmarc-analyser/artifacts/api/version'),
        ),
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
  }
}
