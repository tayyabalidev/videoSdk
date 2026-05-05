'use strict';
const jwt = require('jsonwebtoken');

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept',
};

module.exports = async ({ req, res, log }) => {
  try {
    const method = String(req.method || 'POST').toUpperCase();

    if (method === 'OPTIONS') return res.send('', 204, cors);
    if (method !== 'POST') return res.json({ error: 'Method not allowed' }, 405, cors);

    const apiKey = String(process.env.VIDEOSDK_API_KEY || '').trim();
    const secretKey = String(process.env.VIDEOSDK_SECRET_KEY || '').trim();

    if (!apiKey || !secretKey) {
      return res.json(
        { error: 'VideoSDK not configured', message: 'Missing VIDEOSDK_API_KEY or VIDEOSDK_SECRET_KEY' },
        503,
        cors
      );
    }

    let participantId = '';
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      if (body && body.participantId) participantId = String(body.participantId);
    } catch (_) {}
    if (!participantId && req.query?.participantId) participantId = String(req.query.participantId);

    const roomResp = await fetch('https://api.videosdk.live/v2/rooms', {
      method: 'POST',
      headers: {
        Authorization: apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: '{}',
    });

    const roomRaw = await roomResp.text();
    let roomJson = {};
    try { roomJson = roomRaw ? JSON.parse(roomRaw) : {}; } catch (_) {}

    if (!roomResp.ok) {
      return res.json(
        { error: 'Room creation failed', details: roomJson || roomRaw || null },
        roomResp.status || 500,
        cors
      );
    }

    const meetingId =
      roomJson.roomId || roomJson.room_id || roomJson.id || roomJson.meetingId || '';

    if (!meetingId) {
      return res.json({ error: 'Room API missing roomId', details: roomJson }, 502, cors);
    }

    const payload = {
      apikey: apiKey,
      roomId: String(meetingId),
      permissions: ['allow_join', 'allow_mod'],
      version: 2,
      roles: ['rtc'],
    };
    if (participantId) payload.participantId = participantId;

    const token = jwt.sign(payload, secretKey, { algorithm: 'HS256', expiresIn: '2h' });

    return res.json({ meetingId: String(meetingId), token }, 200, {
      ...cors,
      'Content-Type': 'application/json',
    });
  } catch (e) {
    try { log(String(e?.message || e)); } catch (_) {}
    return res.json({ error: 'create-room-and-token failed', message: String(e?.message || e) }, 500, cors);
  }
};