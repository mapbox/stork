# bundle-shepherd

Another continuous integration system to build Lambda packages.

## Concept of a bundle-shepherd

1. A bundle-shepherd stack that is deployed **once** in an AWS account.

2. This stack's parameters define
  - The S3 bucket and path where bundles will be placed
  - A Github token that CodeBuild can use to pull private code

3. bundle-shepherd provides a default set of images and build instructions for a set of Lambda runtime environments (e.g. `nodejs6.10` and `python2.7`).

4. Once deployed, bundle-shepherd's outputs provide a webhook URL and secret.

5. The user may place a configuration file in their repository that allow a choice of
  - one of bundle-shepherd's default build images (defaults to nodejs6.10),
  - **or** a custom image to be used by the CodeBuild project.

6. Committing a top-level `buildspec.yml` file to the repository will use that file to override bundle-shepherd's default build instructions. If using a custom image, a `buildspec.yml` must be provided (probably).

7. To start performing builds for a repository, the user connects it to the stack's webhook URL.

8. On each commit to the repository, this stack's lambda function **must**:
  - clone the repository@sha, look for top-level `buildspec.yml` or custom image
  - look for a pre-existing CodeBuild project matching this repo & desired image
  - if there is no matching project, create one
  - if there is a matching project, run a build for the desired sha
  - when running a build, if the repository **does not** contain a top-level `buildspec.yml`, bundle-shepherd provides its default as a `buildspecOverride`. If the repository **does** contain a top-level `buildspec.yml` file, then by not setting an override, the repositories' file will be used.

## Bootstrapping an account

1. Pick a bucket & prefix in your account that's going to house bundles.
2. Running `./bin/bootstrap.sh bucket prefix` creates an initial bundle for bundle-shepherd itself.
3. `cd Dockerfiles && ./build.sh` creates a `bundle_shepherd` repository, adds default images, and sets the repository policy.
4. Create the bundle-shepherd stack using cfn-config
