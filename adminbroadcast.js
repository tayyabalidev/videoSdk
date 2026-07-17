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
  // Prefer a full API key. Fall back to dynamic function key if scopes are enabled.
  const key =
    (process.env.APPWRITE_API_KEY && String(process.env.APPWRITE_API_KEY).trim()) ||
    (process.env.APPWRITE_FUNCTION_API_KEY && String(process.env.APPWRITE_FUNCTION_API_KEY).trim()) ||
    '';
  const project =
    (process.env.APPWRITE_PROJECT_ID && String(process.env.APPWRITE_PROJECT_ID).trim()) ||
    (process.env.APPWRITE_FUNCTION_PROJECT_ID && String(process.env.APPWRITE_FUNCTION_PROJECT_ID).trim()) ||
    '';

  if (!key) {
    throw new Error(
      'Missing API key. In Function Settings → Variables, add APPWRITE_API_KEY (API Keys → create key with databases.read + databases.write).'
    );
  }
  if (!project) {
    throw new Error(
      'Missing APPWRITE_PROJECT_ID. Add APPWRITE_PROJECT_ID=6854922e0036a1e8dee6 in Function Settings → Variables.'
    );
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
    if (
      res.status === 401 ||
      res.status === 403 ||
      String(message).toLowerCase().includes('not authorized')
    ) {
      err.message =
        `${message} — Set function env APPWRITE_API_KEY to a full API key with scopes: databases.read, databases.write. Also set APPWRITE_DATABASE_ID, APPWRITE_USER_COLLECTION_ID, APPWRITE_NOTIFICATIONS_COLLECTION_ID.`;
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

/**
 * One paginated pass — collect user ids + expoPushToken (no per-user getDocument).
 */
async function listAllUsers(excludeUserId) {
  const userCol = process.env.APPWRITE_USER_COLLECTION_ID;
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

async function broadcast({ creatorUserId, creatorEmail, type, postId, skipInbox, log }) {
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

  const started = Date.now();
  const creator = await fetchJson(`${collectionUrl(userCol)}/${encodeURIComponent(creatorUserId)}`, {
    headers: appwriteHeaders(),
  });

  const fromUsername = creator?.username || 'ASAB';
  const fromUserAvatar = normalizeAvatar(creator?.avatar);

  // Fast path: tokens come from listDocuments (avoids N× getDocument which caused timeouts).
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
  let inboxSkipped = false;

  // In-app inbox second (optional). Soft time budget to avoid Cloudflare 524 / Appwrite timeout.
  const softDeadlineMs = Number(process.env.BROADCAST_SOFT_DEADLINE_MS || 45000);
  if (!skipInbox && process.env.APPWRITE_NOTIFICATIONS_COLLECTION_ID) {
    const batchSize = 40;
    const createdAt = new Date().toISOString();
    for (let i = 0; i < users.length; i += batchSize) {
      if (Date.now() - started > softDeadlineMs) {
        inboxSkipped = true;
        log?.(
          `Soft deadline reached after ${notified} inbox writes — returning push results to avoid timeout`
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
  } else {
    inboxSkipped = true;
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

/**
 * Expo requires all tokens in one request to share the same experience/project.
 * Mixed EAS project tokens cause PUSH_TOO_MANY_EXPERIENCE_IDS — split and retry.
 */
async function sendExpoPushMessages(messages, log) {
  if (!messages.length) return { pushed: 0, errors: [] };

  const errors = [];
  let pushed = 0;

  async function sendOneGroup(group) {
    if (!group.length) return;
    for (let i = 0; i < group.length; i += 100) {
      const chunk = group.slice(i, i + 100);
      const result = await postExpoPush(chunk);
      const err0 = result.data?.errors?.[0];
      const code = err0?.code || '';

      if (
        !result.ok &&
        code === 'PUSH_TOO_MANY_EXPERIENCE_IDS' &&
        chunk.length > 1
      ) {
        const details = err0?.details && typeof err0.details === 'object' ? err0.details : null;
        if (details) {
          const byExperience = new Map();
          for (const msg of chunk) {
            const exp = details[msg.to] || '__unknown__';
            if (!byExperience.has(exp)) byExperience.set(exp, []);
            byExperience.get(exp).push(msg);
          }
          log?.(
            `Expo mixed experience IDs — splitting into ${byExperience.size} group(s)`
          );
          for (const [, subgroup] of byExperience) {
            await sendOneGroup(subgroup);
          }
          continue;
        }

        log?.('Expo mixed experience IDs — sending one token at a time');
        for (const msg of chunk) {
          await sendOneGroup([msg]);
        }
        continue;
      }

      if (!result.ok) {
        const message =
          err0?.message ||
          (result.text && result.text.slice(0, 200)) ||
          `Expo push HTTP ${result.status}`;
        errors.push(message);
        log?.(`Expo push failed: ${message}`);
        continue;
      }

      pushed += chunk.length;
    }
  }

  await sendOneGroup(messages);
  return { pushed, errors };
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
    const skipInbox =
      body.skipInbox === true ||
      body.skipInbox === 'true' ||
      body.skipInbox === '1';

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
