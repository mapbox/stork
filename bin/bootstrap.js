#!/usr/bin/env node

'use strict';

/* eslint-disable no-console */

const cp = require('child_process');
const path = require('path');
const meow = require('meow');
const cf = require('@mapbox/cloudfriend');
const AWS = require('aws-sdk');

const cli = meow(`
  USAGE: ./bin/bootstrap.js [options]

  Bootstraps stork stacks in a set of AWS regions. All options are not optional.

  OPTIONS:
    -r, --regions           a set of regions to bootstrap
    -b, --bucket-basename   the root name of the bucket that will house bundles
    -p, --bundle-prefix     the prefix under which bundles will reside
    -g, --github-token      github access token
    -n, --npm-token         npm access token
    -o, --oauth             [false] use OAuth (must already be configured)
    -k, --kms               [false] use KMS encryption for secure stack parameters
`, {
  alias: {
    r: 'regions',
    b: 'bucket-basename',
    p: 'bundle-prefix',
    g: 'github-token',
    n: 'npm-token',
    o: 'oauth',
    k: 'kms'
  },
  string: ['bucket-basename', 'bundle-prefix', 'github-token', 'npm-token'],
  boolean: ['oauth'],
  array: ['regions'],
  default: {
    oauth: false,
    kms: false
  }
});

const regions = Array.isArray(cli.flags.regions)
  ? cli.flags.regions
  : [cli.flags.regions];
const buckets = regions.map((region) => `${cli.flags.bucketBasename}-${region}`);

const exec = (cmd, options) => new Promise((resolve, reject) => {
  cp.exec(cmd, options, (err, stdout) => {
    if (err) return reject(err);
    resolve(stdout.trim());
  });
});

const buildBundle = () => {
  const opts = { cwd: path.resolve(__dirname, '..' ) };

  return exec('rm -rf node_modules', opts)
    .then(() => exec('npm install --production', opts))
    .then(() => exec('rm -f bundle.zip', opts))
    .then(() => exec('zip -r -x \\*.git\\* -q bundle.zip ./', opts));
};

const cleanup = () => {
  const opts = { cwd: path.resolve(__dirname, '..' ) };

  return exec('rm -f bundle.zip', opts)
    .then(() => exec('rm -rf node_modules', opts))
    .then(() => exec('npm install', opts))
    .then(() => console.log('Cleaned up working directory'));
};

const uploadBundle = (region, bucket) => {
  const opts = { cwd: path.resolve(__dirname, '..' ) };

  return exec('git rev-parse HEAD', opts)
    .then((gitsha) => exec(`aws s3 cp ./bundle.zip s3://${bucket}/${cli.flags.bundlePrefix}/stork/${gitsha}.zip`))
    .then(() => console.log(`Uploaded stork code to ${bucket}`));
};

const uploadImage = (region) => {
  const opts = { cwd: path.resolve(__dirname, '..', 'Dockerfiles') };

  return exec(`./build.sh ${region} > /dev/null`, opts)
    .then(() => console.log(`Uploaded docker images to ECR in ${region}`));
};

const encrypt = (client, value) => client.encrypt({
  KeyId: 'alias/cloudformation',
  Plaintext: value
}).promise()
  .then((data) => `secure:${data.CiphertextBlob.toString('base64')}`);

const deployStack = (region, bucket) => {
  const opts = { cwd: path.resolve(__dirname, '..' ) };
  const cfn = new AWS.CloudFormation({ region });

  const preamble = [
    exec('git rev-parse HEAD', opts),
    cf.build(path.resolve(__dirname, '..', 'cloudformation', 'stork.template.js'))
  ];

  if (cli.flags.kms) {
    const kms = new AWS.KMS({ region });
    preamble.push(encrypt(kms, cli.flags.npmToken));
    preamble.push(encrypt(kms, cli.flags.githubToken));
  }

  return Promise.all(preamble).then((results) => {
    const gitsha = results[0];
    const template = results[1];
    const encryptedNpm = results[2];
    const encryptedGithub = results[3];
    const params = {
      StackName: 'stork-production',
      Capabilities: ['CAPABILITY_IAM'],
      OnFailure: 'DELETE',
      Parameters: [
        { ParameterKey: 'GitSha', ParameterValue: gitsha },
        { ParameterKey: 'UseOAuth', ParameterValue: cli.flags.oauth.toString() },
        { ParameterKey: 'NpmAccessToken', ParameterValue: encryptedNpm || cli.flags.npmToken },
        { ParameterKey: 'GithubAccessToken', ParameterValue: encryptedGithub || cli.flags.githubToken },
        { ParameterKey: 'OutputBucket', ParameterValue: bucket },
        { ParameterKey: 'OutputPrefix', ParameterValue: cli.flags.bundlePrefix }
      ],
      TemplateBody: JSON.stringify(template)
    };
    return cfn.createStack(params).promise()
      .then(() => console.log(`Created stork stack in ${region}`));
  });
};

const pending = regions.map((region) => uploadImage(region));

pending.push(buildBundle().then(() => {
  const uploads = regions.map((region, i) => {
    const bucket = buckets[i];
    return uploadBundle(region, bucket);
  });
  return Promise.all(uploads);
}).then(() => cleanup()));

Promise.all(pending).then(() => {
  const stacks = regions.map((region, i) => {
    const bucket = buckets[i];
    return deployStack(region, bucket);
  });
  return Promise.all(stacks);
});
