'use strict';

const cf = require('@mapbox/cloudfriend');
const buildWebhook = require('@mapbox/aws-github-webhook');

const Parameters = {
  OutputBucket: { Type: 'String' },
  OutputPrefix: { Type: 'String' }
};

const Resources = {
  ProjectRole: {
    Type: 'AWS::IAM::Role',
    Properties: {
      AssumeRolePolicyDocument: {
        Statement: [
          {
            Effect: 'Allow',
            Principal: { Service: 'codebuild.amazonaws.com' },
            Action: 'sts:AssumeRole'
          }
        ]
      },
      Policies: [
        {
          PolicyName: 'bundle-shepherd-projects',
          PolicyDocument: {
            Statement: [
              {
                Effect: 'Allow',
                Action: [
                  'logs:CreateLogGroup',
                  'logs:CreateLogStream',
                  'logs:PutLogEvents'
                ],
                Resource: cf.sub('arn:aws:logs:${AWS::Region}:${AWS::AccountID}:log-group/aws/codebuild/*')
              },
              {
                Effect: 'Allow',
                Action: 's3:PutObject',
                Resource: cf.sub('arn:aws:::${OutputBucket}/${OutputPrefix}/*')
              },
              {
                Effect: 'Allow',
                Action: [
                  'ecr:GetDownloadUrlForLayer',
                  'ecr:BatchGetImage',
                  'ecr:BatchCheckLayerAvailability'
                ],
                Resource: '*'
              }
            ]
          }
        }
      ]
    }
  },
  TriggerLambdaLogs: {
    Type: 'AWS::Logs::LogGroup',
    Properties: {
      LogGroupName: cf.sub('/aws/lambda/${AWS::StackName}-trigger'),
      RetentionInDays: 14
    }
  },
  TriggerLambdaRole: {
    Type: 'AWS::IAM::Role',
    Properties: {
      AssumeRolePolicyDocument: {
        Statement: [
          {
            Effect: 'Allow',
            Principal: { Service: 'lambda.amazonaws.com' },
            Action: 'sts:AssumeRole'
          }
        ]
      },
      Policies: [
        {
          PolicyName: 'codebuild-trigger',
          PolicyDocument: {
            Statement: [
              {
                Effect: 'Allow',
                Action: 'logs:*',
                Resource: cf.getAtt('TriggerLambdaLogs', 'Arn')
              },
              {
                Effect: 'Allow',
                Action: [
                  'codebuild:BatchGetProjects',
                  'codebuild:CreateProject',
                  'codebuild:StartBuild'
                ],
                Resource: '*'
              }
            ]
          }
        }
      ]
    }
  },
  TriggerLambda: {
    Type: 'AWS::Lambda::Function',
    Properties: {
      FunctionName: cf.sub('${AWS::StackName}-trigger'),
      Description: 'Triggers bundle-shepherd projects',
      Role: cf.getAtt('TriggerLambdaRole', 'Arn'),
      Code: {
        S3Bucket: '',
        S3Key: ''
      },
      Handler: 'trigger-lambda.lambda',
      Runtime: 'nodejs6.10',
      Timeout: 300,
      MemorySize: 512,
      Environment: {
        Variables: {
          GITHUB_ACCESS_TOKEN: cf.ref('GithubAccessToken'),
          AWS_ACCOUNT_ID: cf.accountId,
          AWS_DEFAULT_REGION: cf.region,
          S3_BUCKET: cf.ref('OutputBucket'),
          S3_PREFIX: cf.ref('OutputPrefix'),
          PROJECT_ROLE: cf.getAtt('ProjectRole', 'Arn')
        }
      }
    }
  }
};

const webhook = buildWebhook('TriggerLambda');
module.exports = cf.merge({ Parameters, Resources }, webhook);
