/**
 * Appwrite Function — admin/CEO content broadcast to all users (in-app + Expo push).
 *
 * Deploy in Appwrite Console, then set in app .env:
 *   EXPO_PUBLIC_ADMIN_BROADCAST_URL=https://your-function.nyc.appwrite.run
 *
 * Function variables:
 *   APPWRITE_DATABASE_ID, APPWRITE_USER_COLLECTION_ID, APPWRITE_NOTIFICATIONS_COLLECTION_ID
 *   ADMIN_EMAILS, CEO_USER_ID (optional)
 *   APP_PLATFORM=com.bilal.asab
 */
'use strict';

const crypto = require('crypto');
const axios = require('axios');

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const DEDUPE_TYPES = new Set(['live', 'video_post', 'photo_post']);

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function splitCsv(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function isPlatformBroadcaster({ userId, email }) {
  const ids = new Set([
    ...splitCsv(process.env.CEO_USER_ID),
    ...splitCsv(process.env.CEO_USER_IDS),
    ...splitCsv(process.env.EXPO_PUBLIC_CEO_USER_ID),
  ]);
  const emails = new Set(
    [
      ...splitCsv(process.env.ADMIN_EMAILS),
      ...splitCsv(process.env.CEO_USER_EMAIL),
      ...splitCsv(process.env.EXPO_PUBLIC_CEO_USER_EMAIL),
    ].map((e) => e.toLowerCase())
  );
  const id = String(userId || '').trim();
  const em = String(email || '').trim().toLowerCase();
  return (id && ids.has(id)) || (em && emails.has(em));
}

function appwriteHeaders() {
  const endpoint = process.env.APPWRITE_FUNCTION_API_ENDPOINT || process.env.APPWRITE_ENDPOINT;
  const key =
    process.env.APPWRITE_FUNCTION_API_KEY ||
    process.env.APPWRITE_API_KEY;
  const project =
    process.env.APPWRITE_FUNCTION_PROJECT_ID || process.env.APPWRITE_PROJECT_ID;
  return {
    'X-Appwrite-Project': project,
    'X-Appwrite-Key': key,
    'Content-Type': 'application/json',
  };
}

function appwriteBase() {
  return (
    process.env.APPWRITE_FUNCTION_API_ENDPOINT ||
    process.env.APPWRITE_ENDPOINT ||
    ''
  ).replace(/\/$/, '');
}

function collectionUrl(collectionId) {
  const db = process.env.APPWRITE_DATABASE_ID;
  return `${appwriteBase()}/databases/${db}/collections/${collectionId}/documents`;
}

function getBodyJson(req) {
  const text =
    (typeof req.bodyText === 'string' && req.bodyText) ||
    (typeof req.body === 'string' && req.body) ||
    '';
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function normalizeAvatar(avatar) {
  if (!avatar || typeof avatar !== 'string') return '';
  if (avatar.length <= 100) return avatar;
  const match = avatar.match(/\/files\/([^/?]+)/);
  return match?.[1] || avatar.substring(0, 97) + '...';
}

async function listAllUserIds(excludeUserId) {
  const userCol = process.env.APPWRITE_USER_COLLECTION_ID;
  const ids = [];
  let cursor = null;
  const pageSize = 100;

  while (true) {
    const queries = [`limit(${pageSize})`];
    if (cursor) queries.push(`cursorAfter("${cursor}")`);
    const qs = queries.map((q) => `queries[]=${encodeURIComponent(q)}`).join('&');
    const { data } = await axios.get(`${collectionUrl(userCol)}?${qs}`, {
      headers: appwriteHeaders(),
    });
    for (const doc of data.documents || []) {
      if (!excludeUserId || doc.$id !== excludeUserId) ids.push(doc.$id);
    }
    if ((data.documents || []).length < pageSize) break;
    cursor = data.documents[data.documents.length - 1].$id;
  }
  return ids;
}

async function createNotificationDoc(payload) {
  const notifCol = process.env.APPWRITE_NOTIFICATIONS_COLLECTION_ID;
  const docId = crypto.randomUUID().replace(/-/g, '').slice(0, 20);
  await axios.post(
    collectionUrl(notifCol),
    { documentId: docId, data: payload },
    { headers: appwriteHeaders() }
  );
}

async function broadcast({ creatorUserId, creatorEmail, type, postId, title, log }) {
  if (!isPlatformBroadcaster({ userId: creatorUserId, email: creatorEmail })) {
    throw new Error('Not authorized for platform broadcast');
  }

  const userCol = process.env.APPWRITE_USER_COLLECTION_ID;
  const { data: creator } = await axios.get(`${collectionUrl(userCol)}/${creatorUserId}`, {
    headers: appwriteHeaders(),
  });

  const fromUsername = creator?.username || 'ASAB';
  const fromUserAvatar = normalizeAvatar(creator?.avatar);
  const recipientIds = await listAllUserIds(creatorUserId);

  log?.(`Broadcast to ${recipientIds.length} users`);

  const batchSize = 25;
  let notified = 0;
  for (let i = 0; i < recipientIds.length; i += batchSize) {
    const batch = recipientIds.slice(i, i + batchSize);
    await Promise.allSettled(
      batch.map((targetUserId) =>
        createNotificationDoc({
          type,
          fromUserId: creatorUserId,
          fromUsername,
          fromUserAvatar,
          targetUserId,
          postId: postId || null,
          isRead: false,
          createdAt: new Date().toISOString(),
        })
      )
    );
    notified += batch.length;
  }

  const platform = process.env.APP_PLATFORM || 'com.bilal.asab';
  const displayName = fromUsername;
  const trimmed = title && String(title).trim() ? String(title).trim() : '';
  let pushTitle = `${displayName} posted a video`;
  let pushBody = trimmed || 'Tap to watch the new video';
  if (type === 'live') {
    pushTitle = `${displayName} is live`;
    pushBody = trimmed || 'Tap to watch the live stream';
  } else if (type === 'photo_post') {
    pushTitle = `${displayName} posted a photo`;
    pushBody = trimmed || 'Tap to view the new post';
  }

  const deepLink =
    type === 'live' && postId
      ? `${platform}://live-viewer?streamId=${encodeURIComponent(postId)}`
      : postId
        ? `${platform}://post/${encodeURIComponent(postId)}`
        : null;

  const tokens = [];
  for (const userId of recipientIds) {
    try {
      const { data: user } = await axios.get(`${collectionUrl(userCol)}/${userId}`, {
        headers: appwriteHeaders(),
      });
      const token = user?.expoPushToken;
      if (token && token.startsWith('ExponentPushToken')) {
        tokens.push(token);
      }
    } catch (_) {
      /* skip */
    }
  }

  const messages = tokens.map((token) => ({
    to: token,
    title: pushTitle,
    body: pushBody,
    sound: 'default',
    priority: 'high',
    channelId: type === 'live' ? 'live-streams' : 'creator-content',
    data: {
      type: type === 'live' ? 'live' : type,
      streamId: type === 'live' ? postId : undefined,
      postId: type !== 'live' ? postId : undefined,
      fromUserId: creatorUserId,
      url: deepLink || undefined,
      broadcast: true,
    },
  }));

  for (let i = 0; i < messages.length; i += 100) {
    await axios.post(EXPO_PUSH_URL, messages.slice(i, i + 100), {
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    });
  }

  return { recipients: recipientIds.length, notified, pushed: tokens.length };
}

module.exports = async ({ req, res, log, error }) => {
  try {
    const method = String(req.method || 'POST').toUpperCase();
    if (method === 'OPTIONS') return res.send('', 204, cors);
    if (method !== 'POST') return res.json({ error: 'Method not allowed' }, 405, cors);

    const body = getBodyJson(req);
    const { creatorUserId, creatorEmail, type, postId, title } = body;

    if (!creatorUserId || !type) {
      return res.json({ error: 'creatorUserId and type required' }, 400, cors);
    }

    const result = await broadcast({
      creatorUserId,
      creatorEmail,
      type,
      postId,
      title,
      log,
    });

    return res.json({ ok: true, ...result }, 200, cors);
  } catch (e) {
    error?.(e?.message || e);
    const status = String(e?.message || '').includes('Not authorized') ? 403 : 500;
    return res.json({ error: e?.message || 'Broadcast failed' }, status, cors);
  }
};
