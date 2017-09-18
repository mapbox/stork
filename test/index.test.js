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
            }
          ]
        }
      ]
    }));
  });

  sinon.stub(got, 'get').callsFake(() => Promise.resolve({ body: { id: 1234 } }));
  sinon.stub(got, 'put').callsFake(() => Promise.resolve());
  sinon.stub(got, 'post').callsFake(() => Promise.resolve());

  const options = {
    region: 'us-east-1',
    suffix: 'staging',
    token: 'xxx',
    installation: 54321,
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
        got.get.calledWith(
          'https://api.github.com/repos/mapbox/foobar?access_token=xxx',
          {
            json: true,
            headers: {
              'User-Agent': 'github.com/mapbox/stork',
              'Content-Type': 'application/json'
            }
          }
        ),
        'looked up correct repo data via github api'
      );

      assert.ok(
        got.put.calledWith(
          'https://api.github.com/user/installations/54321/repositories/1234?access_token=xxx',
          {
            json: true,
            headers: {
              'User-Agent': 'github.com/mapbox/stork',
              Accept: 'application/vnd.github.machine-man-preview+json'
            }
          }
        ),
        'added repo to github app installation'
      );

      assert.ok(
        got.post.calledWith(
          'https://api.github.com/repos/mapbox/foobar/hooks?access_token=xxx',
          {
            json: true,
            headers: {
              'User-Agent': 'github.com/mapbox/stork',
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              name: 'web',
              active: true,
              events: ['push'],
              config: {
                url: 'webhook',
                secret: 'secret',
                content_type: 'json'
              }
            })
          }
        ),
        'properly configured webhook based on cloudformation outputs'
      );
    })
    .catch((err) => assert.ifError(err, 'failed'))
    .then(() => {
      AWS.CloudFormation.restore();
      got.get.restore();
      got.put.restore();
      got.post.restore();
      assert.end();
    });
});
