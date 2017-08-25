'use strict';

const cf = require('@mapbox/cloudfriend');
const buildWebhook = require('@mapbox/aws-github-webhook');
const inquirer = require('inquirer');

module.exports = (options, callback) => {
  inquirer.prompt([ // @TODO: figure out how to get the existing values as defaults
    {
      type: 'input',
      name: 'bucket',
      message: '[preamble] Prefix for regional bundle-buckets:'
    },
    {
      type: 'input',
      name: 'regions',
      message: '[preamble] Regions to put bundles in:',
      filter: (input) => input.split(/, ?/)
    }
  ]).then((answers) => {
    const buckets = answers.regions.map((region) => `${answers.bucket}-${region}`);
    const arns = buckets.map((bucket) => `arn:\${AWS::Partition}:s3:::${bucket}/*`);
    const primaryBucket = `${answers.bucket}-\${AWS::Region}`;

    const Parameters = {
      GitSha: { Type: 'String', Description: 'Current stork git SHA' },
      GithubAccessToken: { Type: 'String', Description: '[secure] A Github access token with repo scope' },
      NpmAccessToken: { Type: 'String', Description: '[secure] An NPM access token with access to private modules' },
      UseOAuth: { Type: 'String', AllowedValues: ['true', 'false'], Description: 'Whether AWS connect to Github via OAuth or via token' },
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
                    Resource: cf.sub(`arn:aws:s3:::${primaryBucket}/\${OutputPrefix}/*`)
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
            S3Bucket: primaryBucket,
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
              S3_BUCKET: primaryBucket,
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
            S3Bucket: primaryBucket,
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
      },
      ForwarderLambdaLogs: {
        Type: 'AWS::CloudWatch::LogGroup',
        Properties: {
          LogGroupName: cf.sub('/aws/lambda/${AWS::StackName}-forwarder'),
          RetentionPeriodInDays: 14
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
                Principal: { Service: cf.sub('lambda.amazonaws.${AWS::DomainSuffix}') }
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
                    Resource: cf.sub(`arn:\${AWS::Partition}:s3:::${primaryBucket}/\${OutputPrefix}/*`)
                  },
                  {
                    Effect: 'Allow',
                    Action: 's3:PutObject',
                    Resource: arns
                  }
                ]
              }
            }
          ]
        }
      },
      ForwarderLambda: {
        Type: 'AWS::Lambda::Permission',
        Properties: {
          FunctionName: cf.sub('${AWS::StackName}-s3-scattershot'),
          Description: 'Replicate S3 objects to multiple buckets',
          Code: {
            S3Bucket: primaryBucket,
            S3Key: cf.sub('${OutputPrefix}/stork/${GitSha}.zip')
          },
          Runtime: 'nodejs6.10',
          Timeout: 300,
          Handler: 'lambda.forwarder',
          MemorySize: 128,
          Role: cf.getAtt('ForwarderLambdaRole', 'Arn'),
          Environment: {
            Variables: {
              BUCKET_PREFIX: answers.bucket,
              BUCKET_REGIONS: JSON.stringify(answers.regions)
            }
          }
        }
      },
      ForwarderLambdaPermission: {
        Type: 'AWS::Lamdba::Permission',
        Properties: {
          Action: 'lambda:InvokeFunction',
          FunctionName: cf.ref('ForwarderLambda'),
          Principal: { Service: cf.sub('s3.amazonaws.${AWS::DomainSuffix}') },
          SourceArn: cf.sub(`arn:\${AWS::Partition}:s3:::${primaryBucket}`)
        }
      }
    };

    const webhook = buildWebhook('TriggerLambda');

    callback(null, cf.merge({ Parameters, Resources }, webhook));
  });
};
