'use strict';

/* eslint-disable no-console */

const fs = require('fs');
const path = require('path');
const test = require('tape');
const AWS = require('@mapbox/mock-aws-sdk-js');
const sinon = require('sinon');
const got = require('got');
const jwt = require('jsonwebtoken');
const env = require('./env');
const lambda = require('../lambda');

const nodejsBuildspec = fs.readFileSync(path.resolve(
  __dirname, '..', 'buildspecs', 'nodejs6.x.yml'
), 'utf8');

const nodejs4Buildspec = fs.readFileSync(path.resolve(
  __dirname, '..', 'buildspecs', 'nodejs4.3.yml'
), 'utf8');

const pythonBuildspec = fs.readFileSync(path.resolve(
  __dirname, '..', 'buildspecs', 'python2.7.yml'
), 'utf8');

const privateKey = fs.readFileSync(path.resolve(
  __dirname, 'fixtures', 'fake.pem'
), 'utf8');

const publicKey = fs.readFileSync(path.resolve(
  __dirname, 'fixtures', 'public.pem'
), 'utf8');

const triggerVars = {
  NPM_ACCESS_TOKEN: 'secure:d;alfsksadafwe',
  GITHUB_APP_ID: '54321',
  GITHUB_APP_INSTALLATION_ID: '1234567',
  GITHUB_APP_PRIVATE_KEY: `secure:${privateKey}`,
  AWS_ACCOUNT_ID: '123456789012',
  AWS_DEFAULT_REGION: 'us-east-1',
  S3_BUCKET: 'mapbox-us-east-1',
  S3_PREFIX: 'bundles',
  PROJECT_ROLE: 'arn:aws:iam:blah:blah:blah',
  STATUS_FUNCTION: 'arn:aws:lambda:blah:blah:blah',
  USE_OAUTH: 'true'
};

const statusVars = {
  GITHUB_APP_ID: '54321',
  GITHUB_APP_INSTALLATION_ID: '1234567',
  GITHUB_APP_PRIVATE_KEY: `secure:${privateKey}`
};

const forwaderVars = {
  BUCKET_PREFIX: 'mapbox',
  BUCKET_REGIONS: 'us-east-1,us-east-2,us-west-2',
  AWS_DEFAULT_REGION: 'us-east-1'
};

const fakeDecrypt = (env) => {
  for (const key in env) process.env[key] = env[key].replace('secure:', '');
  return Promise.resolve();
};

const fakeTriggerEvent = {
  Records: [
    {
      Sns: {
        Message: JSON.stringify({
          repository: { name: 'stork', owner: { name: 'mapbox' } },
          after: 'abcdefg'
        })
      }
    }
  ]
};

const fakeStatusEvent = {
  detail: {
    'build-id': 'build-id',
    'build-status': 'SUCCEEDED'
  }
};

const fakeForwarderEvent = {
  Records: [
    {
      s3: {
        bucket: { name: 'mapbox-us-east-1' },
        object: { key: 'bundles/6326c40b6c27c5e6dc3ed2a5d931d7e2bd94b01d.zip' }
      },
      awsRegion: 'us-east-1'
    }
  ]
};

test('[lambda] trigger: faillure to parse event', (assert) => {
  const event = 'not gonna happen';

  sinon.spy(console, 'log');

  lambda.trigger(event, {}, (err) => {
    assert.ifError(err, 'no error, event is ignored');

    assert.ok(
      console.log.calledWith('CANNOT PARSE Cannot read property \'0\' of undefined: "not gonna happen"'),
      'logs failure to parse event'
    );

    console.log.restore();
    assert.end();
  });
});

test('[lamdba] trigger: ignore events representing branch deletion', (assert) => {
  const event = {
    Records: [
      {
        Sns: {
          Message: JSON.stringify({
            deleted: true,
            after: '0000000000000000000000000000000000000000',
            repository: {
              name: 'fake',
              owner: { name: 'mapbox' }
            }
          })
        }
      }
    ]
  };

  sinon.spy(console, 'log');

  lambda.trigger(event, {}, (err) => {
    assert.ifError(err, 'success');
    assert.ok(console.log.calledWith('Ignoring branch deletion event'), 'logs info that an event was ignored');
    console.log.restore();
    assert.end();
  });
});

test('[lambda] trigger: catch decrypt errors', (assert) => {
  sinon.stub(lambda, 'decrypt').callsFake(() => Promise.reject(new Error('foo')));

  sinon.stub(got, 'post').callsFake(() => Promise.resolve());

  lambda.trigger(fakeTriggerEvent, {}, (err) => {
    assert.equal(err.message, 'foo', 'passes error to Lambda for logging');

    assert.equal(got.post.callCount, 0, 'cannot update status on github without decrypting env vars');

    lambda.decrypt.restore();
    got.post.restore();
    assert.end();
  });
});

test('[lambda] trigger: new project, no overrides', (assert) => {
  const environment = env(triggerVars).mock();

  sinon.stub(lambda, 'decrypt').callsFake(fakeDecrypt);

  sinon.stub(got, 'get')
    .onCall(0).callsFake(() => Promise.resolve())
    .onCall(1).callsFake(() => Promise.reject(new Error('404')))
    .onCall(2).callsFake(() => Promise.reject(new Error('404')));

  sinon.stub(got, 'post').callsFake(() => Promise.resolve({
    body: { token: 'v1.1f699f1069f60xxx' }
  }));

  const getProject = AWS.stub('CodeBuild', 'batchGetProjects', function() {
    this.request.promise.returns(Promise.resolve({ projects: [] }));
  });

  const makeLogs = AWS.stub('CloudWatchLogs', 'createLogGroup', function() {
    this.request.promise.returns(Promise.resolve());
  });

  const logRetention = AWS.stub('CloudWatchLogs', 'putRetentionPolicy', function() {
    this.request.promise.returns(Promise.resolve());
  });

  const newProject = AWS.stub('CodeBuild', 'createProject', function() {
    this.request.promise.returns(Promise.resolve({
      project: { project: 'data' }
    }));
  });

  const rule = AWS.stub('CloudWatchEvents', 'putRule', function() {
    this.request.promise.returns(Promise.resolve());
  });

  const targets = AWS.stub('CloudWatchEvents', 'putTargets', function() {
    this.request.promise.returns(Promise.resolve());
  });

  const runBuild = AWS.stub('CodeBuild', 'startBuild', function() {
    this.request.promise.returns(Promise.resolve({
      build: { build: 'data' }
    }));
  });

  lambda.trigger(fakeTriggerEvent, {}, (err) => {
    assert.ifError(err, 'success');

    assert.equal(process.env.GITHUB_APP_PRIVATE_KEY, privateKey, 'env triggerVars were decrypted');

    assert.equal(got.post.callCount, 1, '1 request for github credentials');

    const args = JSON.parse(JSON.stringify(got.post.args[0]));
    const auth = args[1].headers.Authorization.replace('Bearer ', '');
    const decoded = jwt.verify(auth, publicKey, { algorithms: ['RS256'] });
    assert.equal(decoded.iss, 54321, 'constructed valid jwt token using installationId and privateKey');

    delete args[1].headers.Authorization;
    assert.deepEqual(args, [
      'https://api.github.com/installations/1234567/access_tokens',
      {
        json: true,
        headers: {
          'User-Agent': 'github.com/mapbox/stork',
          Accept: 'application/vnd.github.machine-man-preview+json'
        }
      }
    ], 'made anticipated request for github app credentials');

    assert.equal(got.get.callCount, 3, '3 get requests to github api');
    assert.ok(
      got.get.calledWith(
        'https://api.github.com/app',
        {
          json: true,
          headers: {
            'User-Agent': 'github.com/mapbox/stork',
            Accept: 'application/vnd.github.machine-man-preview+json',
            Authorization: `Bearer ${auth}`
          }
        }
      ),
      'authenticated as the github app'
    );

    assert.ok(
      got.get.calledWith(
        'https://api.github.com/repos/mapbox/stork/contents/buildspec.yml?ref=abcdefg',
        {
          json: true,
          headers: {
            'User-Agent': 'github.com/mapbox/stork',
            Accept: 'application/vnd.github.machine-man-preview+json',
            Authorization: 'token v1.1f699f1069f60xxx'
          }
        }
      ),
      'looked for buildspec.yml'
    );
    assert.ok(
      got.get.calledWith(
        'https://api.github.com/repos/mapbox/stork/contents/.stork.json?ref=abcdefg',
        {
          json: true,
          headers: {
            'User-Agent': 'github.com/mapbox/stork',
            Accept: 'application/vnd.github.machine-man-preview+json',
            Authorization: 'token v1.1f699f1069f60xxx'
          }
        }
      ),
      'looked for .stork.json'
    );

    assert.equal(getProject.callCount, 1, 'one batchGetProjects request');
    assert.ok(
      getProject.calledWith({ names: ['mapbox_stork_nodejs6_x'] }),
      'looked for project by name'
    );

    assert.equal(makeLogs.callCount, 1, 'one createLogGroup request');
    assert.ok(
      makeLogs.calledWith({
        logGroupName: '/aws/codebuild/mapbox_stork_nodejs6_x'
      }),
      'creates a properly named log group for codebuild to use'
    );

    assert.equal(logRetention.callCount, 1, 'one putRetentionPolicy request');
    assert.ok(
      logRetention.calledWith({
        logGroupName: '/aws/codebuild/mapbox_stork_nodejs6_x',
        retentionInDays: 14
      }),
      'sets 14 day retention policy on the log group'
    );

    assert.equal(newProject.callCount, 1, 'one createProject request');
    assert.ok(
      newProject.calledWith({
        name: 'mapbox_stork_nodejs6_x',
        description: 'Lambda builds for mapbox/stork',
        serviceRole: 'arn:aws:iam:blah:blah:blah',
        source: {
          type: 'GITHUB',
          location: 'https://github.com/mapbox/stork',
          auth: { type: 'OAUTH' }
        },
        artifacts: {
          type: 'S3',
          packaging: 'ZIP',
          location: 'mapbox-us-east-1',
          path: 'bundles/stork'
        },
        environment: {
          type: 'LINUX_CONTAINER',
          image: '123456789012.dkr.ecr.us-east-1.amazonaws.com/stork:nodejs6.x',
          computeType: 'BUILD_GENERAL1_SMALL',
          environmentVariables: [
            { name: 'NPM_ACCESS_TOKEN', value: 'secure:d;alfsksadafwe' }
          ]
        }
      }),
      'created a new project with the appropriate properties'
    );

    assert.equal(rule.callCount, 1, 'one putRule request');
    assert.ok(
      rule.calledWith({
        Name: 'mapbox_stork_nodejs6_x',
        Description: 'Build status notifications for mapbox_stork_nodejs6_x',
        EventPattern: JSON.stringify({
          source: ['aws.codebuild'],
          'detail-type': ['CodeBuild Build State Change'],
          detail: {
            'build-status': ['IN_PROGRESS', 'SUCCEEDED', 'FAILED', 'STOPPED'],
            'project-name': ['mapbox_stork_nodejs6_x']
          }
        }),
        State: 'ENABLED'
      }),
      'created a new event rule to monitor builds'
    );

    assert.equal(targets.callCount, 1, 'one putTargets request');
    assert.ok(
      targets.calledWith({
        Rule: 'mapbox_stork_nodejs6_x',
        Targets: [
          { Id: 'invoke-lambda', Arn: 'arn:aws:lambda:blah:blah:blah' }
        ]
      }),
      'creates a target, executing the status lambda on build events'
    );

    assert.equal(runBuild.callCount, 1, 'one startBuild request');
    assert.ok(
      runBuild.calledWith({
        projectName: 'mapbox_stork_nodejs6_x',
        sourceVersion: 'abcdefg',
        artifactsOverride: {
          type: 'S3',
          packaging: 'ZIP',
          location: 'mapbox-us-east-1',
          path: 'bundles/stork',
          name: 'abcdefg.zip'
        },
        buildspecOverride: nodejsBuildspec
      }),
      'runs the expected build'
    );

    environment.restore();
    lambda.decrypt.restore();
    got.get.restore();
    got.post.restore();
    AWS.CodeBuild.restore();
    AWS.CloudWatchLogs.restore();
    AWS.CloudWatchEvents.restore();
    assert.end();
  });

});

test('[lambda] trigger: existing project, no overrides', (assert) => {
  const environment = env(triggerVars).mock();

  sinon.stub(lambda, 'decrypt').callsFake(fakeDecrypt);

  sinon.stub(got, 'get')
    .onCall(0).callsFake(() => Promise.resolve())
    .onCall(1).callsFake(() => Promise.reject(new Error('404')))
    .onCall(2).callsFake(() => Promise.reject(new Error('404')));

  sinon.stub(got, 'post').callsFake(() => Promise.resolve({
    body: { token: 'v1.1f699f1069f60xxx' }
  }));

  const getProject = AWS.stub('CodeBuild', 'batchGetProjects', function() {
    this.request.promise.returns(Promise.resolve({
      projects: [{ name: 'mapbox_stork_nodejs6_x' }]
    }));
  });

  const makeLogs = AWS.stub('CloudWatchLogs', 'createLogGroup', function() {
    this.request.promise.returns(Promise.resolve());
  });

  const logRetention = AWS.stub('CloudWatchLogs', 'putRetentionPolicy', function() {
    this.request.promise.returns(Promise.resolve());
  });

  const newProject = AWS.stub('CodeBuild', 'createProject', function() {
    this.request.promise.returns(Promise.resolve({
      project: { project: 'data' }
    }));
  });

  const rule = AWS.stub('CloudWatchEvents', 'putRule', function() {
    this.request.promise.returns(Promise.resolve());
  });

  const targets = AWS.stub('CloudWatchEvents', 'putTargets', function() {
    this.request.promise.returns(Promise.resolve());
  });

  const runBuild = AWS.stub('CodeBuild', 'startBuild', function() {
    this.request.promise.returns(Promise.resolve({
      build: { build: 'data' }
    }));
  });

  lambda.trigger(fakeTriggerEvent, {}, (err) => {
    assert.ifError(err, 'success');

    assert.equal(got.get.callCount, 3, '3 get requests to github api');
    assert.equal(got.post.callCount, 1, '1 post request to github api');
    assert.equal(getProject.callCount, 1, 'one batchGetProjects request');
    assert.equal(makeLogs.callCount, 0, 'no createLogGroup requests');
    assert.equal(logRetention.callCount, 0, 'no putRetentionPolicy requests');
    assert.equal(newProject.callCount, 0, 'no createProject requests');
    assert.equal(rule.callCount, 0, 'no putRule requests');
    assert.equal(targets.callCount, 0, 'no putTargets requests');
    assert.equal(runBuild.callCount, 1, 'one startBuild request');

    assert.ok(
      runBuild.calledWith({
        projectName: 'mapbox_stork_nodejs6_x',
        sourceVersion: 'abcdefg',
        artifactsOverride: {
          type: 'S3',
          packaging: 'ZIP',
          location: 'mapbox-us-east-1',
          path: 'bundles/stork',
          name: 'abcdefg.zip'
        },
        buildspecOverride: nodejsBuildspec
      }),
      'runs the expected build'
    );

    environment.restore();
    lambda.decrypt.restore();
    got.get.restore();
    got.post.restore();
    AWS.CodeBuild.restore();
    AWS.CloudWatchLogs.restore();
    AWS.CloudWatchEvents.restore();
    assert.end();
  });
});

test('[lambda] trigger: new project, image override [python2.7]', (assert) => {
  const environment = env(triggerVars).mock();

  sinon.stub(lambda, 'decrypt').callsFake(fakeDecrypt);

  sinon.stub(got, 'get').callsFake((uri) => {
    if (/.stork.json/.test(uri)) return Promise.resolve({
      body: {
        type: 'file',
        content: JSON.stringify({ image: 'python2.7' }),
        encoding: 'utf8'
      }
    });
    return Promise.reject(new Error('404'));
  }).onCall(0).callsFake(() => Promise.resolve());

  sinon.stub(got, 'post').callsFake(() => Promise.resolve({
    body: { token: 'v1.1f699f1069f60xxx' }
  }));

  const getProject = AWS.stub('CodeBuild', 'batchGetProjects', function() {
    this.request.promise.returns(Promise.resolve({
      projects: []
    }));
  });

  const makeLogs = AWS.stub('CloudWatchLogs', 'createLogGroup', function() {
    this.request.promise.returns(Promise.resolve());
  });

  const logRetention = AWS.stub('CloudWatchLogs', 'putRetentionPolicy', function() {
    this.request.promise.returns(Promise.resolve());
  });

  const newProject = AWS.stub('CodeBuild', 'createProject', function() {
    this.request.promise.returns(Promise.resolve({
      project: { project: 'data' }
    }));
  });

  const rule = AWS.stub('CloudWatchEvents', 'putRule', function() {
    this.request.promise.returns(Promise.resolve());
  });

  const targets = AWS.stub('CloudWatchEvents', 'putTargets', function() {
    this.request.promise.returns(Promise.resolve());
  });

  const runBuild = AWS.stub('CodeBuild', 'startBuild', function() {
    this.request.promise.returns(Promise.resolve({
      build: { build: 'data' }
    }));
  });

  lambda.trigger(fakeTriggerEvent, {}, (err) => {
    assert.ifError(err, 'success');

    assert.equal(got.get.callCount, 3, '3 get requests to github api');
    assert.equal(got.post.callCount, 1, '1 post request to github api');
    assert.equal(getProject.callCount, 1, 'one batchGetProjects request');
    assert.equal(makeLogs.callCount, 1, 'no createLogGroup requests');
    assert.equal(logRetention.callCount, 1, 'no putRetentionPolicy requests');
    assert.equal(newProject.callCount, 1, 'no createProject requests');
    assert.equal(rule.callCount, 1, 'no putRule requests');
    assert.equal(targets.callCount, 1, 'no putTargets requests');
    assert.equal(runBuild.callCount, 1, 'one startBuild request');

    assert.ok(
      newProject.calledWith({
        name: 'mapbox_stork_python2_7',
        description: 'Lambda builds for mapbox/stork',
        serviceRole: 'arn:aws:iam:blah:blah:blah',
        source: {
          type: 'GITHUB',
          location: 'https://github.com/mapbox/stork',
          auth: { type: 'OAUTH' }
        },
        artifacts: {
          type: 'S3',
          packaging: 'ZIP',
          location: 'mapbox-us-east-1',
          path: 'bundles/stork'
        },
        environment: {
          type: 'LINUX_CONTAINER',
          image: '123456789012.dkr.ecr.us-east-1.amazonaws.com/stork:python2.7',
          computeType: 'BUILD_GENERAL1_SMALL',
          environmentVariables: [
            { name: 'NPM_ACCESS_TOKEN', value: 'secure:d;alfsksadafwe' }
          ]
        }
      }),
      'created a new project with the appropriate properties'
    );

    assert.ok(
      runBuild.calledWith({
        projectName: 'mapbox_stork_python2_7',
        sourceVersion: 'abcdefg',
        artifactsOverride: {
          type: 'S3',
          packaging: 'ZIP',
          location: 'mapbox-us-east-1',
          path: 'bundles/stork',
          name: 'abcdefg.zip'
        },
        buildspecOverride: pythonBuildspec
      }),
      'runs the expected build'
    );

    environment.restore();
    lambda.decrypt.restore();
    got.get.restore();
    got.post.restore();
    AWS.CodeBuild.restore();
    AWS.CloudWatchLogs.restore();
    AWS.CloudWatchEvents.restore();
    assert.end();
  });
});

test('[lambda] trigger: new project, image override [nodejs4.3]', (assert) => {
  const environment = env(triggerVars).mock();

  sinon.stub(lambda, 'decrypt').callsFake(fakeDecrypt);

  sinon.stub(got, 'get').callsFake((uri) => {
    if (/.stork.json/.test(uri)) return Promise.resolve({
      body: {
        type: 'file',
        content: JSON.stringify({ image: 'nodejs4.3' }),
        encoding: 'utf8'
      }
    });
    return Promise.reject(new Error('404'));
  }).onCall(0).callsFake(() => Promise.resolve());

  sinon.stub(got, 'post').callsFake(() => Promise.resolve({
    body: { token: 'v1.1f699f1069f60xxx' }
  }));

  const getProject = AWS.stub('CodeBuild', 'batchGetProjects', function() {
    this.request.promise.returns(Promise.resolve({
      projects: []
    }));
  });

  const makeLogs = AWS.stub('CloudWatchLogs', 'createLogGroup', function() {
    this.request.promise.returns(Promise.resolve());
  });

  const logRetention = AWS.stub('CloudWatchLogs', 'putRetentionPolicy', function() {
    this.request.promise.returns(Promise.resolve());
  });

  const newProject = AWS.stub('CodeBuild', 'createProject', function() {
    this.request.promise.returns(Promise.resolve({
      project: { project: 'data' }
    }));
  });

  const rule = AWS.stub('CloudWatchEvents', 'putRule', function() {
    this.request.promise.returns(Promise.resolve());
  });

  const targets = AWS.stub('CloudWatchEvents', 'putTargets', function() {
    this.request.promise.returns(Promise.resolve());
  });

  const runBuild = AWS.stub('CodeBuild', 'startBuild', function() {
    this.request.promise.returns(Promise.resolve({
      build: { build: 'data' }
    }));
  });

  lambda.trigger(fakeTriggerEvent, {}, (err) => {
    assert.ifError(err, 'success');

    assert.equal(got.get.callCount, 3, '3 get requests to github api');
    assert.equal(got.post.callCount, 1, '1 post request to github api');
    assert.equal(getProject.callCount, 1, 'one batchGetProjects request');
    assert.equal(makeLogs.callCount, 1, 'no createLogGroup requests');
    assert.equal(logRetention.callCount, 1, 'no putRetentionPolicy requests');
    assert.equal(newProject.callCount, 1, 'no createProject requests');
    assert.equal(rule.callCount, 1, 'no putRule requests');
    assert.equal(targets.callCount, 1, 'no putTargets requests');
    assert.equal(runBuild.callCount, 1, 'one startBuild request');

    assert.ok(
      newProject.calledWith({
        name: 'mapbox_stork_nodejs4_3',
        description: 'Lambda builds for mapbox/stork',
        serviceRole: 'arn:aws:iam:blah:blah:blah',
        source: {
          type: 'GITHUB',
          location: 'https://github.com/mapbox/stork',
          auth: { type: 'OAUTH' }
        },
        artifacts: {
          type: 'S3',
          packaging: 'ZIP',
          location: 'mapbox-us-east-1',
          path: 'bundles/stork'
        },
        environment: {
          type: 'LINUX_CONTAINER',
          image: '123456789012.dkr.ecr.us-east-1.amazonaws.com/stork:nodejs4.3',
          computeType: 'BUILD_GENERAL1_SMALL',
          environmentVariables: [
            { name: 'NPM_ACCESS_TOKEN', value: 'secure:d;alfsksadafwe' }
          ]
        }
      }),
      'created a new project with the appropriate properties'
    );

    assert.ok(
      runBuild.calledWith({
        projectName: 'mapbox_stork_nodejs4_3',
        sourceVersion: 'abcdefg',
        artifactsOverride: {
          type: 'S3',
          packaging: 'ZIP',
          location: 'mapbox-us-east-1',
          path: 'bundles/stork',
          name: 'abcdefg.zip'
        },
        buildspecOverride: nodejs4Buildspec
      }),
      'runs the expected build'
    );

    environment.restore();
    lambda.decrypt.restore();
    got.get.restore();
    got.post.restore();
    AWS.CodeBuild.restore();
    AWS.CloudWatchLogs.restore();
    AWS.CloudWatchEvents.restore();
    assert.end();
  });
});

test('[lambda] trigger: new project, image, buildspec, size override', (assert) => {
  const environment = env(triggerVars).mock();

  sinon.stub(lambda, 'decrypt').callsFake(fakeDecrypt);

  sinon.stub(got, 'get').callsFake((uri) => {
    if (/.stork.json/.test(uri)) return Promise.resolve({
      body: {
        type: 'file',
        content: JSON.stringify({ image: 'python2.7', size: 'large' }),
        encoding: 'utf8'
      }
    });
    if (/buildspec.yml/.test(uri)) return Promise.resolve({
      body: {
        type: 'file',
        content: 'hibbity haw',
        encoding: 'utf8'
      }
    });
    return Promise.reject(new Error('404'));
  }).onCall(0).callsFake(() => Promise.resolve());

  sinon.stub(got, 'post').callsFake(() => Promise.resolve({
    body: { token: 'v1.1f699f1069f60xxx' }
  }));

  const getProject = AWS.stub('CodeBuild', 'batchGetProjects', function() {
    this.request.promise.returns(Promise.resolve({
      projects: []
    }));
  });

  const makeLogs = AWS.stub('CloudWatchLogs', 'createLogGroup', function() {
    this.request.promise.returns(Promise.resolve());
  });

  const logRetention = AWS.stub('CloudWatchLogs', 'putRetentionPolicy', function() {
    this.request.promise.returns(Promise.resolve());
  });

  const newProject = AWS.stub('CodeBuild', 'createProject', function() {
    this.request.promise.returns(Promise.resolve({
      project: { project: 'data' }
    }));
  });

  const rule = AWS.stub('CloudWatchEvents', 'putRule', function() {
    this.request.promise.returns(Promise.resolve());
  });

  const targets = AWS.stub('CloudWatchEvents', 'putTargets', function() {
    this.request.promise.returns(Promise.resolve());
  });

  const runBuild = AWS.stub('CodeBuild', 'startBuild', function() {
    this.request.promise.returns(Promise.resolve({
      build: { build: 'data' }
    }));
  });

  lambda.trigger(fakeTriggerEvent, {}, (err) => {
    assert.ifError(err, 'success');

    assert.equal(got.get.callCount, 3, '3 get requests to github api');
    assert.equal(got.post.callCount, 1, '1 post request to github api');
    assert.equal(getProject.callCount, 1, 'one batchGetProjects request');
    assert.equal(makeLogs.callCount, 1, 'no createLogGroup requests');
    assert.equal(logRetention.callCount, 1, 'no putRetentionPolicy requests');
    assert.equal(newProject.callCount, 1, 'no createProject requests');
    assert.equal(rule.callCount, 1, 'no putRule requests');
    assert.equal(targets.callCount, 1, 'no putTargets requests');
    assert.equal(runBuild.callCount, 1, 'one startBuild request');

    assert.ok(
      newProject.calledWith({
        name: 'mapbox_stork_python2_7',
        description: 'Lambda builds for mapbox/stork',
        serviceRole: 'arn:aws:iam:blah:blah:blah',
        source: {
          type: 'GITHUB',
          location: 'https://github.com/mapbox/stork',
          auth: { type: 'OAUTH' }
        },
        artifacts: {
          type: 'S3',
          packaging: 'ZIP',
          location: 'mapbox-us-east-1',
          path: 'bundles/stork'
        },
        environment: {
          type: 'LINUX_CONTAINER',
          image: '123456789012.dkr.ecr.us-east-1.amazonaws.com/stork:python2.7',
          computeType: 'BUILD_GENERAL1_LARGE',
          environmentVariables: [
            { name: 'NPM_ACCESS_TOKEN', value: 'secure:d;alfsksadafwe' }
          ]
        }
      }),
      'created a new project with the appropriate properties'
    );

    assert.ok(
      runBuild.calledWith({
        projectName: 'mapbox_stork_python2_7',
        sourceVersion: 'abcdefg',
        artifactsOverride: {
          type: 'S3',
          packaging: 'ZIP',
          location: 'mapbox-us-east-1',
          path: 'bundles/stork',
          name: 'abcdefg.zip'
        }
      }),
      'runs the expected build, inheriting buildspec.yml from the repo'
    );

    environment.restore();
    lambda.decrypt.restore();
    got.get.restore();
    got.post.restore();
    AWS.CodeBuild.restore();
    AWS.CloudWatchLogs.restore();
    AWS.CloudWatchEvents.restore();
    assert.end();
  });
});

test('[lambda] trigger: existing project, same overrides', (assert) => {
  const environment = env(triggerVars).mock();

  sinon.stub(lambda, 'decrypt').callsFake(fakeDecrypt);

  sinon.stub(got, 'get').callsFake((uri) => {
    if (/.stork.json/.test(uri)) return Promise.resolve({
      body: {
        type: 'file',
        content: JSON.stringify({ image: 'python2.7' }),
        encoding: 'utf8'
      }
    });
    return Promise.reject(new Error('404'));
  }).onCall(0).callsFake(() => Promise.resolve());

  sinon.stub(got, 'post').callsFake(() => Promise.resolve({
    body: { token: 'v1.1f699f1069f60xxx' }
  }));

  const getProject = AWS.stub('CodeBuild', 'batchGetProjects', function() {
    this.request.promise.returns(Promise.resolve({
      projects: [{ name: 'mapbox_stork_python2_7' }]
    }));
  });

  const makeLogs = AWS.stub('CloudWatchLogs', 'createLogGroup', function() {
    this.request.promise.returns(Promise.resolve());
  });

  const logRetention = AWS.stub('CloudWatchLogs', 'putRetentionPolicy', function() {
    this.request.promise.returns(Promise.resolve());
  });

  const newProject = AWS.stub('CodeBuild', 'createProject', function() {
    this.request.promise.returns(Promise.resolve({
      project: { project: 'data' }
    }));
  });

  const rule = AWS.stub('CloudWatchEvents', 'putRule', function() {
    this.request.promise.returns(Promise.resolve());
  });

  const targets = AWS.stub('CloudWatchEvents', 'putTargets', function() {
    this.request.promise.returns(Promise.resolve());
  });

  const runBuild = AWS.stub('CodeBuild', 'startBuild', function() {
    this.request.promise.returns(Promise.resolve({
      build: { build: 'data' }
    }));
  });

  lambda.trigger(fakeTriggerEvent, {}, (err) => {
    assert.ifError(err, 'success');

    assert.equal(got.get.callCount, 3, '3 get requests to github api');
    assert.equal(got.post.callCount, 1, '1 post request to github api');
    assert.equal(getProject.callCount, 1, 'one batchGetProjects request');
    assert.equal(makeLogs.callCount, 0, 'no createLogGroup requests');
    assert.equal(logRetention.callCount, 0, 'no putRetentionPolicy requests');
    assert.equal(newProject.callCount, 0, 'no createProject requests');
    assert.equal(rule.callCount, 0, 'no putRule requests');
    assert.equal(targets.callCount, 0, 'no putTargets requests');
    assert.equal(runBuild.callCount, 1, 'one startBuild request');

    assert.ok(
      runBuild.calledWith({
        projectName: 'mapbox_stork_python2_7',
        sourceVersion: 'abcdefg',
        artifactsOverride: {
          type: 'S3',
          packaging: 'ZIP',
          location: 'mapbox-us-east-1',
          path: 'bundles/stork',
          name: 'abcdefg.zip'
        },
        buildspecOverride: pythonBuildspec
      }),
      'runs the expected build'
    );

    environment.restore();
    lambda.decrypt.restore();
    got.get.restore();
    got.post.restore();
    AWS.CodeBuild.restore();
    AWS.CloudWatchLogs.restore();
    AWS.CloudWatchEvents.restore();
    assert.end();
  });
});

test('[lambda] trigger: rate-limiting failure', (assert) => {
  const environment = env(triggerVars).mock();

  sinon.stub(lambda, 'decrypt').callsFake(fakeDecrypt);

  sinon.stub(got, 'get')
    .onCall(0).callsFake(() => Promise.resolve())
    .onCall(1).callsFake(() => Promise.reject(new Error('404')))
    .onCall(2).callsFake(() => Promise.reject(new Error('404')));

  sinon.stub(got, 'post').callsFake(() => Promise.resolve({
    body: { token: 'v1.1f699f1069f60xxx' }
  }));

  const getProject = AWS.stub('CodeBuild', 'batchGetProjects', function() {
    this.request.promise.returns(Promise.resolve({
      projects: [{ name: 'mapbox_stork_nodejs6_x' }]
    }));
  });

  const makeLogs = AWS.stub('CloudWatchLogs', 'createLogGroup', function() {
    this.request.promise.returns(Promise.resolve());
  });

  const logRetention = AWS.stub('CloudWatchLogs', 'putRetentionPolicy', function() {
    this.request.promise.returns(Promise.resolve());
  });

  const newProject = AWS.stub('CodeBuild', 'createProject', function() {
    this.request.promise.returns(Promise.resolve({
      project: { project: 'data' }
    }));
  });

  const rule = AWS.stub('CloudWatchEvents', 'putRule', function() {
    this.request.promise.returns(Promise.resolve());
  });

  const targets = AWS.stub('CloudWatchEvents', 'putTargets', function() {
    this.request.promise.returns(Promise.resolve());
  });

  const runBuild = AWS.stub('CodeBuild', 'startBuild', function() {
    const err = new Error('Cannot have more than 20 active builds for the account');
    err.code = 'AccountLimitExceededException';
    this.request.promise = () => Promise.reject(err);
  });

  lambda.trigger(fakeTriggerEvent, {}, (err) => {
    assert.equal(
      err.message,
      'You have reached your AWS CodeBuild concurrency limit. Contact AWS to increase this limit.',
      'passes through error message'
    );

    assert.equal(got.get.callCount, 3, '3 get requests to github api');
    assert.equal(got.post.callCount, 2, '2 post requests to github api');
    assert.equal(getProject.callCount, 1, 'one batchGetProjects request');
    assert.equal(makeLogs.callCount, 0, 'no createLogGroup requests');
    assert.equal(logRetention.callCount, 0, 'no putRetentionPolicy requests');
    assert.equal(newProject.callCount, 0, 'no createProject requests');
    assert.equal(rule.callCount, 0, 'no putRule requests');
    assert.equal(targets.callCount, 0, 'no putTargets requests');
    assert.equal(runBuild.callCount, 1, 'one startBuild request');

    assert.ok(
      got.post.calledWith(
        'https://api.github.com/repos/mapbox/stork/statuses/abcdefg',
        {
          json: true,
          headers: {
            'Content-type': 'application/json',
            'User-Agent': 'github.com/mapbox/stork',
            Authorization: 'token v1.1f699f1069f60xxx',
            Accept: 'application/vnd.github.machine-man-preview+json'
          },
          body: JSON.stringify({
            context: 'stork',
            description: 'You have reached your AWS CodeBuild concurrency limit. Contact AWS to increase this limit.',
            state: 'failure'
          })
        }
      ),
      'sent failed build status update to github'
    );

    environment.restore();
    lambda.decrypt.restore();
    got.get.restore();
    got.post.restore();
    AWS.CodeBuild.restore();
    AWS.CloudWatchLogs.restore();
    AWS.CloudWatchEvents.restore();
    assert.end();
  });
});

test('[lambda] trigger: unexpected failure', (assert) => {
  const environment = env(triggerVars).mock();

  sinon.stub(lambda, 'decrypt').callsFake(fakeDecrypt);

  sinon.stub(got, 'get')
    .onCall(0).callsFake(() => Promise.resolve())
    .onCall(1).callsFake(() => Promise.reject(new Error('404')))
    .onCall(2).callsFake(() => Promise.reject(new Error('404')));

  sinon.stub(got, 'post').callsFake(() => Promise.resolve({
    body: { token: 'v1.1f699f1069f60xxx' }
  }));

  const getProject = AWS.stub('CodeBuild', 'batchGetProjects', function() {
    this.request.promise.returns(Promise.resolve({
      projects: [{ name: 'mapbox_stork_nodejs6_x' }]
    }));
  });

  const makeLogs = AWS.stub('CloudWatchLogs', 'createLogGroup', function() {
    this.request.promise.returns(Promise.resolve());
  });

  const logRetention = AWS.stub('CloudWatchLogs', 'putRetentionPolicy', function() {
    this.request.promise.returns(Promise.resolve());
  });

  const newProject = AWS.stub('CodeBuild', 'createProject', function() {
    this.request.promise.returns(Promise.resolve({
      project: { project: 'data' }
    }));
  });

  const rule = AWS.stub('CloudWatchEvents', 'putRule', function() {
    this.request.promise.returns(Promise.resolve());
  });

  const targets = AWS.stub('CloudWatchEvents', 'putTargets', function() {
    this.request.promise.returns(Promise.resolve());
  });

  const runBuild = AWS.stub('CodeBuild', 'startBuild', function() {
    const err = new Error('foo');
    this.request.promise = () => Promise.reject(err);
  });

  lambda.trigger(fakeTriggerEvent, {}, (err) => {
    assert.equal(err.message, 'foo', 'passes through error message');

    assert.equal(got.get.callCount, 3, '3 get requests to github api');
    assert.equal(got.post.callCount, 2, '2 post requests to github api');
    assert.equal(getProject.callCount, 1, 'one batchGetProjects request');
    assert.equal(makeLogs.callCount, 0, 'no createLogGroup requests');
    assert.equal(logRetention.callCount, 0, 'no putRetentionPolicy requests');
    assert.equal(newProject.callCount, 0, 'no createProject requests');
    assert.equal(rule.callCount, 0, 'no putRule requests');
    assert.equal(targets.callCount, 0, 'no putTargets requests');
    assert.equal(runBuild.callCount, 1, 'one startBuild request');

    assert.ok(
      got.post.calledWith(
        'https://api.github.com/repos/mapbox/stork/statuses/abcdefg',
        {
          json: true,
          headers: {
            'Content-type': 'application/json',
            'User-Agent': 'github.com/mapbox/stork',
            Authorization: 'token v1.1f699f1069f60xxx',
            Accept: 'application/vnd.github.machine-man-preview+json'
          },
          body: JSON.stringify({
            context: 'stork',
            description: 'Stork failed to start your build',
            state: 'failure'
          })
        }
      ),
      'sent failed build status update to github, hid error message'
    );

    environment.restore();
    lambda.decrypt.restore();
    got.get.restore();
    got.post.restore();
    AWS.CodeBuild.restore();
    AWS.CloudWatchLogs.restore();
    AWS.CloudWatchEvents.restore();
    assert.end();
  });
});

test('[lambda] status: id for non-existent build', (assert) => {
  const environment = env(statusVars).mock();

  sinon.stub(lambda, 'decrypt').callsFake(fakeDecrypt);

  sinon.stub(got, 'get').callsFake(() => Promise.resolve());

  sinon.stub(got, 'post').callsFake(() => Promise.resolve({
    body: { token: 'v1.1f699f1069f60xxx' }
  }));

  const getBuild = AWS.stub('CodeBuild', 'batchGetBuilds', function() {
    this.request.promise.returns(Promise.resolve({ builds: [] }));
  });

  lambda.status(fakeStatusEvent, {}, (err) => {
    assert.ifError(err, 'successfully ignored');

    assert.equal(process.env.GITHUB_APP_PRIVATE_KEY, privateKey, 'env triggerVars were decrypted');

    assert.equal(getBuild.callCount, 1, 'one batchGetBuilds request');
    assert.ok(
      getBuild.calledWith({ ids: ['build-id'] }),
      'looks for build by ID in the invocation event'
    );

    environment.restore();
    lambda.decrypt.restore();
    got.get.restore();
    got.post.restore();
    AWS.CodeBuild.restore();
    assert.end();
  });
});

test('[lambda] status: success', (assert) => {
  const environment = env(statusVars).mock();

  sinon.stub(lambda, 'decrypt').callsFake(fakeDecrypt);

  const getBuild = AWS.stub('CodeBuild', 'batchGetBuilds', function() {
    this.request.promise.returns(Promise.resolve({
      builds: [
        {
          logs: { deepLink: 'url for cloudwatch logs' },
          sourceVersion: 'abcdefg',
          source: { location: 'https://github.com/mapbox/stork' }
        }
      ]
    }));
  });

  sinon.stub(got, 'get').callsFake(() => Promise.resolve());

  sinon.stub(got, 'post')
    .onCall(0).callsFake(() => Promise.resolve({
      body: { token: 'v1.1f699f1069f60xxx' }
    }))
    .onCall(1).callsFake(() => Promise.resolve());

  lambda.status(fakeStatusEvent, {}, (err) => {
    assert.ifError(err, 'success');

    assert.equal(getBuild.callCount, 1, 'one batchGetBuilds request');
    assert.ok(
      getBuild.calledWith({ ids: ['build-id'] }),
      'looks for build by ID in the invocation event'
    );

    assert.equal(got.post.callCount, 2, 'two github post requests');

    const args = JSON.parse(JSON.stringify(got.post.args[0]));
    const auth = args[1].headers.Authorization.replace('Bearer ', '');
    const decoded = jwt.verify(auth, publicKey, { algorithms: ['RS256'] });
    assert.equal(decoded.iss, 54321, 'constructed valid jwt token using installationId and privateKey');

    delete args[1].headers.Authorization;
    assert.deepEqual(args, [
      'https://api.github.com/installations/1234567/access_tokens',
      {
        json: true,
        headers: {
          'User-Agent': 'github.com/mapbox/stork',
          Accept: 'application/vnd.github.machine-man-preview+json'
        }
      }
    ], 'made anticipated request for github app credentials');

    assert.ok(
      got.post.calledWith(
        'https://api.github.com/repos/mapbox/stork/statuses/abcdefg',
        {
          json: true,
          headers: {
            'Content-type': 'application/json',
            'User-Agent': 'github.com/mapbox/stork',
            Accept: 'application/vnd.github.machine-man-preview+json',
            Authorization: 'token v1.1f699f1069f60xxx'
          },
          body: JSON.stringify({
            context: 'stork',
            description: 'Your build succeeded',
            state: 'success',
            target_url: 'url for cloudwatch logs'
          })
        }
      ),
      'sets PR status via github api request'
    );

    assert.equal(got.get.callCount, 1, '1 get request to github api');
    assert.ok(
      got.get.calledWith(
        'https://api.github.com/app',
        {
          json: true,
          headers: {
            'User-Agent': 'github.com/mapbox/stork',
            Accept: 'application/vnd.github.machine-man-preview+json',
            Authorization: `Bearer ${auth}`
          }
        }
      ),
      'authenticated as the github app'
    );

    environment.restore();
    got.get.restore();
    got.post.restore();
    lambda.decrypt.restore();
    AWS.CodeBuild.restore();
    assert.end();
  });
});

test('[lambda] forwarder: success', (assert) => {
  const environment = env(forwaderVars).mock();

  const copy = AWS.stub('S3', 'copyObject', function() {
    this.request.promise.returns(Promise.resolve());
  });

  lambda.forwarder(fakeForwarderEvent, {}, (err) => {
    assert.ifError(err, 'success');

    assert.equal(copy.callCount, 2, 'copied to 2 regions, ignoring primary');
    assert.ok(
      copy.calledWith({
        CopySource: '/mapbox-us-east-1/bundles/6326c40b6c27c5e6dc3ed2a5d931d7e2bd94b01d.zip',
        Bucket: 'mapbox-us-east-2',
        Key: 'bundles/6326c40b6c27c5e6dc3ed2a5d931d7e2bd94b01d.zip'
      }),
      'copied bundle to us-east-2'
    );
    assert.ok(
      copy.calledWith({
        CopySource: '/mapbox-us-east-1/bundles/6326c40b6c27c5e6dc3ed2a5d931d7e2bd94b01d.zip',
        Bucket: 'mapbox-us-west-2',
        Key: 'bundles/6326c40b6c27c5e6dc3ed2a5d931d7e2bd94b01d.zip'
      }),
      'copied bundle to us-west-2'
    );

    environment.restore();
    AWS.S3.restore();
    assert.end();
  });
});

test('[lambda] forwarder: one-region failure', (assert) => {
  const environment = env(forwaderVars).mock();

  AWS.stub('S3', 'copyObject', function(params) {
    if (params.Bucket === 'mapbox-us-east-2')
      this.request.promise.returns(Promise.resolve());
    else
      this.request.promise = () => Promise.reject(new Error('foo'));
  });

  lambda.forwarder(fakeForwarderEvent, {}, (err) => {
    assert.equal(err.message, 'foo', 'passes through error, resulting in a lambda retry');

    environment.restore();
    AWS.S3.restore();
    assert.end();
  });
});

test('[lambda] gatekeeper', (assert) => {
  const environment = env({
    GITHUB_APP_INSTALLATION_ID: '54321',
    GITHUB_ACCESS_TOKEN: 'secure:abcdefg'
  }).mock();

  sinon.stub(lambda, 'decrypt').callsFake(fakeDecrypt);

  sinon.stub(got, 'put').callsFake(() => Promise.resolve());

  const event = { repoId: 1234 };

  lambda.gatekeeper(event, {}, (err) => {
    assert.ifError(err, 'success');

    assert.ok(
      got.put.calledWith(
        'https://api.github.com/user/installations/54321/repositories/1234?access_token=abcdefg',
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

    environment.restore();
    lambda.decrypt.restore();
    got.put.restore();
    assert.end();
  });
});
