/**
 * Appwrite Function — VideoSDK room + token service for ASAB.
 *
 * Contracts:
 *   POST /?participantId=<optional>  -> { meetingId, token, debug? }
 *   GET /?roomId=<required>&participantId=<optional> -> { token, debug? } (viewer/backward-compatible)
 *
 * Required env vars:
 *   VIDEOSDK_API_KEY
 *   VIDEOSDK_SECRET_KEY
 *
 * Notes:
 * - No separate VIDEOSDK_AUTH_TOKEN variable required.
 * - Function internally generates a short-lived auth token from API key + secret for /v2/rooms.
 * - Must `return` every res.* (Appwrite requirement).
 */
'use strict';

const jwt = require('jsonwebtoken');
const VIDEOSDK_ROOMS_URL = 'https://api.videosdk.live/v2/rooms';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept',
};

function safeDecodeJwtNoVerify(token) {
  try {
    if (!token || typeof token !== 'string') return null;
    const decoded = jwt.decode(token);
    return decoded && typeof decoded === 'object' ? decoded : null;
  } catch (_) {
    return null;
  }
}

function parseQuery(req) {
  if (req.query && typeof req.query === 'object' && !Array.isArray(req.query)) {
    const r = req.query.roomId ?? req.query['roomId'];
    const p = req.query.participantId ?? req.query['participantId'];
    if (r != null && r !== '' || p != null && p !== '') {
      return {
        roomId: r != null && r !== '' ? String(r) : '',
        participantId: p != null && p !== '' ? String(p) : '',
      };
    }
  }
  const raw =
    (typeof req.queryString === 'string' && req.queryString) ||
    (typeof req.url === 'string' && req.url.includes('?') ? req.url.split('?')[1] : '') ||
    '';
  const params = new URLSearchParams(raw);
  return {
    roomId: params.get('roomId') || '',
    participantId: params.get('participantId') || '',
  };
}

function buildRoomAuthToken(apiKey, secretKey) {
  return jwt.sign(
    {
      apikey: apiKey,
      permissions: ['allow_join', 'allow_mod'],
      version: 2,
    },
    secretKey,
    {
      algorithm: 'HS256',
      expiresIn: '15m',
    }
  );
}

function buildMeetingToken({ apiKey, secretKey, roomId, participantId, permissions }) {
  const payload = {
    apikey: apiKey,
    permissions: Array.isArray(permissions) && permissions.length > 0 ? permissions : ['allow_join'],
    version: 2,
    roles: ['rtc'],
    roomId,
  };
  if (participantId) payload.participantId = participantId;
  return jwt.sign(payload, secretKey, {
    expiresIn: '2h',
    algorithm: 'HS256',
  });
}

async function createRoom(apiKey, secretKey) {
  const authToken = buildRoomAuthToken(apiKey, secretKey);
  const response = await fetch(VIDEOSDK_ROOMS_URL, {
    method: 'POST',
    headers: {
      Authorization: authToken,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: '{}',
  });

  const rawBody = await response.text();
  let data = null;
  try {
    data = rawBody ? JSON.parse(rawBody) : null;
  } catch (_) {
    data = rawBody;
  }

  if (!response.ok) {
    const err = new Error('Room creation failed');
    err.status = response.status || 500;
    err.details = data || rawBody || null;
    throw err;
  }

  const roomId = data?.roomId || data?.room_id || data?.id || data?.meetingId || '';
  if (!roomId) {
    const err = new Error('Room API response missing roomId');
    err.status = 502;
    err.details = data || null;
    throw err;
  }
  return String(roomId);
}

module.exports = async ({ req, res, log }) => {
  try {
    const method = String(req.method || 'GET').toUpperCase();

    if (method === 'OPTIONS') {
      return res.send('', 204, cors);
    }
    if (method !== 'GET' && method !== 'POST') return res.json({ error: 'Method not allowed' }, 405, cors);

    const apiKey = String(process.env.VIDEOSDK_API_KEY || '').trim();
    const secretKey = String(process.env.VIDEOSDK_SECRET_KEY || '').trim();

    const { roomId, participantId } = parseQuery(req);
    const qs =
      typeof req.queryString === 'string' && req.queryString
        ? req.queryString
        : typeof req.url === 'string' && req.url.includes('?')
          ? req.url.split('?')[1]
          : '';
    const params = new URLSearchParams(qs);
    const healthRequested =
      params.get('health') === '1' ||
      (req.query && String(req.query.health) === '1');
    const debugRequested =
      params.get('debug') === '1' ||
      (req.query && String(req.query.debug) === '1');
    if (healthRequested) {
      return res.json(
        {
          ok: true,
          videoSdkKeysPresent: Boolean(apiKey && secretKey),
          hint: !apiKey || !secretKey
            ? 'Add VIDEOSDK_API_KEY and VIDEOSDK_SECRET_KEY to this function (Settings → Variables), save, redeploy.'
            : 'Keys present; POST for room+token, GET ?roomId=... for token-only.',
        },
        200,
        cors
      );
    }

    if (!apiKey || !secretKey) {
      log('Missing VIDEOSDK_API_KEY or VIDEOSDK_SECRET_KEY in function env');
      return res.json(
        {
          error: 'VideoSDK not configured',
          message:
            'VIDEOSDK_API_KEY or VIDEOSDK_SECRET_KEY missing at runtime. Set them on this function in Appwrite, then redeploy.',
        },
        503,
        cors
      );
    }

    if (method === 'GET') {
      if (!roomId) return res.json({ error: 'roomId is required' }, 400, cors);
      const token = buildMeetingToken({
        apiKey,
        secretKey,
        roomId: String(roomId),
        participantId,
        permissions: ['allow_join'],
      });
      const claims = safeDecodeJwtNoVerify(token) || {};
      const debug = {
        requestedRoomId: roomId,
        participantId: participantId || null,
        tokenRoomId: claims.roomId || null,
        tokenApiKey: claims.apikey || null,
        tokenPermissions: Array.isArray(claims.permissions) ? claims.permissions : [],
      };
      if (debugRequested) log(`videosdk-token GET debug ${JSON.stringify(debug)}`);
      return res.json({ token, debug }, 200, {
        ...cors,
        'Content-Type': 'application/json',
      });
    }

    // POST: create room + token atomically
    const createdMeetingId = await createRoom(apiKey, secretKey);
    const token = buildMeetingToken({
      apiKey,
      secretKey,
      roomId: createdMeetingId,
      // Do not participant-bind host live tokens; strict participant binding can reject
      // joins on production clients when client-side participant resolution diverges.
      permissions: ['allow_join', 'allow_mod'],
    });
    const claims = safeDecodeJwtNoVerify(token) || {};
    const debug = {
      requestedRoomId: createdMeetingId,
      participantId: participantId || null,
      tokenRoomId: claims.roomId || null,
      tokenApiKey: claims.apikey || null,
      tokenPermissions: Array.isArray(claims.permissions) ? claims.permissions : [],
    };
    if (debugRequested) log(`videosdk-token POST debug ${JSON.stringify(debug)}`);
    return res.json({ meetingId: createdMeetingId, token, debug }, 200, {
      ...cors,
      'Content-Type': 'application/json',
    });
  } catch (e) {
    if (e && e.message === 'Room creation failed') {
      return res.json(
        { error: 'Room creation failed', details: e.details || null },
        e.status || 500,
        cors
      );
    }
    if (e && e.message === 'Room API response missing roomId') {
      return res.json(
        { error: 'Room API missing roomId', details: e.details || null },
        e.status || 502,
        cors
      );
    }
    try {
      log(String(e && e.message ? e.message : e));
    } catch (_) {}
    return res.json(
      { error: 'create-room-and-token failed', message: e.message || 'unknown' },
      500,
      cors
    );
  }
};
