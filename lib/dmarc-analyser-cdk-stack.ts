import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as events from 'aws-cdk-lib/aws-events';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import { ApiGatewayToLambda } from '@aws-solutions-constructs/aws-apigateway-lambda';
import { EventbridgeToLambda } from '@aws-solutions-constructs/aws-eventbridge-lambda';
import { Construct } from 'constructs';

export class DmarcAnalyserCdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const domainName = process.env.DOMAIN_NAME ?? 'api.dmarc.dylanw.dev';

    new acm.Certificate(this, 'ApiCertificate', {
      domainName,
      validation: acm.CertificateValidation.fromDns(),
    });

    new kms.Key(this, 'EmailCredentialsKey', {
      description: 'Key for encrypting email account credentials',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    new dynamodb.Table(this, 'ReportsTable', {
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

    new EventbridgeToLambda(this, 'CronLambda', {
      lambdaFunctionProps: {
        runtime: lambda.Runtime.PYTHON_3_13,
        handler: 'index.handler',
        code: lambda.Code.fromBucket(artifactsBucket, 'dmarc-analyser-cron/email_scrape_cron/function.zip'),
      },
      eventRuleProps: {
        schedule: events.Schedule.rate(cdk.Duration.hours(1)),
      },
    });

    const s3PutHandlerFn = new lambda.Function(this, 'S3PutHandlerLambda', {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'index.handler',
      code: lambda.Code.fromBucket(artifactsBucket, 'dmarc-analyser-cron/s3_put_handler/function.zip'),
    });

    rawReportsBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(s3PutHandlerFn),
    );

    new ApiGatewayToLambda(this, 'ApiLambda', {
      lambdaFunctionProps: {
        runtime: lambda.Runtime.PYTHON_3_13,
        handler: 'dmarc_analyser_api.main.handler',
        code: lambda.Code.fromBucket(artifactsBucket, 'dmarc-analyser-api/function.zip'),
      },
      apiGatewayProps: {
        defaultMethodOptions: {
          authorizationType: apigw.AuthorizationType.NONE,
        },
      },
    });
  }
}
