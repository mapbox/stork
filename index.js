'use strict';

const querystring = require('querystring');
const AWS = require('aws-sdk');
const got = require('got');

/**
 * Add a webhook to a Github repository for a single bundle-shepherd region
 * @param  {Object}  options        - configuration
 * @param  {String}  options.region - the bundle-shepherd region
 * @param  {String}  options.suffix - the bundle-shepherd stack suffix
 * @param  {String}  options.token  - github access token
 * @param  {String}  options.org    - github repo's owner
 * @param  {String}  options.repo   - github repo's name
 * @return {Promise}                - resolves when the hook has been created
 */
const setupHook = (options) => {
  const cfn = new AWS.CloudFormation({ region: options.region });

  const github = (url, secret) => {
    const query = { access_token: options.token };

    const config = {
      json: true,
      headers: {
        'User-Agent': 'github.com/mapbox/bundle-shepherd',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: 'web',
        active: true,
        events: ['push'],
        config: {
          url, secret,
          content_type: 'json'
        }
      })
    };

    const uri = `https://api.github.com/repos/${options.org}/${options.repo}/hooks`;

    return got.post(`${uri}?${querystring.stringify(query)}`, config);
  };

  return cfn.describeStacks({ StackName: `bundle-shepherd-${options.suffix}` })
    .promise()
    .then((data) => {
      const outputs = data.Stacks[0].Outputs;
      const url = outputs
        .find((output) => output.OutputKey === 'WebhookEndpoint')
        .OutputValue;
      const secret = outputs
        .find((output) => output.OutputKey === 'WebhookSecret')
        .OutputValue;

      return github(url, secret);
    });
};

module.exports = { setupHook };
