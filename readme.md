# stork

[![Build Status](https://travis-ci.org/mapbox/stork.svg?branch=master)](https://travis-ci.org/mapbox/stork)

Another continuous integration system to build Lambda deployment bundles.

# Overview

## Concept of a stork

A stork is a continuous integration system that runs on AWS CodeBuild. Its primary usage is to build `.zip` bundles for use in Lambda functions each time a commit is made to a Github repository. It can also be used as a more generic tool for running a CodeBuild project on each commit.

## Configuring a repository

Once the CloudFormation stack is created, provide its webhook URL and secret to Github as a webhook. This is the only thing you have to do if you simply want to build `.zip` files for node.js 6.10 Lambda functions.

## Overriding defaults

There are default Docker images and `buildspec.yml` files provided by stork. These are the instructions that CodeBuild needs in order to create the `.zip` files for **a node.js 6.10 Lambda function**. If you want to build a bundle for a different Lambda runtime, or have complex steps that must execute in order to properly build the bundle, you can override stork's defaults by including your own `buildspec.yml` and/or `.stork.json` files in your repository.

## Using the Lambda bundles

When setting up the CloudFormation stack, you will specify a bucket name and a prefix under which stork will place `.zip` files. If you specified these as `my-bucket` and `my-bundles`, and you were to make a commit to `my-repo` with a SHA of `abc`, then the bundle will be located at:

```
s3://my-bucket/my-bundles/my-repo/abc.zip
```

Each time you make another commit to `my-repo`, another `.zip` file will be written with the commit's SHA. This predictable naming scheme helps you manage Lambda functions defined in CloudFormation templates, where the Lambda function code might change from commit to commit.

# Bootstrapping

## Connecting the webhooks

**These actions are performed once for each repository that stork should watch**.

If you wish, you can use a CLI tool included in this repository to connect your repository to your stork webhooks. The following example connects `my-repo` owned by `me` to stork stacks in `us-east-1` and `eu-west-1`:

```
$ ./bin/hook.js \
>   --regions us-east-1 \
>   --regions eu-west-1 \
>   --suffix production \
>   --org me \
>   --repo my-repo \
>   --token xxx
```

The Github token provided here must have the `write:repo_hook` scope. It will only be used once to set up webhooks, and after that you can delete the token if you wish.

This repository also provides similar functionality in a JavaScript API, if you'd like to write code to create these webhooks for you.

```js
const hook = require('stork').setupHook;

const options = {
  region: 'us-east-1',
  suffix: 'production',
  token: 'xxx',
  org: 'me',
  repo: 'my-repo'
};

hook(options).then(() => console.log('Linked to webhooks in us-east-1'));
```

If you wish to connect to webhooks in more than one region, you must call this function once for each region.

# Overrides

You may override the default settings stork uses to build a node.js 6.10 `.zip` file. You can use to in order to build deployment packages for Python Lambda functions, or further customize the build to do something that has nothing to do with Lambda. You perform overrides by placing either of two files in a repository that stork is watching.

- **.stork.json**: Allows you to choose from a set of images that stork provides, or set the build to use a custom Docker image.
- **buildspec.yml**: Allows you to determine exactly the build steps performed by CodeBuild after pulling your code.

## .stork.json

This file has the following structure:

```json
{
  "image": "image name or full image url",
  "size": "one of small, medium, or large"
}
```

Both fields are optional, and if the default values are fine, you need not include this file at all.

### image

There are three default images provided by stork:

- `nodejs6.x` (default)
- `python2.7`
- `python3.6`

If you select any of these, stork will build your `.zip` file using its default images and build instructions for that runtime. You may also specify the URI of any other Docker image. If you choose to do so, you will have to also provide your own `buildspec.yml`.

### size

One of

- `small` (default)
- `medium`
- `large`

These simply determine the amount of compute resource provisioned by CodeBuild in order to perform your build.

## buildspec.yml

This file, if provided, determines what actions will be taken during a CodeBuild run on each commit. By defining this file in your repository, you take complete control over the CodeBuild actions, and can use it to take whatever build actions you'd like to.
