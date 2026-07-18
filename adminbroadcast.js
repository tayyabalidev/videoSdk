/**
 * Appwrite Function — admin/CEO content broadcast (Expo push + optional inbox).
 * Uses native fetch (NO axios).
 *
 * IMPORTANT: Do NOT write one notification document per user in a single Promise.all.
 * That is what caused your 500 errors at exactly 5m (Appwrite timeout).
 *
 * Default: push-only (fast, reliable). Pass skipInbox=false to also write inbox docs.
 *
 * Function variables:
 *   APPWRITE_DATABASE_ID, APPWRITE_USER_COLLECTION_ID, APPWRITE_NOTIFICATIONS_COLLECTION_ID
 *   ADMIN_EMAILS (or CEO_USER_ID / CEO_USER_EMAIL)
 *   APP_PLATFORM=com.bilal.asab
 *   APPWRITE_API_KEY, APPWRITE_PROJECT_ID, APPWRITE_ENDPOINT
 */
'use strict';

const crypto = require('crypto');

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

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
    (process.env.APPWRITE_API_KEY && String(process.env.APPWRITE_API_KEY).trim()) ||
    (process.env.APPWRITE_FUNCTION_API_KEY && String(process.env.APPWRITE_FUNCTION_API_KEY).trim()) ||
    '';
  const project =
    (process.env.APPWRITE_PROJECT_ID && String(process.env.APPWRITE_PROJECT_ID).trim()) ||
    (process.env.APPWRITE_FUNCTION_PROJECT_ID && String(process.env.APPWRITE_FUNCTION_PROJECT_ID).trim()) ||
    '';

  if (!key) {
    throw new Error('Missing APPWRITE_API_KEY. Add a key with databases.read + databases.write scopes.');
  }
  if (!project) {
    throw new Error('Missing APPWRITE_PROJECT_ID.');
  }
  return {
    'X-Appwrite-Project': project,
    'X-Appwrite-Key': key,
    'Content-Type': 'application/json',
  };
}

function appwriteBase() {
  return (
    process.env.APPWRITE_ENDPOINT ||
    process.env.APPWRITE_FUNCTION_API_ENDPOINT ||
    ''
  ).replace(/\/$/, '');
}

function collectionUrl(collectionId) {
  const db = process.env.APPWRITE_DATABASE_ID;
  if (!db) throw new Error('APPWRITE_DATABASE_ID not configured');
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

  if (bodyText) {
    const parsed = safeJsonParse(bodyText);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if (typeof parsed.data === 'string') {
        const nested = safeJsonParse(parsed.data);
        if (nested && typeof nested === 'object') return nested;
      }
      return parsed;
    }
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

  const raw = req.queryString || '';
  if (raw && typeof raw === 'string') {
    try {
      const params = new URLSearchParams(raw.startsWith('?') ? raw.slice(1) : raw);
      const out = {};
      for (const [key, value] of params.entries()) out[key] = value;
      return out;
    } catch {
      return {};
    }
  }

  try {
    const url = String(req.url || '');
    const qIndex = url.indexOf('?');
    if (qIndex >= 0) {
      const params = new URLSearchParams(url.slice(qIndex + 1));
      const out = {};
      for (const [key, value] of params.entries()) out[key] = value;
      return out;
    }
  } catch (_) {
    /* ignore */
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
    if (
      res.status === 401 ||
      res.status === 403 ||
      String(message).toLowerCase().includes('not authorized')
    ) {
      err.message = `${message} — Check APPWRITE_API_KEY (needs databases.read + databases.write) and collection IDs.`;
    }
    throw err;
  }
  return data;
}

function qLimit(limit) {
  return JSON.stringify({ method: 'limit', values: [Number(limit)] });
}

function qCursorAfter(documentId) {
  return JSON.stringify({ method: 'cursorAfter', values: [String(documentId)] });
}

async function listAllUsers(excludeUserId) {
  const userCol = process.env.APPWRITE_USER_COLLECTION_ID;
  if (!userCol) throw new Error('APPWRITE_USER_COLLECTION_ID not configured');

  const users = [];
  let cursor = null;
  const pageSize = 100;

  while (true) {
    const queries = [qLimit(pageSize)];
    if (cursor) queries.push(qCursorAfter(cursor));

    const qs = queries.map((q) => `queries[]=${encodeURIComponent(q)}`).join('&');
    const data = await fetchJson(`${collectionUrl(userCol)}?${qs}`, {
      headers: appwriteHeaders(),
    });

    for (const doc of data.documents || []) {
      if (excludeUserId && doc.$id === excludeUserId) continue;
      users.push({
        id: doc.$id,
        expoPushToken: doc.expoPushToken || '',
      });
    }

    if ((data.documents || []).length < pageSize) break;
    cursor = data.documents[data.documents.length - 1].$id;
  }
  return users;
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

async function postExpoPush(messages) {
  const res = await fetch(EXPO_PUSH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(messages),
  });
  const text = await res.text().catch(() => '');
  const data = safeJsonParse(text);
  return { ok: res.ok, status: res.status, data, text };
}

async function sendExpoPushMessages(messages, log) {
  if (!messages.length) return { pushed: 0, errors: [] };

  const errors = [];
  let pushed = 0;

  async function mapPool(items, concurrency, worker) {
    const queue = [...items];
    const runners = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (queue.length) {
        const item = queue.shift();
        if (item === undefined) return;
        await worker(item);
      }
    });
    await Promise.all(runners);
  }

  async function sendChunk(chunk) {
    if (!chunk.length) return;
    const result = await postExpoPush(chunk);
    const err0 = result.data?.errors?.[0];
    const code = err0?.code || '';

    if (!result.ok && code === 'PUSH_TOO_MANY_EXPERIENCE_IDS' && chunk.length > 1) {
      const details = err0?.details && typeof err0.details === 'object' ? err0.details : null;
      if (details) {
        const byExperience = new Map();
        for (const msg of chunk) {
          const exp = details[msg.to] || '__unknown__';
          if (!byExperience.has(exp)) byExperience.set(exp, []);
          byExperience.get(exp).push(msg);
        }
        log?.(`Expo mixed experience IDs — splitting into ${byExperience.size} groups`);
        for (const [, subgroup] of byExperience) {
          await sendChunk(subgroup);
        }
        return;
      }

      log?.(`Expo mixed experience IDs — parallel single sends (${chunk.length})`);
      await mapPool(chunk, 15, async (msg) => {
        const one = await postExpoPush([msg]);
        if (one.ok) pushed += 1;
        else {
          errors.push(
            one.data?.errors?.[0]?.message ||
              (one.text && one.text.slice(0, 120)) ||
              `Expo push HTTP ${one.status}`
          );
        }
      });
      return;
    }

    if (!result.ok) {
      const message =
        err0?.message ||
        (result.text && result.text.slice(0, 200)) ||
        `Expo push HTTP ${result.status}`;
      errors.push(message);
      log?.(`Expo push failed: ${message}`);
      return;
    }

    pushed += chunk.length;
  }

  for (let i = 0; i < messages.length; i += 100) {
    await sendChunk(messages.slice(i, i + 100));
  }

  return { pushed, errors };
}

async function broadcast({ creatorUserId, creatorEmail, type, postId, skipInbox, log }) {
  if (!isPlatformBroadcaster({ userId: creatorUserId, email: creatorEmail })) {
    throw new Error('Not authorized for platform broadcast. Configure ADMIN_EMAILS / CEO_USER_ID.');
  }

  if (!appwriteBase() || !process.env.APPWRITE_DATABASE_ID) {
    throw new Error('Missing APPWRITE_ENDPOINT / APPWRITE_DATABASE_ID');
  }

  const started = Date.now();

  const userCol = process.env.APPWRITE_USER_COLLECTION_ID;
  const creator = await fetchJson(`${collectionUrl(userCol)}/${encodeURIComponent(creatorUserId)}`, {
    headers: appwriteHeaders(),
  });

  const fromUsername = creator?.username || 'ASAB';
  const fromUserAvatar = normalizeAvatar(creator?.avatar);

  const users = await listAllUsers(creatorUserId);
  log?.(`Listed ${users.length} users in ${Date.now() - started}ms`);

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

  const tokens = [
    ...new Set(
      users
        .map((u) => u.expoPushToken)
        .filter((t) => t && String(t).startsWith('ExponentPushToken'))
        .map(String)
    ),
  ];

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

  // Push first — this is what users need immediately.
  const pushResult = await sendExpoPushMessages(messages, log);
  log?.(`Pushed ${pushResult.pushed}/${tokens.length} in ${Date.now() - started}ms`);

  let notified = 0;
  let inboxSkipped = true;

  // Default: skip inbox. Writing N notification docs is what caused your 5m timeouts.
  const wantInbox =
    skipInbox === false || skipInbox === 'false' || skipInbox === '0';

  if (wantInbox && process.env.APPWRITE_NOTIFICATIONS_COLLECTION_ID) {
    inboxSkipped = false;
    const softDeadlineMs = Number(process.env.BROADCAST_SOFT_DEADLINE_MS || 25000);
    const batchSize = 40;
    const createdAt = new Date().toISOString();

    for (let i = 0; i < users.length; i += batchSize) {
      if (Date.now() - started > softDeadlineMs) {
        inboxSkipped = true;
        log?.(
          `Soft deadline after ${notified} inbox writes — returning push results to avoid timeout`
        );
        break;
      }
      const batch = users.slice(i, i + batchSize);
      const results = await Promise.allSettled(
        batch.map((user) =>
          createNotificationDoc({
            type,
            fromUserId: creatorUserId,
            fromUsername,
            fromUserAvatar,
            targetUserId: user.id,
            postId: postId || null,
            isRead: false,
            createdAt,
          })
        )
      );
      notified += results.filter((r) => r.status === 'fulfilled').length;
    }
  }

  return {
    recipients: users.length,
    notified,
    pushed: pushResult.pushed,
    tokensFound: tokens.length,
    inboxSkipped,
    elapsedMs: Date.now() - started,
    pushErrors: pushResult.errors,
  };
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

    // Default skip inbox (push-only). Pass skipInbox=false to also write notifications.
    const skipInbox = !(
      body.skipInbox === false ||
      body.skipInbox === 'false' ||
      body.skipInbox === '0'
    );

    if (!creatorUserId || !type) {
      return res.json(
        {
          error: 'creatorUserId and type required',
          hintPost:
            'POST JSON: {"creatorUserId":"...","creatorEmail":"...","type":"video_post","postId":"..."}',
          hintBrowser:
            'https://YOUR_FUNCTION.nyc.appwrite.run/?creatorUserId=YOUR_CEO_ID&creatorEmail=YOU%40email.com&type=video_post&postId=browser-test',
          method,
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
      skipInbox,
      log,
    });

    return res.json({ ok: true, ...result }, 200, cors);
  } catch (e) {
    error?.(e?.message || e);
    const status = String(e?.message || '').includes('Not authorized') ? 403 : 500;
    return res.json({ error: e?.message || 'Broadcast failed' }, status, cors);
  }
};
