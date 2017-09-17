## The CloudFormation stack

You need to set up stork's CloudFormation stack in your AWS account first. This creates a set of resources:

- (API Gateway) A webhook URL and secret: These are how Github will notify stork that a commit has been made.
- (Lambda) A function to trigger a CodeBuild project that bundles your libraries' code into a `.zip` file and puts it to S3.

If you are interested in putting `.zip` files into buckets in more than one AWS region, you will set up a stork stack in each region.

# Bootstrapping

## Setup the CloudFormation stack

**These actions only need to be performed once per AWS account**.

To setup stork in your AWS account, first answer the following questions:

- What regions will I want to host `.zip` files in?
- What are my regional buckets going to be named? **They must share a common basename and end with the region identifier**. For example: `my-bucket-us-east-1`, `my-bucket-eu-west-1`, etc.
- What prefix will I put bundles under within those buckets?

Once you've made these decisions, you must:

- Create each of those buckets
- Create a Github token that has access to clone your repositories. This token will be stored by the CloudFormation and used during each build. It must have, at a minimum, the `public_repo` scope. It must have the `repo` scope if stork will be interacting with private repositories.

Then, run the bootstrapping script included in this repository:

```
$ git clone https://github.com/mapbox/stork
$ cd stork
$ npm install
$ ./bin/bootstrap.js \
>   --regions us-east-1 \
>   --regions eu-west-1 \
>   --bucket-basename my-bucket \
>   --bundle-prefix my-bundles \
>   --token xxx
```

This bootstrapping script will perform the following actions for you:

- Build and upload stork's default Docker images to ECR in each region
- Bundle stork's own code into a `.zip` file and upload it to your buckets in each region
- Create a CloudFormation stack in each region named `stork-production`
