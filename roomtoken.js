/**
 * Appwrite Function — VideoSDK room + token service for ASAB (single endpoint, two verbs).
 *
 * POST — create room + mint publisher JWT (live host OR outgoing call caller):
 *   URL:  POST https://...appwrite.run/...?participantId=<appwriteUserId>&debug=1
 *   Returns: { meetingId, roomId, token, debug? }
 *   JWT: version 2, roomId, participantId?, permissions ['allow_join','allow_mod'], no roles.
 *   Used by: createLiveStream(), createCall() → caller joins immediately (dashboard participant 1).
 *
 * GET — mint JWT for an existing room (call callee, live viewer, token refresh):
 *   URL:  GET ...?roomId=<required>&participantId=<appwriteUserId>&purpose=viewer|call
 *   Returns: { token, debug? }
 *   Default (purpose omitted or purpose=call): ['allow_join','allow_mod'] — RTC publish (callee).
 *   purpose=viewer: ['allow_join'] only — live HLS viewer (mode VIEWER in app).
 *
 * Required env vars: VIDEOSDK_API_KEY, VIDEOSDK_SECRET_KEY
 *
 * Notes:
 * - Room creation uses crawler JWT (version 2 + roles:['crawler']) — server-side only.
 * - Meeting tokens: version 2 + roomId + permissions; never add roles:['rtc'] on meeting JWTs.
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
  const fromParams = (params) => ({
    roomId: params.get('roomId') || '',
    participantId: params.get('participantId') || '',
    purpose: (params.get('purpose') || '').trim().toLowerCase(),
  });

  if (req.query && typeof req.query === 'object' && !Array.isArray(req.query)) {
    const r = req.query.roomId ?? req.query['roomId'];
    const p = req.query.participantId ?? req.query['participantId'];
    const purpose = req.query.purpose ?? req.query['purpose'];
    if (r != null && r !== '' || p != null && p !== '' || purpose != null && purpose !== '') {
      return {
        roomId: r != null && r !== '' ? String(r) : '',
        participantId: p != null && p !== '' ? String(p) : '',
        purpose: purpose != null && String(purpose).trim() ? String(purpose).trim().toLowerCase() : '',
      };
    }
  }
  const raw =
    (typeof req.queryString === 'string' && req.queryString) ||
    (typeof req.url === 'string' && req.url.includes('?') ? req.url.split('?')[1] : '') ||
    '';
  return fromParams(new URLSearchParams(raw));
}

/** GET token permissions — match Node /get-token for RTC; viewer-only when purpose=viewer. */
function permissionsForGetToken(purpose) {
  if (purpose === 'viewer') return ['allow_join'];
  return ['allow_join', 'allow_mod'];
}

function buildRoomAuthToken(apiKey, secretKey) {
  // Short-lived JWT used only against `POST https://api.videosdk.live/v2/rooms`.
  // `roles: ['crawler']` is VideoSDK's server-side management role for room operations.
  return jwt.sign(
    {
      apikey: apiKey,
      permissions: ['allow_join', 'allow_mod'],
      version: 2,
      roles: ['crawler'],
    },
    secretKey,
    {
      algorithm: 'HS256',
      expiresIn: '15m',
    }
  );
}

function buildMeetingToken({ apiKey, secretKey, roomId, permissions, participantId }) {
  // version: 2 + roomId → dashboard session + room binding (VideoSDK docs).
  // Omit `roles` on meeting tokens — roles: ['rtc'] breaks RN SDK 0.10.x join handshake.
  if (!roomId || typeof roomId !== 'string' || !roomId.trim()) {
    throw new Error('buildMeetingToken: roomId is required');
  }
  const payload = {
    apikey: apiKey,
    permissions:
      Array.isArray(permissions) && permissions.length > 0 ? permissions : ['allow_join'],
    version: 2,
    roomId: roomId.trim(),
  };
  const pid =
    participantId != null && String(participantId).trim() ? String(participantId).trim() : '';
  if (pid) payload.participantId = pid;
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

    const { roomId, participantId, purpose } = parseQuery(req);
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
            : 'Keys present; POST ?participantId= for room+token (calls/live), GET ?roomId=&participantId= for join.',
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
      const getPermissions = permissionsForGetToken(purpose);
      const token = buildMeetingToken({
        apiKey,
        secretKey,
        roomId: String(roomId),
        permissions: getPermissions,
        participantId: participantId || undefined,
      });
      const claims = safeDecodeJwtNoVerify(token) || {};
      const debug = {
        flow: purpose === 'viewer' ? 'live-viewer' : 'meeting-join',
        purpose: purpose || 'call',
        requestedRoomId: roomId,
        queryParticipantId: participantId || null,
        tokenRoomId: claims.roomId || null,
        tokenApiKey: claims.apikey || null,
        tokenPermissions: Array.isArray(claims.permissions) ? claims.permissions : [],
        tokenVersion: typeof claims.version === 'number' ? claims.version : null,
        tokenRoles: Array.isArray(claims.roles) ? claims.roles : [],
        tokenParticipantId: claims.participantId || null,
      };
      if (debugRequested) log(`videosdk-token GET debug ${JSON.stringify(debug)}`);
      return res.json({ token, debug }, 200, {
        ...cors,
        'Content-Type': 'application/json',
      });
    }

    // POST: create room + mint host token atomically.
    const createdMeetingId = await createRoom(apiKey, secretKey);
    const token = buildMeetingToken({
      apiKey,
      secretKey,
      roomId: createdMeetingId,
      permissions: ['allow_join', 'allow_mod'],
      participantId: participantId || undefined,
    });
    const claims = safeDecodeJwtNoVerify(token) || {};
    const debug = {
      flow: 'room-create-and-publish',
      requestedRoomId: createdMeetingId,
      queryParticipantId: participantId || null,
      tokenRoomId: claims.roomId || null,
      tokenApiKey: claims.apikey || null,
      tokenPermissions: Array.isArray(claims.permissions) ? claims.permissions : [],
      tokenVersion: typeof claims.version === 'number' ? claims.version : null,
      tokenRoles: Array.isArray(claims.roles) ? claims.roles : [],
      tokenParticipantId: claims.participantId || null,
    };
    if (debugRequested) log(`videosdk-token POST debug ${JSON.stringify(debug)}`);
    return res.json(
      { meetingId: createdMeetingId, roomId: createdMeetingId, token, debug },
      200,
      {
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
