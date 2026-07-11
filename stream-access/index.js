'use strict';

const { handleAppwriteRequest } = require('./streamAccess');

module.exports = async ({ req, res, log, error }) => {
  try {
    return await handleAppwriteRequest({ req, res, log });
  } catch (e) {
    error?.(e.message || String(e));
    return res.json({ error: e.message || 'Internal error' }, 500, {
      'Access-Control-Allow-Origin': '*',
    });
  }
};
