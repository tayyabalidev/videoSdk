'use strict';
const jwt = require('jsonwebtoken');

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept',
};

function toQueryMap(req) {
  if (req.query && typeof req.query === 'object' && !Array.isArray(req.query)) {
    return req.query;
  }
  const raw =
    (typeof req.queryString === 'string' && req.queryString) ||
    (typeof req.url === 'string' && req.url.includes('?') ? req.url.split('?')[1] : '') ||
    '';
  const params = new URLSearchParams(raw);
  return Object.fromEntries(params.entries());
}

module.exports = async ({ req, res, log }) => {
  try {
    const method = String(req.method || 'POST').toUpperCase();

    if (method === 'OPTIONS') return res.send('', 204, cors);
    if (method !== 'POST') return res.json({ error: 'Method not allowed' }, 405, cors);

    // 🔑 ENV variables (set in Appwrite)
    const authToken = String(process.env.VIDEOSDK_AUTH_TOKEN || '').trim(); // = API KEY
    const apiKey = String(process.env.VIDEOSDK_API_KEY || '').trim();
    const secretKey = String(process.env.VIDEOSDK_SECRET_KEY || '').trim();

    if (!authToken || !apiKey || !secretKey) {
      return res.json(
        {
          error: 'VideoSDK not configured',
          message: 'Missing VIDEOSDK_AUTH_TOKEN / VIDEOSDK_API_KEY / VIDEOSDK_SECRET_KEY',
        },
        503,
        cors
      );
    }

    // Optional participantId
    let participantId = '';
    const query = toQueryMap(req);
    if (query.participantId) participantId = String(query.participantId);

    if (!participantId) {
      try {
        const body =
          typeof req.body === 'string'
            ? JSON.parse(req.body || '{}')
            : (req.body || {});
        if (body && body.participantId) participantId = String(body.participantId);
      } catch (_) {}
    }

    // 🚀 1. Create VideoSDK room
    const roomResp = await fetch('https://api.videosdk.live/v2/rooms', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${authToken}`, // ✅ FIXED
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({}), // ✅ FIXED
    });

    const roomRaw = await roomResp.text();
    let roomJson = {};
    try {
      roomJson = roomRaw ? JSON.parse(roomRaw) : {};
    } catch (_) {}

    if (!roomResp.ok) {
      return res.json(
        { error: 'Room creation failed', details: roomJson || roomRaw || null },
        roomResp.status || 500,
        cors
      );
    }

    const meetingId =
      roomJson.roomId ||
      roomJson.room_id ||
      roomJson.id ||
      roomJson.meetingId ||
      '';

    if (!meetingId) {
      return res.json(
        { error: 'Room API missing roomId', details: roomJson },
        502,
        cors
      );
    }

    log(`Room created: ${meetingId}`);

    // 🔐 2. Generate JWT token
    const payload = {
      apikey: apiKey,
      roomId: String(meetingId),
      permissions: ['allow_join', 'allow_mod'],
      version: 2,
      roles: ['rtc'],
    };

    if (participantId) payload.participantId = participantId;

    const token = jwt.sign(payload, secretKey, {
      algorithm: 'HS256',
      expiresIn: '2h',
    });

    log(`Token created for room: ${meetingId}`);

    // ✅ 3. Return both
    return res.json(
      {
        meetingId: String(meetingId),
        token,
      },
      200,
      {
        ...cors,
        'Content-Type': 'application/json',
      }
    );
  } catch (e) {
    try {
      log(String(e?.message || e));
    } catch (_) {}
    return res.json(
      {
        error: 'create-room-and-token failed',
        message: String(e?.message || e),
      },
      500,
      cors
    );
  }
};