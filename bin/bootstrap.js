#!/usr/bin/env node

'use strict';

/* eslint-disable no-console */

const fs = require('fs');
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
    -a, --app-id            your Github App's ID
    -i, --installation-id   your Github App's installation's ID
    -s, --app-keyfile       path to your App's private key file
    -n, --npm-token         npm access token
    -k, --kms               [false] use KMS encryption for secure stack parameters
`, {
  alias: {
    r: 'regions',
    b: 'bucket-basename',
    p: 'bundle-prefix',
    a: 'app-id',
    i: 'installation-id',
    s: 'app-keyfile',
    n: 'npm-token',
    k: 'kms'
  },
  string: ['bucket-basename', 'bundle-prefix', 'github-token', 'npm-token', 'app-keyfile'],
  number: ['app-id', 'installation-id'],
  boolean: ['kms'],
  array: ['regions'],
  default: { kms: false }
});

const regions = Array.isArray(cli.flags.regions)
  ? cli.flags.regions
  : [cli.flags.regions];

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

  const privateKey = fs.readFileSync(cli.flags.appKeyfile, 'utf8');

  const preamble = [
    exec('git rev-parse HEAD', opts),
    cf.build(path.resolve(__dirname, '..', 'cloudformation', 'stork.template.js'))
  ];

  if (cli.flags.kms) {
    const kms = new AWS.KMS({ region });
    preamble.push(encrypt(kms, cli.flags.npmToken));
    preamble.push(encrypt(kms, privateKey));
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
        { ParameterKey: 'NpmAccessToken', ParameterValue: encryptedNpm || cli.flags.npmToken },
        { ParameterKey: 'GithubAppId', ParameterValue: cli.flags.appId },
        { ParameterKey: 'GithubAppInstallationId', ParameterValue: cli.flags.installationId },
        { ParameterKey: 'GithubAppPrivateKey', ParameterValue: encryptedGithub || privateKey },
        { ParameterKey: 'OutputBucketPrefix', ParameterValue: bucket },
        { ParameterKey: 'OutputKeyPrefix', ParameterValue: cli.flags.bundlePrefix },
        { ParameterKey: 'OutputBucketRegions', ParameterValue: cli.flags.regions.join(',') }
      ],
      TemplateBody: JSON.stringify(template)
    };
    return cfn.createStack(params).promise()
      .then(() => console.log(`Created stork stack in ${region}`));
  });
};

const pending = [uploadImage(regions[0])];

const bucket = `${cli.flags.bucketBasename}-${regions[0]}`;

pending.push(
  buildBundle()
    .then(() => uploadBundle(regions[0], bucket))
    .then(() => cleanup())
);

Promise.all(pending)
  .then(() => deployStack(regions[0], bucket));
