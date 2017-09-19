#!/usr/bin/env node

'use strict';

/* eslint-disable no-console */

const meow = require('meow');
const hook = require('..').setupHook;

const cli = meow(`
  USAGE: ./bin/hook.js [options]

  All options are not optional.

  OPTIONS:
    -r, --regions
    -s, --suffix
    -t, --token
    -o, --org
    -n, --repo
`, {
  alias: {
    r: 'regions',
    s: 'suffix',
    t: 'token',
    o: 'org',
    n: 'repo'
  },
  string: [
    'suffix',
    'token',
    'org',
    'repo'
  ]
});

const regions = Array.isArray(cli.flags.regions)
  ? cli.flags.regions
  : [cli.flags.regions];

const hooks = regions
  .map((region) => hook(Object.assign({ region }, cli.flags)));

Promise.all(hooks);
