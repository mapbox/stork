'use strict';

module.exports = (vars) => {
  const originals = {};

  const env = {
    mock: () => {
      if (Object.keys(originals).length)
        throw new Error('Environment variables already mocked');

      Object.keys(vars).forEach((key) => {
        originals[key] = process.env[key];
        process.env[key] = vars[key];
      });

      return env;
    },

    restore: () => {
      if (!Object.keys(originals).length)
        throw new Error('Environment variables have not been mocked');

      Object.keys(originals).forEach((key) => {
        process.env[key] = originals[key];
      });

      return env;
    }
  };

  return env;
};
