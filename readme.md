# stork

[![Build Status](https://travis-ci.org/mapbox/stork.svg?branch=master)](https://travis-ci.org/mapbox/stork)

## About

Stork is a continuous integration system that runs on AWS CodeBuild. Its primary usage is to build `.zip` bundles for use in Lambda functions each time a commit is pushed to a Github repository. It can also be used as a more generic tool for running a CodeBuild project on each commit.

## Usage

These instructions spell out how to use stork bundles from the application developer's perspective. They depend on there already being a stork stack running in your AWS account. To learn about how to bootstrap a stork stack, please see [these docs instead](./docs/setting-up-a-stork-service.md).

### Ask stork to watch your repository

There are several pieces of information that need to be collected prior to configuring a repository to be watched by stork. At Mapbox, we've written an internal CLI tool that knows these values for our account, and configures the repository for our production stork stack. If you're a Mapbox employee, please refer to mbxcli documentation.

Stork provides a Node.js function and a CLI tool that can be used to set this up if you've gathered the following information:

- **The region** that your account's stork stack runs in
- **The suffix** of your account's stork stack, as in `the stork-${sufffix} stack`.
- **Your personal access token** which will be used to make github requests to configure the repository for stork to watch.
- **The org name** of the repository you wish stork to watch
- **The repository name** for stork to watch

The Github token provided here must have the following scopes:
- `user`: for adding the repository to your stork github app
- `repo`: for reading repository data
- `admin:repo_hook`: for adding the webhook to the repository

The token will only be used once to set up webhooks, and after that you can delete the token if you wish.

With those information in hand, you can chose to configure stork to watch your repository using either a CLI command or by writing a Node.js script.

The following examples connects `my-repo` owned by `mapbox` to a `production` stork stack in `us-east-1`:

**via CLI**

```
$ ./bin/hook.js \
>   --regions us-east-1 \
>   --suffix production \
>   --org mapbox \
>   --repo my-repo \
>   --token xxx
>   --installation 12345
```

**via Node.js**

```js
const hook = require('stork').setupHook;

const options = {
  region: 'us-east-1',
  suffix: 'production',
  token: 'xxx',
  org: 'mapbox',
  repo: 'my-repo',
  installation: 12345
};

hook(options)
  .then(() => console.log('Linked to webhooks in us-east-1'));
```

### Using the Lambda bundles stork created

A running stork stack is configured to write `.zip` files to a specific S3 bucket and prefix. For example, if the stork stack writes to `my-bucket` and `my-bundles`, and you were to make a commit to `my-repo` with a SHA of `abc`, then the bundle will be located at:

```
s3://my-bucket/my-bundles/my-repo/abc.zip
```

Each time you push a commit to `my-repo`, another `.zip` file will be written with the commit's SHA. This predictable naming scheme helps you manage Lambda functions defined in CloudFormation templates, where the Lambda function code might change from commit to commit.

### Stork's default environment

By default, stork will try and bundle your application assuming it will be running on a Lambda function on the `nodejs6.10` runtime. If this is true, then no further configuration on your part is required.

**Note**: Stork uses npm v5.3.0 to install your libraries' `--production` dependencies. If your repository includes a `package-lock.json` file, it will be respected during bundling.

### Building a bundle for a different Lambda runtime

There are four base images provided by stork. These correspond directly to Lambda runtime environments and are meant to reproduce that runtime environment.

- `nodejs6.x` (default)
- `nodejs4.3`
- `python2.7`
- `python3.6`

For each of these environments, see the related Dockerfile in the `Dockerfiles` folder for the specifics of the build environment. Furthermore, the respective `.yml` files in the `buildspces` folder define the steps that will be taken to bundle your repository.

If you wish to build bundles for a runtime other than `nodejs6.10`, follow these steps:

1. Include a `.stork.json` file at the top-level of your repository
2. The file should be a JSON object, and the `image` property should indicate which of the stork images to use.

Here's an example `.stork.json` file to bundle an application intended for the `python2.7` Lambda runtime:

```json
{
  "image": "python2.7"
}
```

### Deeper customization of the stork build process

You can further override stork to run a customized CodeBuild project on each commit to your repository. This may mean taking additional steps prior to building a Lambda bundle, or you could use stork as a trigger for an entirely different build process using AWS CodeBuild. You can override stork's default procedures by adding either of these files to your repository:

- **.stork.json**: Allows you to choose from a set of images that stork provides, or set the build to use a custom Docker image. Note that the image you choose must be either one of stork's defaults (see above), or any **public** image.
- **buildspec.yml**: Allows you to determine exactly the build steps performed by CodeBuild after pulling your code. If you put this file in your repository, you will completely override stork's default bundling procedure. You are responsible for making sure that this file uploads any artifacts from the build to S3.

### .stork.json

This file has the following structure:

```json
{
  "image": "a stork default image name or the full URI for a public image",
  "size": "one of small, medium, or large"
}
```

See [the AWS CodeBuild documentation](https://docs.aws.amazon.com/codebuild/latest/userguide/build-env-ref-compute-types.html) for details about the differences between the small, medium, and large build environments.

### buildspec.yml

This file, if provided, determines what actions will be taken during a CodeBuild run on each commit. By defining this file in your repository, you take complete control over the CodeBuild actions, and can use it to take whatever build actions you'd like to.

See [the AWS CodeBuild documentation](https://docs.aws.amazon.com/codebuild/latest/userguide/build-spec-ref.html) to understand this file's sytax and capabilities.
