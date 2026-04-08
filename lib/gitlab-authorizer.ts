import * as cdk from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

export interface GitLabAuthorizerProps {
  gitlabUrl: string;
  resultsCacheTtl?: cdk.Duration;
}

export class GitLabAuthorizer extends Construct {
  public readonly authorizer: apigw.TokenAuthorizer;

  constructor(scope: Construct, id: string, props: GitLabAuthorizerProps) {
    super(scope, id);

    const fn = new lambda.Function(this, 'Function', {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
import json
import os
import urllib.request
import urllib.error

GITLAB_URL = os.environ['GITLAB_URL']

def handler(event, context):
    token = event.get('authorizationToken', '')
    if token.lower().startswith('bearer '):
        token = token[7:]
    arn = event['methodArn']
    try:
        req = urllib.request.Request(
            f'{GITLAB_URL}/oauth/userinfo',
            headers={'Authorization': f'Bearer {token}'}
        )
        with urllib.request.urlopen(req) as r:
            principal = json.loads(r.read()).get('sub', 'user')
        effect = 'Allow'
    except Exception:
        principal = 'unauthorized'
        effect = 'Deny'
    return {
        'principalId': principal,
        'policyDocument': {
            'Version': '2012-10-17',
            'Statement': [{'Action': 'execute-api:Invoke', 'Effect': effect, 'Resource': arn}]
        },
        'context': {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Authorization,Content-Type',
        }
    }
`),
      environment: {
        GITLAB_URL: props.gitlabUrl,
      },
    });

    this.authorizer = new apigw.TokenAuthorizer(this, 'Authorizer', {
      handler: fn,
      resultsCacheTtl: props.resultsCacheTtl ?? cdk.Duration.minutes(5),
    });
  }
}
