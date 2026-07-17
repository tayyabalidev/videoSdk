/**
 * Appwrite Function — admin/CEO content broadcast to all users (in-app + Expo push).
 * Uses native fetch (NO axios).
 *
 * Deploy, then set in app .env:
 *   EXPO_PUBLIC_ADMIN_BROADCAST_URL=https://your-function.nyc.appwrite.run
 *
 * Function variables:
 *   APPWRITE_DATABASE_ID, APPWRITE_USER_COLLECTION_ID, APPWRITE_NOTIFICATIONS_COLLECTION_ID
 *   ADMIN_EMAILS (or CEO_USER_ID / CEO_USER_EMAIL)
 *   APP_PLATFORM=com.bilal.asab
 */
'use strict';

const crypto = require('crypto');

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const DEDUPE_TYPES = new Set(['live', 'video_post', 'photo_post', 'content_post', 'post']);

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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
    ...splitCsv(process.env.EXPO_PUBLIC_CEO_USER_IDS),
  ]);
  const emails = new Set(
    [
      ...splitCsv(process.env.ADMIN_EMAILS),
      ...splitCsv(process.env.EXPO_PUBLIC_ADMIN_EMAILS),
      ...splitCsv(process.env.CEO_USER_EMAIL),
      ...splitCsv(process.env.CEO_EMAILS),
      ...splitCsv(process.env.EXPO_PUBLIC_CEO_USER_EMAIL),
      ...splitCsv(process.env.EXPO_PUBLIC_CEO_EMAILS),
    ].map((e) => e.toLowerCase())
  );
  const id = String(userId || '').trim();
  const em = String(email || '').trim().toLowerCase();
  return (id && ids.has(id)) || (em && emails.has(em));
}

function appwriteHeaders() {
  const key =
    process.env.APPWRITE_FUNCTION_API_KEY ||
    process.env.APPWRITE_API_KEY;
  const project =
    process.env.APPWRITE_FUNCTION_PROJECT_ID ||
    process.env.APPWRITE_PROJECT_ID;
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

function safeJsonParse(text) {
  if (text == null) return null;
  const raw = String(text).trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function getBodyJson(req) {
  const bodyText =
    (typeof req.bodyText === 'string' && req.bodyText) ||
    (typeof req.bodyRaw === 'string' && req.bodyRaw) ||
    (typeof req.body === 'string' && req.body) ||
    '';

  if (bodyText && String(bodyText).trim()) {
    const parsed = safeJsonParse(bodyText);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if (typeof parsed.data === 'string') {
        const nested = safeJsonParse(parsed.data);
        if (nested && typeof nested === 'object') return nested;
      }
      return parsed;
    }
  }

  try {
    if (req.bodyJson && typeof req.bodyJson === 'object' && !Array.isArray(req.bodyJson)) {
      return req.bodyJson;
    }
  } catch (_) {
    /* empty bodyJson */
  }

  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    if (typeof req.body.data === 'string') {
      const nested = safeJsonParse(req.body.data);
      if (nested && typeof nested === 'object') return nested;
    }
    return req.body;
  }

  return {};
}

function getQueryJson(req) {
  if (req.query && typeof req.query === 'object' && !Array.isArray(req.query)) {
    return { ...req.query };
  }
  return {};
}

function normalizeAvatar(avatar) {
  if (!avatar || typeof avatar !== 'string') return '';
  if (avatar.length <= 100) return avatar;
  const match = avatar.match(/\/files\/([^/?]+)/);
  return match?.[1] || avatar.substring(0, 97) + '...';
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text().catch(() => '');
  const data = safeJsonParse(text);
  if (!res.ok) {
    const message =
      (data && data.message) ||
      (text && String(text).trim().slice(0, 200)) ||
      `HTTP ${res.status}`;
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return data;
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
    const data = await fetchJson(`${collectionUrl(userCol)}?${qs}`, {
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
  if (!notifCol) throw new Error('APPWRITE_NOTIFICATIONS_COLLECTION_ID not configured');
  const docId = crypto.randomUUID().replace(/-/g, '').slice(0, 20);
  await fetchJson(collectionUrl(notifCol), {
    method: 'POST',
    headers: appwriteHeaders(),
    body: JSON.stringify({ documentId: docId, data: payload }),
  });
}

async function broadcast({ creatorUserId, creatorEmail, type, postId, log }) {
  if (!isPlatformBroadcaster({ userId: creatorUserId, email: creatorEmail })) {
    throw new Error(
      'Not authorized for platform broadcast. Set ADMIN_EMAILS and/or CEO_USER_ID on this function.'
    );
  }

  if (!appwriteBase() || !process.env.APPWRITE_DATABASE_ID) {
    throw new Error('Missing APPWRITE_ENDPOINT / APPWRITE_DATABASE_ID');
  }

  const userCol = process.env.APPWRITE_USER_COLLECTION_ID;
  if (!userCol) throw new Error('APPWRITE_USER_COLLECTION_ID not configured');

  const creator = await fetchJson(`${collectionUrl(userCol)}/${encodeURIComponent(creatorUserId)}`, {
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
  let pushTitle = 'Admin posted new content.';
  let pushBody = 'Tap to view.';
  if (type === 'live') {
    pushTitle = 'Admin is now LIVE!';
    pushBody = 'Join the stream now.';
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
      const user = await fetchJson(`${collectionUrl(userCol)}/${encodeURIComponent(userId)}`, {
        headers: appwriteHeaders(),
      });
      const token = user?.expoPushToken;
      if (token && String(token).startsWith('ExponentPushToken')) {
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
    await fetchJson(EXPO_PUSH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(messages.slice(i, i + 100)),
    });
  }

  return { recipients: recipientIds.length, notified, pushed: tokens.length };
}

module.exports = async ({ req, res, log, error }) => {
  try {
    const path = String(req.path || req.url || '/');
    if (path.includes('favicon.ico')) {
      return res.send('', 204, cors);
    }

    const method = String(req.method || 'POST').toUpperCase();
    if (method === 'OPTIONS' || method === 'HEAD') {
      return res.send('', 204, cors);
    }
    if (method !== 'POST' && method !== 'GET') {
      return res.json({ error: 'Method not allowed', method }, 405, cors);
    }

    const body = { ...getQueryJson(req), ...getBodyJson(req) };
    const { creatorUserId, creatorEmail, type, postId } = body;

    if (!creatorUserId || !type) {
      return res.json(
        {
          error: 'creatorUserId and type required',
          hint: 'POST JSON: {"creatorUserId":"...","creatorEmail":"...","type":"video_post","postId":"..."}',
          receivedKeys: Object.keys(body || {}),
        },
        400,
        cors
      );
    }

    if (!['live', 'video_post', 'photo_post', 'content_post', 'post'].includes(type)) {
      return res.json({ error: 'Invalid notification type' }, 400, cors);
    }

    const result = await broadcast({
      creatorUserId,
      creatorEmail,
      type,
      postId,
      log,
    });

    return res.json({ ok: true, ...result }, 200, cors);
  } catch (e) {
    error?.(e?.message || e);
    const status = String(e?.message || '').includes('Not authorized') ? 403 : 500;
    return res.json({ error: e?.message || 'Broadcast failed' }, status, cors);
  }
};
