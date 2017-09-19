#!/usr/bin/env bash

set -eu

region=${1}

# Log docker client into ECR
eval "$(aws ecr get-login --region ${region} --no-include-email)"

# Make sure the ECR repository exists
aws ecr describe-repositories --region ${region} --repository-names stork > /dev/null 2>&1 || \
  aws ecr create-repository --region ${region} --repository-name stork > /dev/null

# Give CodeBuild permission to pull images
aws ecr set-repository-policy \
  --region ${region} \
  --repository-name stork \
  --policy-text fileb://policy.json > /dev/null

# Fetch the ECR repository URI
desc=$(aws ecr describe-repositories --region ${region} --repository-names stork)
uri=$(node -e "console.log(${desc}.repositories[0].repositoryUri);")

# Build, tag and push the nodejs4.3 docker image
docker build -t stork:nodejs4.3 -f ./nodejs4.3 ./
docker tag stork:nodejs4.3 "${uri}:nodejs4.3"
docker push "${uri}:nodejs4.3"

# Build, tag and push the nodejs6.x docker image
docker build -t stork:nodejs6.x -f ./nodejs6.x ./
docker tag stork:nodejs6.x "${uri}:nodejs6.x"
docker push "${uri}:nodejs6.x"

# Build, tag and push the python2.7 docker image
docker build -t stork:python2.7 -f ./python2.7 ./
docker tag stork:python2.7 "${uri}:python2.7"
docker push "${uri}:python2.7"

# Build, tag and push the python3.6 docker image
docker build -t stork:python3.6 -f ./python3.6 ./
docker tag stork:python3.6 "${uri}:python3.6"
docker push "${uri}:python3.6"
