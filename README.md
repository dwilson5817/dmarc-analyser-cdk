![DMARC Analyser logo](https://gitlab.dylanw.dev/uploads/-/system/group/avatar/14/dmarc-analyser-256px.png?width=96)

# DMARC Analyser CDK

[![Pipeline status](https://gitlab.dylanw.dev/dmarc-analyser/cdk/badges/main/pipeline.svg)](https://gitlab.dylanw.dev/dmarc-analyser/cdk/-/commits/main)

DMARC Analyser is an AWS Lambda-based DMARC report ingestion pipeline.  This repository contains the AWS CDK stack
that provisions all infrastructure for the project, including the API Gateway, Lambda functions, DynamoDB table, S3
buckets, and Route 53 records for `dmarc.dylanw.net`.

## Development

The following environment variables are required:

| Variable      | Description                                                      |
|---------------|------------------------------------------------------------------|
| `GITLAB_URL`  | The base URL of GitLab, used by the Lambda authorizer            |
| `DOMAIN_NAME` | The custom domain for the API (default: `api.dmarc.dylanw.net`) |

Install the dependencies:

```bash
npm install
```

Then run the following command to synthesize the CloudFormation template:

```bash
npx cdk synth
```

## Deployment

This is a CDK project.  It uses the `js-cdk-deploy` template from the
[cdk-deployment-base](https://gitlab.dylanw.dev/infrastructure/cdk-deployment-base) CI/CD component.  The `main`
branch is deployed automatically, and is also triggered by the `dmarc-analyser/api` and `dmarc-analyser/cron`
pipelines when new Lambda artifacts are uploaded.

## License

This application is licensed under the GNU General Public License v3.0 or later.

```
DMARC Analyser - A Lambda-based DMARC report ingestion pipeline.
Copyright (C) 2026  Dylan Wilson

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program.  If not, see <https://www.gnu.org/licenses/>.
```
