#!/usr/bin/env bash

set -eu

region=${1}

# Log docker client into ECR
eval "$(aws ecr get-login --region ${region} --no-include-email)"

# Make sure the ECR repository exists
aws ecr describe-repositories --region ${region} --repository-names bundle-shepherd > /dev/null 2>&1 || \
  aws ecr create-repository --region ${region} --repository-name bundle-shepherd > /dev/null

# Give CodeBuild permission to pull images
aws ecr set-repository-policy \
  --region ${region} \
  --repository-name bundle-shepherd \
  --policy-text fileb://policy.json > /dev/null

# Fetch the ECR repository URI
desc=$(aws ecr describe-repositories --region ${region} --repository-names bundle-shepherd)
uri=$(node -e "console.log(${desc}.repositories[0].repositoryUri);")

# Build, tag and push the nodejs6.x docker image
docker build -t bundle-shepherd:nodejs6.x -f ./nodejs6.x ./
docker tag bundle-shepherd:nodejs6.x "${uri}:nodejs6.x"
docker push "${uri}:nodejs6.x"

# Build, tag and push the python2.7 docker image
docker build -t bundle-shepherd:python2.7 -f ./python2.7 ./
docker tag bundle-shepherd:python2.7 "${uri}:python2.7"
docker push "${uri}:python2.7"

# Build, tag and push the python3.6 docker image
docker build -t bundle-shepherd:python3.6 -f ./python3.6 ./
docker tag bundle-shepherd:python3.6 "${uri}:python3.6"
docker push "${uri}:python3.6"
