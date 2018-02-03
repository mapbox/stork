'use strict';

const test = require('tape');
const sinon = require('sinon');
const AWS = require('@mapbox/mock-aws-sdk-js');
const got = require('got');
const setupHook = require('..').setupHook;

test('[setupHook] success', (assert) => {
  const describe = AWS.stub('CloudFormation', 'describeStacks', function() {
    this.request.promise.returns(Promise.resolve({
      Stacks: [
        {
          Outputs: [
            {
              OutputKey: 'WebhookEndpoint',
              OutputValue: 'webhook'
            },
            {
              OutputKey: 'WebhookSecret',
              OutputValue: 'secret'
            },
            {
              OutputKey: 'GithubAppInstallationId',
              OutputValue: '54321'
            },
            {
              OutputKey: 'GatekeeperLambda',
              OutputValue: 'functionname'
            }
          ]
        }
      ]
    }));
  });

  const invoke = AWS.stub('Lambda', 'invoke', function() {
    this.request.promise.returns(Promise.resolve());
  });

  const options = {
    region: 'us-east-1',
    suffix: 'staging',
    org: 'mapbox',
    repo: 'foobar'
  };

  setupHook(options)
    .then(() => {
      assert.ok(
        AWS.CloudFormation.calledWith({ region: 'us-east-1' }),
        'created cloudformation client in the right region'
      );

      assert.ok(
        describe.calledWith({ StackName: 'stork-staging' }),
        'descibed the properly suffixed stork stack'
      );

      assert.ok(
        invoke.calledWith({
          FunctionName: 'functionname',
          InvocationType: 'RequestResponse',
          Payload: JSON.stringify({ repo: 'foobar', org: 'mapbox', installationId: 54321 })
        }),
        'invoked gatekeeper lambda function for the right repository'
      );
    })
    .catch((err) => assert.ifError(err, 'failed'))
    .then(() => {
      AWS.CloudFormation.restore();
      AWS.Lambda.restore();
      assert.end();
    });
});
