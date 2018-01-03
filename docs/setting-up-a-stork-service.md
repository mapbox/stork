# Setting up a stork service

To use stork, you need to set up stork's CloudFormation stack in your AWS account. This creates a set of resources:

- (API Gateway) A webhook URL and secret: These are how Github will notify stork that a commit has been made.
- (Lambda) A function to trigger a CodeBuild project that bundles your libraries' code into a `.zip` file and puts it to S3.
- (Lambda) A function to monitor the status of builds. This function is reponsible for reporting build status to Github's statuses API, which show up in your pull requests.
- (Lambda) A function to forward bundles from a primary bucket to regional buckets.

## Bootstrapping

### Gather prerequisite information

To setup stork in your AWS account, first answer the following questions:

- What regions will I want to host `.zip` files in?
- What are my regional buckets going to be named? **They must share a common basename and end with the region identifier**. For example: `my-bucket-us-east-1`, `my-bucket-eu-west-1`, etc. You must create each of these buckets in their respective regions.
- What prefix will I put bundles under within those buckets?

### Create a Github App

You must also create a Github App in your organization's account. This app will be given permission to read files from repositories that stork is watching, and to report on build status via Github's API.

To create a new Github App:

1. Go to `https://github.com/organizations/your-organization/settings/apps` and click "Register a new Github App".
2. Fill in the form, providing `https://github.com/mapbox/stork` for any required URLs.
3. Provide the app with the following permissions:
  - **Commit statuses**: Read & write
  - **Repository contents**: Read-only
4. Under the "Repository contents" section, check the box for "Push".
5. Generate a private key for the app, and save it to a file locally.
6. Record the new Github App's ID, which is visible on the App listing page.
7. Next, create an installation of the app in you organization's account. Simply provide a list of repositories in your account that stork will watch. This list can easily have other repositories added to it later.
8. Record the new installation's ID, which is visible in the URL for the installation itself.

Finally, you must provide an NPM access token with permission to clone any private repositories that your bundles may depend on.

### Recommended step: CloudFormation stack parameter encryption

Consider setting up a stack based on https://github.com/mapbox/cloudformation-kms. This stack creates a KMS key that can be used to encrypt sensitive stork-stack parameter values. These include your NPM token and your Github App's private key.

### Setup the CloudFormation stack

1. Clone the stork repository:

  ```
  git clone https://github.com/mapbox/stork
  ```

2. Install stork's dependencies:

  ```
  cd stork && npm install
  ```

3. Run stork's boostrapping script, providing it with the information you've gathered in the above steps:

  ```
  $ git clone https://github.com/mapbox/stork
  $ cd stork
  $ npm install
  $ ./bin/bootstrap.js \
  >   --regions us-east-1 \
  >   --regions eu-west-1 \
  >   --bucket-basename my-bucket \
  >   --bundle-prefix my-bundles \
  >   --app-id 12345 \
  >   --installation-id 54321 \
  >   --app-keyfile /path/to/private.pem \
  >   --npm-token xxx \
  >   --kms
  ```

  Remove the `--kms` flag if you skipped setting up a `cloudformation-kms` stack above.

This bootstrapping script will perform the following actions for you:

- Build and upload stork's default Docker images to ECR in the first region you list.
- Bundle stork's own code into a `.zip` file and upload it to your bucket in the first region you've listed.
- Create a `stork-production` CloudFormation stack in the first region you've listed.

### Update the Github app

Now that your stack is deployed, your account has an API Gateway URL and secret that expects to be sent push event notifications from Github. By configuring your Github App with these values, every repository that gets added to your Github App will automatically have its push events forwarded to your stork stack's URL.

1. Look up your stork stack's output values for `WebhookEndpointOutput` and `WebhookSecretOutput`.
2. Return to https://github.com/organizations/mapbox/settings/apps and open your app.
3. Enter the values from your stack into the app's "Webhook URL" and "Webhook secret" fields. Save the changes.

### Set up bucket notifications

If you have configured stork to send bundles to multiple regions, you will need to manually set up S3 bucket notifications to fire your stork stack's "forwarder" Lambda function.

1. Look up your stork CloudFormation stack in the AWS console.
2. Identify the stack's `ForwarderFunction` resource and look up its ARN
3. In the S3 console, navigate to the primary bucket where stork will put bundles. This is the bucket that is in the same region as the CloudFormation stack.
4. In the "Properties" tab, click to add a new notification in the "Events" block.
5. Configure the form as follows:
  - **Name**: stork-production
  - **Events**: ObjectCreate (All)
  - **Prefix**: the value you provided as `--bundle-prefix` to the CLI command
  - **Suffix**: leave blank
  - **Send to** Lambda Function
  - **Lambda**: Add Lambda function ARN
  - **Lambda function ARN**: the ARN of the forwarder function
