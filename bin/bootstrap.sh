#!/usr/bin/env bash

set -eux

rm -rf node_modules
yarn install --production
[ -f bundle.zip ] && rm bundle.zip
zip -r -x \*.git\* -q bundle.zip ./
aws s3 cp ./bundle.zip "s3://${1}/${2}/bundle-shepherd/$(git rev-parse head).zip"
rm bundle.zip
rm -rf node_modules
yarn install
