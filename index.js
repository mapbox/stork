'use strict';

const querystring = require('querystring');
const AWS = require('aws-sdk');
const got = require('got');

/**
 * Add a webhook to a Github repository for a single stork region
 * @param  {Object}  options              - configuration
 * @param  {String}  options.region       - the stork region
 * @param  {String}  options.suffix       - the stork stack suffix
 * @param  {String}  options.token        - github access token (repo, admin:repo_hook, user)
 * @param  {String}  options.installation - github app installation
 * @param  {String}  options.org          - github repo's owner
 * @param  {String}  options.repo         - github repo's name
 * @return {Promise}                      - resolves when the hook has been created
 */
const setupHook = (options) => {
  const cfn = new AWS.CloudFormation({ region: options.region });

  const repo = () => {
    const query = { access_token: options.token };

    const config = {
      json: true,
      headers: {
        'User-Agent': 'github.com/mapbox/stork',
        'Content-Type': 'application/json'
      }
    };

    const uri = `https://api.github.com/repos/${options.org}/${options.repo}`;

    return got.get(`${uri}?${querystring.stringify(query)}`, config)
      .then((data) => data.body.id);
  };

  const app = (repoId) => {
    const query = { access_token: options.token };

    const config = {
      json: true,
      headers: {
        'User-Agent': 'github.com/mapbox/stork',
        Accept: 'application/vnd.github.machine-man-preview+json'
      }
    };

    const uri = `https://api.github.com/user/installations/${options.installation}/repositories/${repoId}`;

    return got.put(`${uri}?${querystring.stringify(query)}`, config);
  };

  const hooks = (url, secret) => {
    const query = { access_token: options.token };

    const config = {
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
          url, secret,
          content_type: 'json'
        }
      })
    };

    const uri = `https://api.github.com/repos/${options.org}/${options.repo}/hooks`;

    return got.post(`${uri}?${querystring.stringify(query)}`, config);
  };

  return Promise.all([
    repo().then((repoId) => app(repoId)),
    cfn.describeStacks({ StackName: `stork-${options.suffix}` }).promise()
  ]).then((results) => {
    const data = results[1];

    const outputs = data.Stacks[0].Outputs;
    const url = outputs
      .find((output) => output.OutputKey === 'WebhookEndpoint')
      .OutputValue;
    const secret = outputs
      .find((output) => output.OutputKey === 'WebhookSecret')
      .OutputValue;

    return hooks(url, secret);
  });
};

module.exports = { setupHook };
