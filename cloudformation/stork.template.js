'use strict';

const cf = require('@mapbox/cloudfriend');
const hookshot = require('@mapbox/hookshot');

const Parameters = {
  GitSha: { Type: 'String', Description: 'Current stork git SHA' },
  GithubAppId: { Type: 'String', Description: 'Your Github app ID' },
  GithubAppInstallationId: { Type: 'String', Description: 'The installation ID of your Github app' },
  GithubAppPrivateKey: { Type: 'String', Description: '[secure] A private key for your Github app' },
  GithubAccessToken: { Type: 'String', Description: '[secure] A personal access token that can update Github Apps' },
  NpmAccessToken: { Type: 'String', Description: '[secure] An NPM access token with access to private modules' },
  OutputBucketPrefix: { Type: 'String', Description: 'Prefix of bucket name that will house bundles' },
  OutputBucketRegions: { Type: 'String', Description: 'Regions used as bucket name suffixes' },
  OutputKeyPrefix: { Type: 'String', Description: 'Key prefix within the bucket for bundles' },
  AlarmEmail: { Type: 'String', Description: 'An email address to receive alarm notifications' }
};

const Resources = {
  AlarmSNSTopic: {
    Type: 'AWS::SNS::Topic',
    Properties: {
      Subscription: [
        { Protocol: 'email', Endpoint: cf.ref('AlarmEmail') }
      ]
    }
  },
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
                Resource: cf.sub('arn:aws:s3:::${OutputBucketPrefix}-${AWS::Region}/${OutputKeyPrefix}/*')
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
        S3Bucket: cf.sub('${OutputBucketPrefix}-${AWS::Region}'),
        S3Key: cf.sub('${OutputKeyPrefix}/stork/${GitSha}.zip')
      },
      Handler: 'lambda.trigger',
      Runtime: 'nodejs6.10',
      Timeout: 300,
      MemorySize: 512,
      Environment: {
        Variables: {
          GITHUB_APP_ID: cf.ref('GithubAppId'),
          GITHUB_APP_INSTALLATION_ID: cf.ref('GithubAppInstallationId'),
          GITHUB_APP_PRIVATE_KEY: cf.ref('GithubAppPrivateKey'),
          NPM_ACCESS_TOKEN: cf.ref('NpmAccessToken'),
          AWS_ACCOUNT_ID: cf.accountId,
          S3_BUCKET: cf.sub('${OutputBucketPrefix}-${AWS::Region}'),
          S3_PREFIX: cf.ref('OutputKeyPrefix'),
          PROJECT_ROLE: cf.getAtt('ProjectRole', 'Arn'),
          STATUS_FUNCTION: cf.getAtt('StatusLambda', 'Arn')
        }
      }
    }
  },
  TriggerLambdaErrorAlarm: {
    Type: 'AWS::CloudWatch::Alarm',
    Properties: {
      AlarmName: cf.sub('${AWS::StackName}-trigger-function-errors'),
      Period: 60,
      EvaluationPeriods: 1,
      Statistic: 'Sum',
      Threshold: 0,
      ComparisonOperator: 'GreaterThanThreshold',
      TreatMissingData: 'notBreaching',
      Namespace: 'AWS/Lambda',
      Dimensions: [
        { Name: 'FunctionName', Value: cf.ref('TriggerLambda') }
      ],
      MetricName: 'Errors',
      AlarmActions: [cf.ref('AlarmSNSTopic')]
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
        S3Bucket: cf.sub('${OutputBucketPrefix}-${AWS::Region}'),
        S3Key: cf.sub('${OutputKeyPrefix}/stork/${GitSha}.zip')
      },
      Handler: 'lambda.status',
      Runtime: 'nodejs6.10',
      Timeout: 300,
      MemorySize: 512,
      Environment: {
        Variables: {
          GITHUB_APP_ID: cf.ref('GithubAppId'),
          GITHUB_APP_INSTALLATION_ID: cf.ref('GithubAppInstallationId'),
          GITHUB_APP_PRIVATE_KEY: cf.ref('GithubAppPrivateKey')
        }
      }
    }
  },
  StatusLambdaErrorAlarm: {
    Type: 'AWS::CloudWatch::Alarm',
    Properties: {
      AlarmName: cf.sub('${AWS::StackName}-status-function-errors'),
      Period: 60,
      EvaluationPeriods: 5,
      Statistic: 'Sum',
      Threshold: 0,
      ComparisonOperator: 'GreaterThanThreshold',
      TreatMissingData: 'notBreaching',
      Namespace: 'AWS/Lambda',
      Dimensions: [
        { Name: 'FunctionName', Value: cf.ref('StatusLambda') }
      ],
      MetricName: 'Errors',
      AlarmActions: [cf.ref('AlarmSNSTopic')]
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
  },
  ForwarderLambdaLogs: {
    Type: 'AWS::Logs::LogGroup',
    Properties: {
      LogGroupName: cf.sub('/aws/lambda/${AWS::StackName}-forwarder'),
      RetentionInDays: 14
    }
  },
  ForwarderLambdaRole: {
    Type: 'AWS::IAM::Role',
    Properties: {
      AssumeRolePolicyDocument: {
        Statement: [
          {
            Effect: 'Allow',
            Action: 'sts:AssumeRole',
            Principal: { Service: 'lambda.amazonaws.com' }
          }
        ]
      },
      Policies: [
        {
          PolicyName: 'forward-bundles',
          PolicyDocument: {
            Statement: [
              {
                Effect: 'Allow',
                Action: 'logs:*',
                Resource: cf.getAtt('ForwarderLambdaLogs', 'Arn')
              },
              {
                Effect: 'Allow',
                Action: 's3:GetObject',
                Resource: cf.sub('arn:${AWS::Partition}:s3:::${OutputBucketPrefix}-${AWS::Region}/${OutputKeyPrefix}/*')
              },
              {
                Effect: 'Allow',
                Action: 's3:PutObject',
                Resource: cf.sub('arn:${AWS::Partition}:s3:::${OutputBucketPrefix}-*-*-*/${OutputKeyPrefix}/*')
              }
            ]
          }
        }
      ]
    }
  },
  ForwarderLambda: {
    Type: 'AWS::Lambda::Function',
    Properties: {
      FunctionName: cf.sub('${AWS::StackName}-forwarder'),
      Description: 'Replicate S3 objects to multiple buckets',
      Code: {
        S3Bucket: cf.sub('${OutputBucketPrefix}-${AWS::Region}'),
        S3Key: cf.sub('${OutputKeyPrefix}/stork/${GitSha}.zip')
      },
      Runtime: 'nodejs6.10',
      Timeout: 300,
      Handler: 'lambda.forwarder',
      MemorySize: 128,
      Role: cf.getAtt('ForwarderLambdaRole', 'Arn'),
      Environment: {
        Variables: {
          BUCKET_PREFIX: cf.ref('OutputBucketPrefix'),
          BUCKET_REGIONS: cf.ref('OutputBucketRegions')
        }
      }
    }
  },
  ForwarderLambdaErrorAlarm: {
    Type: 'AWS::CloudWatch::Alarm',
    Properties: {
      AlarmName: cf.sub('${AWS::StackName}-forwarder-function-errors'),
      Period: 60,
      EvaluationPeriods: 5,
      Statistic: 'Sum',
      Threshold: 0,
      ComparisonOperator: 'GreaterThanThreshold',
      TreatMissingData: 'notBreaching',
      Namespace: 'AWS/Lambda',
      Dimensions: [
        { Name: 'FunctionName', Value: cf.ref('ForwarderLambda') }
      ],
      MetricName: 'Errors',
      AlarmActions: [cf.ref('AlarmSNSTopic')]
    }
  },
  ForwarderLambdaPermission: {
    Type: 'AWS::Lambda::Permission',
    Properties: {
      Action: 'lambda:InvokeFunction',
      FunctionName: cf.ref('ForwarderLambda'),
      Principal: 's3.amazonaws.com',
      SourceArn: cf.sub('arn:${AWS::Partition}:s3:::${OutputBucketPrefix}-${AWS::Region}')
    }
  },
  GatekeeperLambdaLogs: {
    Type: 'AWS::Logs::LogGroup',
    Properties: {
      LogGroupName: cf.sub('/aws/lambda/${AWS::StackName}-gatekeeper'),
      RetentionInDays: 14
    }
  },
  GatekeeperLambdaRole: {
    Type: 'AWS::IAM::Role',
    Properties: {
      AssumeRolePolicyDocument: {
        Statement: [
          {
            Effect: 'Allow',
            Action: 'sts:AssumeRole',
            Principal: { Service: 'lambda.amazonaws.com' }
          }
        ]
      },
      Policies: [
        {
          PolicyName: 'gatekeeper-to-app',
          PolicyDocument: {
            Statement: [
              {
                Effect: 'Allow',
                Action: 'logs:*',
                Resource: cf.getAtt('GatekeeperLambdaLogs', 'Arn')
              }
            ]
          }
        }
      ]
    }
  },
  GatekeeperLambda: {
    Type: 'AWS::Lambda::Function',
    Properties: {
      FunctionName: cf.sub('${AWS::StackName}-gatekeeper'),
      Description: 'Add repositories to Github app',
      Code: {
        S3Bucket: cf.sub('${OutputBucketPrefix}-${AWS::Region}'),
        S3Key: cf.sub('${OutputKeyPrefix}/stork/${GitSha}.zip')
      },
      Runtime: 'nodejs6.10',
      Timeout: 300,
      Handler: 'lambda.gatekeeper',
      MemorySize: 128,
      Role: cf.getAtt('GatekeeperLambdaRole', 'Arn'),
      Environment: {
        Variables: {
          GITHUB_ACCESS_TOKEN: cf.ref('GithubAccessToken'),
          GITHUB_APP_INSTALLATION_ID: cf.ref('GithubAppInstallationId')
        }
      }
    }
  },
  GatekeeperLambdaErrorAlarm: {
    Type: 'AWS::CloudWatch::Alarm',
    Properties: {
      AlarmName: cf.sub('${AWS::StackName}-gatekeeper-function-errors'),
      Period: 60,
      EvaluationPeriods: 5,
      Statistic: 'Sum',
      Threshold: 0,
      ComparisonOperator: 'GreaterThanThreshold',
      TreatMissingData: 'notBreaching',
      Namespace: 'AWS/Lambda',
      Dimensions: [
        { Name: 'FunctionName', Value: cf.ref('GatekeeperLambda') }
      ],
      MetricName: 'Errors',
      AlarmActions: [cf.ref('AlarmSNSTopic')]
    }
  }
};

const Outputs = {
  GithubAppInstallationId: { Value: cf.ref('GithubAppInstallationId') },
  GatekeeperLambda: { Value: cf.ref('GatekeeperLambda') }
};

const webhook = hookshot.github('TriggerLambda');

module.exports = cf.merge({ Parameters, Resources, Outputs }, webhook);
