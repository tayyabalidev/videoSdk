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
    return {
      roomId: req.query.roomId || '',
      participantId: req.query.participantId || '',
    };
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

function buildMeetingToken({ apiKey, secretKey, roomId, participantId }) {
  const payload = {
    apikey: apiKey,
    permissions: ['allow_join', 'allow_mod'],
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

async function createRoom(apiKey, secretKey, log) {
  log("📡 Creating room in VideoSDK...");

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
  log(`📥 Raw response from VideoSDK: ${rawBody}`);

  let data = null;
  try {
    data = rawBody ? JSON.parse(rawBody) : null;
  } catch (_) {
    data = rawBody;
  }

  if (!response.ok) {
    log(`❌ Room creation failed: ${JSON.stringify(data)}`);
    const err = new Error('Room creation failed');
    err.status = response.status || 500;
    err.details = data || rawBody || null;
    throw err;
  }

  const roomId =
    data?.roomId ||
    data?.room_id ||
    data?.id ||
    data?.meetingId ||
    '';

  log(`🎯 Extracted roomId: ${roomId}`);

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

    log(`🌐 Incoming request: ${req.url}`);
    log(`👉 Method: ${method}`);

    if (method === 'OPTIONS') {
      return res.send('', 204, cors);
    }

    if (method !== 'GET' && method !== 'POST') {
      return res.json({ error: 'Method not allowed' }, 405, cors);
    }

    const apiKey = String(process.env.VIDEOSDK_API_KEY || '').trim();
    const secretKey = String(process.env.VIDEOSDK_SECRET_KEY || '').trim();

    if (!apiKey || !secretKey) {
      log("❌ Missing environment variables");
      return res.json(
        {
          error: 'VideoSDK not configured',
          message: 'Missing VIDEOSDK_API_KEY or VIDEOSDK_SECRET_KEY',
        },
        503,
        cors
      );
    }

    const { roomId, participantId } = parseQuery(req);

    /**
     * =========================
     * GET → TOKEN ONLY
     * =========================
     */
    if (method === 'GET') {
      if (!roomId) {
        return res.json({ error: 'roomId is required' }, 400, cors);
      }

      log(`🔐 Generating token for roomId: ${roomId}`);

      const token = buildMeetingToken({
        apiKey,
        secretKey,
        roomId: String(roomId),
        participantId,
      });

      const claims = safeDecodeJwtNoVerify(token) || {};

      log(`🎯 Token roomId: ${claims.roomId}`);

      return res.json(
        {
          token,
          debug: {
            requestedRoomId: roomId,
            tokenRoomId: claims.roomId || null,
          },
        },
        200,
        cors
      );
    }

    /**
     * =========================
     * POST → CREATE ROOM + TOKEN
     * =========================
     */

    log("🚀 Starting room + token creation...");

    const meetingId = await createRoom(apiKey, secretKey, log);

    log(`✅ Meeting created: ${meetingId}`);

    const token = buildMeetingToken({
      apiKey,
      secretKey,
      roomId: meetingId,
      participantId,
    });

    const claims = safeDecodeJwtNoVerify(token) || {};

    log(`🔐 Token generated with roomId: ${claims.roomId}`);
    log(`👤 Participant: ${participantId || "none"}`);

    const debug = {
      requestedRoomId: meetingId,
      tokenRoomId: claims.roomId || null,
      participantId: participantId || null,
    };

    log(`📦 Final Debug: ${JSON.stringify(debug)}`);

    return res.json(
      {
        meetingId,
        token,
        debug,
      },
      200,
      cors
    );

  } catch (e) {
    log(`❌ ERROR: ${e.message}`);

    return res.json(
      {
        error: 'create-room-and-token failed',
        message: e.message || 'unknown',
      },
      500,
      cors
    );
  }
};