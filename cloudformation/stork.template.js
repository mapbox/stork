'use strict';

const cf = require('@mapbox/cloudfriend');
const buildWebhook = require('@mapbox/aws-github-webhook');

const Parameters = {
  GitSha: { Type: 'String', Description: 'Current stork git SHA' },
  GithubAccessToken: { Type: 'String', Description: '[secure] A Github access token with repo scope' },
  NpmAccessToken: { Type: 'String', Description: '[secure] An NPM access token with access to private modules' },
  UseOAuth: { Type: 'String', AllowedValues: ['true', 'false'], Description: 'Whether AWS connect to Github via OAuth or via token' },
  OutputBucket: { Type: 'String', Description: 'Bucket to house bundles' },
  OutputPrefix: { Type: 'String', Description: 'Prefix within bucket for bundles' }
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
          PolicyName: 'stork-projects',
          PolicyDocument: {
            Statement: [
              {
                Effect: 'Allow',
                Action: [
                  'logs:CreateLogGroup',
                  'logs:CreateLogStream',
                  'logs:PutLogEvents'
                ],
                Resource: cf.sub('arn:aws:logs:${AWS::Region}:${AWS::AccountId}:log-group:/aws/codebuild/*')
              },
              {
                Effect: 'Allow',
                Action: 's3:PutObject',
                Resource: cf.sub('arn:aws:s3:::${OutputBucket}/${OutputPrefix}/*')
              },
              {
                Effect: 'Allow',
                Action: [
                  'ecr:GetDownloadUrlForLayer',
                  'ecr:BatchGetImage',
                  'ecr:BatchCheckLayerAvailability'
                ],
                Resource: '*'
              },
              {
                Effect: 'Allow',
                Action: 'kms:Decrypt',
                Resource: cf.importValue('cloudformation-kms-production')
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
                  'codebuild:StartBuild',
                  'events:PutRule',
                  'events:PutTargets'
                ],
                Resource: '*'
              },
              {
                Effect: 'Allow',
                Action: 'iam:PassRole',
                Resource: cf.getAtt('ProjectRole', 'Arn')
              },
              {
                Effect: 'Allow',
                Action: 'kms:Decrypt',
                Resource: cf.importValue('cloudformation-kms-production')
              },
              {
                Effect: 'Allow',
                Action: [
                  'logs:CreateLogGroup',
                  'logs:PutRetentionPolicy'
                ],
                Resource: cf.sub('arn:aws:logs:${AWS::Region}:${AWS::AccountId}:log-group:/aws/codebuild/*')
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
      Description: 'Triggers stork projects',
      Role: cf.getAtt('TriggerLambdaRole', 'Arn'),
      Code: {
        S3Bucket: cf.ref('OutputBucket'),
        S3Key: cf.sub('${OutputPrefix}/stork/${GitSha}.zip')
      },
      Handler: 'lambda.trigger',
      Runtime: 'nodejs6.10',
      Timeout: 300,
      MemorySize: 512,
      Environment: {
        Variables: {
          USE_OAUTH: cf.ref('UseOAuth'),
          GITHUB_ACCESS_TOKEN: cf.ref('GithubAccessToken'),
          NPM_ACCESS_TOKEN: cf.ref('NpmAccessToken'),
          AWS_ACCOUNT_ID: cf.accountId,
          S3_BUCKET: cf.ref('OutputBucket'),
          S3_PREFIX: cf.ref('OutputPrefix'),
          PROJECT_ROLE: cf.getAtt('ProjectRole', 'Arn'),
          STATUS_FUNCTION: cf.getAtt('StatusLambda', 'Arn')
        }
      }
    }
  },
  StatusLambdaRole: {
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
          PolicyName: 'codebuild-status',
          PolicyDocument: {
            Statement: [
              {
                Effect: 'Allow',
                Action: 'logs:*',
                Resource: cf.getAtt('StatusLambdaLogs', 'Arn')
              },
              {
                Effect: 'Allow',
                Action: 'codebuild:BatchGetBuilds',
                Resource: '*'
              },
              {
                Effect: 'Allow',
                Action: 'kms:Decrypt',
                Resource: cf.importValue('cloudformation-kms-production')
              }
            ]
          }
        }
      ]
    }
  },
  StatusLambdaLogs: {
    Type: 'AWS::Logs::LogGroup',
    Properties: {
      LogGroupName: cf.sub('/aws/lambda/${AWS::StackName}-status'),
      RetentionInDays: 14
    }
  },
  StatusLambda: {
    Type: 'AWS::Lambda::Function',
    Properties: {
      FunctionName: cf.sub('${AWS::StackName}-status'),
      Description: 'Reports status on stork projects',
      Role: cf.getAtt('StatusLambdaRole', 'Arn'),
      Code: {
        S3Bucket: cf.ref('OutputBucket'),
        S3Key: cf.sub('${OutputPrefix}/stork/${GitSha}.zip')
      },
      Handler: 'lambda.status',
      Runtime: 'nodejs6.10',
      Timeout: 300,
      MemorySize: 512,
      Environment: {
        Variables: {
          GITHUB_ACCESS_TOKEN: cf.ref('GithubAccessToken')
        }
      }
    }
  },
  StatusFunctionPermission: {
    Type: 'AWS::Lambda::Permission',
    Properties: {
      Action: 'lambda:InvokeFunction',
      Principal: 'events.amazonaws.com',
      FunctionName: cf.getAtt('StatusLambda', 'Arn'),
      SourceArn: cf.sub('arn:aws:events:${AWS::Region}:${AWS::AccountId}:rule/*')
    }
  }
};

const webhook = buildWebhook('TriggerLambda');
module.exports = cf.merge({ Parameters, Resources }, webhook);
