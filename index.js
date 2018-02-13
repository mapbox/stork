'use strict';

const querystring = require('querystring');
const AWS = require('aws-sdk');
const got = require('got');

/**
 * Add a webhook to a Github repository for a single stork region
 * @param  {Object}  options              - configuration
 * @param  {String}  options.region       - the stork region
 * @param  {String}  options.suffix       - the stork stack suffix
 * @param  {String}  options.org          - github repo's owner
 * @param  {String}  options.repo         - github repo's name
 * @return {Promise}                      - resolves when the hook has been created
 */
const setupHook = (options, cfn, lambda) => {
  cfn = cfn || new AWS.CloudFormation({ region: options.region });
  lambda = lambda || new AWS.Lambda({ region: options.region });

  return cfn.describeStacks({ StackName: `stork-${options.suffix}` }).promise()
    .then((data) => {
      const outputs = data.Stacks[0].Outputs;
      const installationId = Number(outputs
        .find((output) => output.OutputKey === 'GithubAppInstallationId')
        .OutputValue);
      const FunctionName = outputs
        .find((output) => output.OutputKey === 'GatekeeperLambda')
        .OutputValue;

      return lambda.invoke({
        FunctionName,
        InvocationType: 'RequestResponse',
        Payload: JSON.stringify({ repo: options.repo, org: options.org, installationId: installationId })
      }).promise();
    });
};

module.exports = { setupHook };
