'use strict';

/* eslint-disable no-console */

const url = require('url');
const fs = require('fs');
const path = require('path');
const got = require('got');
const querystring = require('querystring');
const AWS = require('aws-sdk');
const jwt = require('jsonwebtoken');
const decrypt = require('decrypt-kms-env');

class Traceable extends Error {
  constructor(err) {
    super();
    Object.assign(this, err);
    Error.captureStackTrace(this, Traceable);
  }

  static promise(err) {
    return Promise.reject(new Traceable(err));
  }
}

const githubToken = (appId, installationId, privateKey) => {
  return Promise.resolve()
    .then(() => {
      const token = jwt.sign(
        {
          iss: appId,
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + (10 * 60)
        },
        privateKey,
        { algorithm: 'RS256' }
      );

      const config = {
        json: true,
        headers: {
          'User-Agent': 'github.com/mapbox/stork',
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github.machine-man-preview+json'
        }
      };

      const uri = `https://api.github.com/installations/${installationId}/access_tokens`;
      return got.get('https://api.github.com/app', config)
        .then(() => got.post(uri, config));
    })
    .then((data) => data.body.token);
};

const projectName = (org, repo, imageUri) => {
  const imageName = imageUri.split('/').pop()
    .replace(/:/g, '_')
    .replace(/\./g, '_')
    .replace(/stork_/, '');
  return `${org}_${repo}_${imageName}`;
};

/**
 * Find an existing CodeBuild project for a repository.
 *
 * @param {object} options
 * @param {string} options.org
 * @param {string} options.repo
 * @param {string} options.imageUri
 * @param {string} options.region - for the CodeBuild project
 * @returns {Promise} CodeBuild project information
 */
const findProject = (options) => {
  const codebuild = new AWS.CodeBuild({ region: options.region });
  const name = projectName(options.org, options.repo, options.imageUri);

  console.log(`Looking for project: ${name}`);

  return codebuild.batchGetProjects({ names: [name] }).promise()
    .catch((err) => Traceable.promise(err))
    .then((data) => data.projects[0]);
};

/**
 * Create a new CodeBuild project for a repository.
 *
 * @param {object} options
 * @param {string} options.org
 * @param {string} options.repo
 * @param {string} options.imageUri
 * @param {string} options.size - small, medium, or large
 * @param {string} options.bucket
 * @param {string} options.prefix
 * @param {string} options.region - for the CodeBuild project
 * @param {string} options.role - ARN for project's IAM role
 * @param {string} options.status - ARN for status Lambda function
 * @param {string} options.npmToken - encrypted NPM access token
 * @returns {Promise} CodeBuild project information
 */
const createProject = (options) => {
  const project = {
    name: projectName(options.org, options.repo, options.imageUri),
    description: `Lambda builds for ${options.org}/${options.repo}`,
    serviceRole: options.role,
    source: {
      type: 'GITHUB',
      location: `https://github.com/${options.org}/${options.repo}`,
      auth: { type: 'OAUTH' }
    },
    artifacts: {
      type: 'S3',
      packaging: 'ZIP',
      location: options.bucket,
      path: `${options.prefix}/${options.repo}`
    },
    environment: {
      type: 'LINUX_CONTAINER',
      image: options.imageUri,
      computeType: `BUILD_GENERAL1_${options.size.toUpperCase()}`,
      environmentVariables: [
        { name: 'NPM_ACCESS_TOKEN', value: options.npmToken }
      ]
    }
  };

  const rule = {
    Name: project.name,
    Description: `Build status notifications for ${project.name}`,
    EventPattern: JSON.stringify({
      source: ['aws.codebuild'],
      'detail-type': ['CodeBuild Build State Change'],
      detail: {
        'build-status': ['IN_PROGRESS', 'SUCCEEDED', 'FAILED', 'STOPPED'],
        'project-name': [project.name]
      }
    }),
    State: 'ENABLED'
  };

  const targets = {
    Rule: project.name,
    Targets: [{ Id: 'invoke-lambda', Arn: options.status }]
  };

  const logGroup = { logGroupName: `/aws/codebuild/${project.name}` };
  const retention = Object.assign({ retentionInDays: 14 }, logGroup);

  const codebuild = new AWS.CodeBuild({ region: options.region });
  const events = new AWS.CloudWatchEvents({ region: options.region });
  const logs = new AWS.CloudWatchLogs({ region: options.region });

  return logs.createLogGroup(logGroup).promise()
      .catch((err) => {
        if (err && err.message !== 'The specified log group already exists')
          return Traceable.promise(err);
        return Promise.resolve();
      })

    .then(() => logs.putRetentionPolicy(retention).promise()
      .catch((err) => Traceable.promise(err)))

    .then(() => codebuild.createProject(project).promise()
      .catch((err) => Traceable.promise(err)))

    .then((data) => Promise.all([
      data.project,
      events.putRule(rule).promise()
      .catch((err) => Traceable.promise(err))
    ]))

    .then((results) => Promise.all([
      results[0].project,
      events.putTargets(targets).promise()
        .catch((err) => Traceable.promise(err))
    ]))

    .then((results) => results[0]);
};

/**
 * Run a build for a particular commit to a repository.
 *
 * @param {object} options
 * @param {string} options.org
 * @param {string} options.repo
 * @param {string} options.imageUri
 * @param {string} options.sha
 * @param {string} options.bucket
 * @param {string} options.prefix
 * @param {string} [options.buildspec]
 * @returns {Promise} build information
 */
const runBuild = (options) => {
  const params = {
    projectName: projectName(options.org, options.repo, options.imageUri),
    sourceVersion: options.sha,
    artifactsOverride: {
      type: 'S3',
      packaging: 'ZIP',
      location: options.bucket,
      path: `${options.prefix}/${options.repo}`,
      name: `${options.sha}.zip`
    }
  };

  if (options.buildspec) params.buildspecOverride = options.buildspec;

  const codebuild = new AWS.CodeBuild({ region: options.region });
  return codebuild.startBuild(params).promise()
    .catch((err) => Traceable.promise(err))
    .then((data) => data.build);
};

/**
 * Gets a file from Github.
 *
 * @param {object} options
 * @param {string} options.org
 * @param {string} options.repo
 * @param {string} options.sha
 * @param {string} options.token
 * @param {string} options.path
 */
const getFromGithub = (options) => {
  const query = { ref: options.sha };

  const config = {
    json: true,
    headers: {
      'User-Agent': 'github.com/mapbox/stork',
      Authorization: `token ${options.token}`,
      Accept: 'application/vnd.github.machine-man-preview+json'
    }
  };

  const uri = `https://api.github.com/repos/${options.org}/${options.repo}/contents/${options.path}`;

  return got
    .get(`${uri}?${querystring.stringify(query)}`, config)
    .then((data) => data.body)
    .catch((err) => err);
};

/**
 * Checks the org/repo@sha for a configuration file and/or buildspec.yml
 *
 * @param {object} options
 * @param {string} options.org
 * @param {string} options.repo
 * @param {string} options.sha
 * @param {number} options.appId
 * @param {number} options.installationId
 * @param {string} options.privateKey
 */
const checkRepoOverrides = (options) => {
  return githubToken(options.appId, options.installationId, options.privateKey)
    .then((token) => {
      options = Object.assign({ token }, options);
      return Promise.all([
        getFromGithub(Object.assign({ path: 'buildspec.yml' }, options)),
        getFromGithub(Object.assign({ path: '.stork.json' }, options))
      ]);
    })
    .then((data) => {
      const buildspec = data[0];
      let config = data[1];

      const result = {
        buildspec: false,
        image: 'nodejs6.x',
        size: 'small'
      };

      if (buildspec.type === 'file') result.buildspec = true;
      if (config.type === 'file') {
        config = Buffer.from(config.content, config.encoding).toString('utf8');
        config = JSON.parse(config);
        if (config.image) result.image = config.image;
        if (config.size) result.size = config.size;
      }

      console.log(`Override result: ${JSON.stringify(result)}`);

      return result;
    });
};

/**
 * Get image URI for default images
 *
 * @param {object} options
 * @param {string} options.accountId
 * @param {string} options.region
 * @param {string} options.imageName
 * @returns
 */
const getImageUri = (options) => {
  const defaultImages = {
    'nodejs6.x': `${options.accountId}.dkr.ecr.${options.region}.amazonaws.com/stork:nodejs6.x`,
    'nodejs4.3': `${options.accountId}.dkr.ecr.${options.region}.amazonaws.com/stork:nodejs4.3`,
    'python2.7': `${options.accountId}.dkr.ecr.${options.region}.amazonaws.com/stork:python2.7`,
    'python3.6': `${options.accountId}.dkr.ecr.${options.region}.amazonaws.com/stork:python3.6`
  };

  return defaultImages[options.imageName] || options.imageName;
};

/**
 * Get the default buildspec.yml as text.
 *
 * @param {object} defaultImage
 * @returns {string} the default buildspec.yml as a string
 */
const getDefaultBuildspec = (defaultImage) => {
  const buildspec = path.resolve(__dirname, 'buildspecs', `${defaultImage}.yml`);
  return fs.readFileSync(buildspec, 'utf8');
};

const exported = {
  decrypt: (env) => new Promise((resolve, reject) => {
    decrypt(env, (err) => {
      if (err) return reject(err);
      resolve();
    });
  })
};

exported.trigger = (event, context, callback) => {
  const encryptedNpmToken = process.env.NPM_ACCESS_TOKEN;

  exported.decrypt(process.env).then(() => {
    const appId = Number(process.env.GITHUB_APP_ID);
    const installationId = Number(process.env.GITHUB_APP_INSTALLATION_ID);
    const privateKey = process.env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, '\n');

    let commit, options;
    try {
      commit = JSON.parse(event.Records[0].Sns.Message);
      options = {
        org: commit.repository.owner.name,
        repo: commit.repository.name,
        sha: commit.after,
        npmToken: encryptedNpmToken,
        appId,
        installationId,
        privateKey,
        accountId: process.env.AWS_ACCOUNT_ID,
        region: process.env.AWS_DEFAULT_REGION,
        bucket: process.env.S3_BUCKET,
        prefix: process.env.S3_PREFIX,
        role: process.env.PROJECT_ROLE,
        status: process.env.STATUS_FUNCTION
      };
    } catch (err) {
      return callback(null, `CANNOT PARSE ${err.message}: ${JSON.stringify(event)}`);
    }

    console.log(`Looking for repo overrides in ${options.org}/${options.repo}@${options.sha}`);

    return checkRepoOverrides(options)
      .then((config) => {
        options.imageUri = getImageUri(Object.assign({ imageName: config.image }, options));
        options.size = config.size;

        console.log(`Looking for existing project for ${options.org}/${options.repo} using image ${options.imageUri}`);

        return Promise.all([config, findProject(options)]);
      })
      .then((results) => {
        const config = results[0];
        const project = results[1];

        console.log(project
          ? 'Found existing project'
          : 'Creating a new project'
        );

        return Promise.all([
          config,
          project ? project : createProject(options)
        ]);
      })
      .then((results) => {
        const config = results[0];
        if (!config.buildspec)
          options.buildspec = getDefaultBuildspec(config.image);

        console.log(`Running a build for ${options.org}/${options.repo}@${options.sha}`);

        return runBuild(options);
      })
      .then((data) => callback(null, data))
      .catch((err) => callback(err));
  });
};

exported.status = (event, context, callback) => {
  exported.decrypt(process.env).then(() => {
    const appId = Number(process.env.GITHUB_APP_ID);
    const installationId = Number(process.env.GITHUB_APP_INSTALLATION_ID);
    const privateKey = process.env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, '\n');
    const id = event.detail['build-id'];
    const phase = event.detail['build-status'];

    const states = {
      IN_PROGRESS: 'pending',
      SUCCEEDED: 'success',
      FAILED: 'failure',
      STOPPED: 'error'
    };

    const descriptions = {
      IN_PROGRESS: 'Your build is in progress',
      SUCCEEDED: 'Your build succeeded',
      FAILED: 'Your build failed',
      STOPPED: 'Your build encountered an error'
    };

    const codebuild = new AWS.CodeBuild();

    const requests = [
      githubToken(appId, installationId, privateKey),
      codebuild.batchGetBuilds({ ids: [id] }).promise()
        .catch((err) => Traceable.promise(err))
    ];

    Promise.all(requests)
      .then((results) => {
        const token = results[0];
        const data = results[1];

        const build = data.builds[0];
        if (!build) return;

        const logs = build.logs.deepLink;
        const sha = build.sourceVersion;
        const source = url.parse(build.source.location);
        const owner = source.pathname.split('/')[1];
        const repo = source.pathname.split('/')[2].replace(/.git$/, '');

        const uri = `https://api.github.com/repos/${owner}/${repo}/statuses/${sha}`;
        const status = {
          context: 'stork',
          description: descriptions[phase],
          state: states[phase],
          target_url: logs
        };

        return got.post(uri, {
          json: true,
          headers: {
            'Content-type': 'application/json',
            'User-Agent': 'github.com/mapbox/stork',
            Authorization: `token ${token}`,
            Accept: 'application/vnd.github.machine-man-preview+json'
          },
          body: JSON.stringify(status)
        });
      })
      .then(() => callback())
      .catch((err) => {
        console.log(err);
        callback(err);
      });
  });
};

exported.forwarder = (event, context, callback) => {
  class S3Object {
    constructor(bucket, key, region) {
      Object.assign(this, { bucket, key, region });
      this.client = new AWS.S3({ region });
    }

    copyTo(dst) {
      return dst.client.copyObject({
        CopySource: `/${this.bucket}/${this.key}`,
        Bucket: dst.bucket,
        Key: dst.key
      }).promise()
        .catch((err) => {
          console.log(`Error copying to s3://${dst.bucket}/${dst.key}`);
          return Promise.reject(err);
        });
    }
  }

  Promise.resolve()
    .then(() => {
      const buckets = process.env.BUCKET_REGIONS
        .split(/, ?/)
        .filter((region) => region !== process.env.AWS_DEFAULT_REGION)
        .map((region) => `${process.env.BUCKET_PREFIX}-${region}`);

      const clones = event.Records.map((record) => {
        const src = new S3Object(
          record.s3.bucket.name,
          record.s3.object.key,
          record.awsRegion
        );

        const dsts = buckets.map((bucket) => new S3Object(
          bucket,
          record.s3.object.key,
          bucket.replace(`${process.env.BUCKET_PREFIX}-`, '')
        ));

        return Promise.all(dsts.map((dst) => src.copyTo(dst)));
      });

      return Promise.all(clones);
    })
    .then(() => callback())
    .catch((err) => callback(err));
};

module.exports = exported;
