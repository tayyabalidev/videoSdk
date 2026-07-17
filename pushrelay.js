/**
 * Appwrite Function — relay Expo push to specific users (reads expoPushToken via API key).
 * Uses native fetch (NO axios / no npm packages).
 *
 * Entrypoint for Appwrite: pushrelay.js
 *
 * Function variables:
 *   APPWRITE_DATABASE_ID, APPWRITE_USER_COLLECTION_ID
 *   APPWRITE_API_KEY (or APPWRITE_FUNCTION_API_KEY)
 *   APPWRITE_PROJECT_ID, APPWRITE_ENDPOINT (fallbacks if function injects are missing)
 */
'use strict';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function resolveMethod(req) {
  // Appwrite may send lowercase, empty, or put method only in headers.
  const headerMethod =
    req?.headers?.['x-forwarded-method'] ||
    req?.headers?.['X-Forwarded-Method'] ||
    req?.headers?.['request-method'];
  const raw = req?.method || headerMethod || 'POST';
  return String(raw).trim().toUpperCase() || 'POST';
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

function userDocUrl(userId) {
  const db = process.env.APPWRITE_DATABASE_ID;
  const col = process.env.APPWRITE_USER_COLLECTION_ID;
  return `${appwriteBase()}/databases/${db}/collections/${col}/documents/${userId}`;
}

function getBodyJson(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    return req.body;
  }
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

function getQueryJson(req) {
  const raw = req.queryString || req.query || '';
  if (!raw || typeof raw !== 'string') {
    if (raw && typeof raw === 'object') return raw;
    return {};
  }
  try {
    const params = new URLSearchParams(raw.startsWith('?') ? raw.slice(1) : raw);
    const out = {};
    for (const [key, value] of params.entries()) {
      out[key] = value;
    }
    if (typeof out.toUserIds === 'string') {
      try {
        out.toUserIds = JSON.parse(out.toUserIds);
      } catch {
        out.toUserIds = out.toUserIds.split(',').map((s) => s.trim()).filter(Boolean);
      }
    }
    if (typeof out.data === 'string') {
      try {
        out.data = JSON.parse(out.data);
      } catch {
        /* keep string */
      }
    }
    return out;
  } catch {
    return {};
  }
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text().catch(() => '');
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const message =
      (data && data.message) ||
      (typeof data === 'string' ? data.slice(0, 200) : '') ||
      `HTTP ${res.status}`;
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function relayPush({ toUserIds, title, body, channelId, data, log }) {
  const recipients = [...new Set((toUserIds || []).filter(Boolean))];
  if (!recipients.length) {
    return { pushed: 0, recipients: 0 };
  }

  if (!appwriteBase() || !process.env.APPWRITE_DATABASE_ID || !process.env.APPWRITE_USER_COLLECTION_ID) {
    throw new Error(
      'Missing APPWRITE_ENDPOINT/APPWRITE_FUNCTION_API_ENDPOINT, APPWRITE_DATABASE_ID, or APPWRITE_USER_COLLECTION_ID'
    );
  }

  const tokens = [];
  for (const userId of recipients) {
    try {
      const user = await fetchJson(userDocUrl(userId), { headers: appwriteHeaders() });
      const token = user?.expoPushToken;
      if (token && typeof token === 'string' && token.startsWith('ExponentPushToken')) {
        tokens.push(token);
      }
    } catch (_) {
      /* skip missing users / permission errors */
    }
  }

  if (!tokens.length) {
    log?.(`No push tokens for ${recipients.length} recipient(s)`);
    return { pushed: 0, recipients: recipients.length };
  }

  const messages = tokens.map((token) => ({
    to: token,
    title: title || 'ASAB',
    body: body || '',
    sound: 'default',
    priority: 'high',
    channelId: channelId || undefined,
    data: data && typeof data === 'object' ? data : undefined,
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

  log?.(`Pushed to ${tokens.length} device(s)`);
  return { pushed: tokens.length, recipients: recipients.length };
}

module.exports = async ({ req, res, log, error }) => {
  try {
    // Accept GET + POST (Appwrite console / browser / some proxies use GET).
    const method = resolveMethod(req);
    log?.(`push-relay method=${method}`);

    if (method === 'OPTIONS') {
      return res.send('', 204, cors);
    }

    if (method !== 'POST' && method !== 'GET') {
      return res.json({ error: 'Method not allowed', method }, 405, cors);
    }

    const body = { ...getQueryJson(req), ...getBodyJson(req) };
    const result = await relayPush({
      toUserIds: body.toUserIds,
      title: body.title,
      body: body.body,
      channelId: body.channelId,
      data: body.data,
      log,
    });

    return res.json({ ok: true, ...result }, 200, cors);
  } catch (err) {
    error?.(err?.message || err);
    return res.json({ error: err?.message || 'Push relay failed' }, 500, cors);
  }
};
