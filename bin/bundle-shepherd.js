#!/usr/bin/env node

'use strict';

const zeroarg = require('zeroarg');
const shepherd = require('../trigger-lambda').lambda;

zeroarg(() => {
  /**
   * Runs bundle-shepherd by pretending to be a lambda function
   *
   * @param {object} options
   * @param {string} options.org - the owner of the repository
   * @param {string} options.repo - the repository name
   * @param {string} options.sha - the commit SHA to build
   * @param {string} options.token - a Github access token that can clone the repo
   * @param {string} options.account - the AWS Account ID for the build to occur in
   * @param {string} options.region - the AWS region for the build to occur in
   * @param {string} options.bucket - the S3 bucket to put bundles in
   * @param {string} options.prefix - the S3 prefix to file bundles under
   * @param {string} options.role - the ARN for the CodeBuild project's IAM role
   */
  return (options) => {
    const Message = JSON.stringify({
      after: options.sha,
      repository: {
        name: options.repo,
        owner: { name: options.org }
      }
    });

    const event = { Records: [{ Sns: { Message } }] };

    process.env.GITHUB_ACCESS_TOKEN = options.token;
    process.env.AWS_ACCOUNT_ID = options.account;
    process.env.AWS_DEFAULT_REGION = options.region;
    process.env.S3_BUCKET = options.bucket;
    process.env.S3_PREFIX = options.prefix;
    process.env.PROJECT_ROLE = options.role;

    shepherd(event, {}, (err, data) => {
      if (err) process.stderr.write(`${err.stack}\n`);
      process.stdout.write(`${JSON.stringify(data, null, 2)}`);
    });
  };
});
