/**
 * Appwrite Function — admin/CEO content broadcast (Expo push + optional inbox).
 * Entrypoint for manual upload: adminbroadcast.js
 *
 * Default: push-only (skip inbox) with hard time budget so Cloudflare/Appwrite
 * do not hang for 5 minutes.
 */
'use strict';

const crypto = require('crypto');

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const FETCH_TIMEOUT_MS = Number(process.env.BROADCAST_FETCH_TIMEOUT_MS || 12000);
const TOTAL_BUDGET_MS = Number(process.env.BROADCAST_TOTAL_BUDGET_MS || 20000);
const MAX_USER_PAGES = Number(process.env.BROADCAST_MAX_USER_PAGES || 30);

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

  if (!key) throw new Error('Missing APPWRITE_API_KEY (databases.read + databases.write).');
  if (!project) throw new Error('Missing APPWRITE_PROJECT_ID.');
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
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
        err.message = `${message} — Check APPWRITE_API_KEY and collection IDs.`;
      }
      throw err;
    }
    return data;
  } catch (e) {
    if (e && e.name === 'AbortError') {
      throw new Error(`Request timed out after ${FETCH_TIMEOUT_MS}ms: ${url.slice(0, 120)}`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function qLimit(limit) {
  return JSON.stringify({ method: 'limit', values: [Number(limit)] });
}

function qCursorAfter(documentId) {
  return JSON.stringify({ method: 'cursorAfter', values: [String(documentId)] });
}

async function listAllUsers(excludeUserId, log, deadlineAt) {
  const userCol = process.env.APPWRITE_USER_COLLECTION_ID;
  if (!userCol) throw new Error('APPWRITE_USER_COLLECTION_ID not configured');

  const users = [];
  let cursor = null;
  const pageSize = 100;
  let pages = 0;

  while (pages < MAX_USER_PAGES) {
    if (Date.now() >= deadlineAt) {
      log?.(`listAllUsers stopped early (budget) after ${pages} pages / ${users.length} users`);
      break;
    }

    const queries = [qLimit(pageSize)];
    if (cursor) queries.push(qCursorAfter(cursor));

    const qs = queries.map((q) => `queries[]=${encodeURIComponent(q)}`).join('&');
    const data = await fetchJson(`${collectionUrl(userCol)}?${qs}`, {
      headers: appwriteHeaders(),
    });

    const docs = data.documents || [];
    pages += 1;

    for (const doc of docs) {
      if (excludeUserId && doc.$id === excludeUserId) continue;
      users.push({
        id: doc.$id,
        expoPushToken: doc.expoPushToken || '',
      });
    }

    if (docs.length < pageSize) break;

    const nextCursor = docs[docs.length - 1].$id;
    if (!nextCursor || nextCursor === cursor) {
      log?.('listAllUsers stopped: cursor did not advance');
      break;
    }
    cursor = nextCursor;
  }

  if (pages >= MAX_USER_PAGES) {
    log?.(`listAllUsers hit MAX_USER_PAGES=${MAX_USER_PAGES} (${users.length} users)`);
  }

  return users;
}

async function postExpoPush(messages) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(messages),
      signal: controller.signal,
    });
    const text = await res.text().catch(() => '');
    const data = safeJsonParse(text);
    return { ok: res.ok, status: res.status, data, text };
  } catch (e) {
    if (e && e.name === 'AbortError') {
      return { ok: false, status: 0, data: null, text: `Expo push timed out after ${FETCH_TIMEOUT_MS}ms` };
    }
    return { ok: false, status: 0, data: null, text: String(e && e.message ? e.message : e) };
  } finally {
    clearTimeout(timer);
  }
}

async function sendExpoPushMessages(messages, log, deadlineAt) {
  if (!messages.length) return { pushed: 0, errors: [], stoppedEarly: false };

  const errors = [];
  let pushed = 0;
  let stoppedEarly = false;

  async function mapPool(items, concurrency, worker) {
    const queue = [...items];
    const runners = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (queue.length) {
        if (Date.now() >= deadlineAt) {
          stoppedEarly = true;
          queue.length = 0;
          return;
        }
        const item = queue.shift();
        if (item === undefined) return;
        await worker(item);
      }
    });
    await Promise.all(runners);
  }

  async function sendChunk(chunk) {
    if (!chunk.length) return;
    if (Date.now() >= deadlineAt) {
      stoppedEarly = true;
      return;
    }

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
          if (Date.now() >= deadlineAt) {
            stoppedEarly = true;
            break;
          }
          await sendChunk(subgroup);
        }
        return;
      }

      // Cap singles so we never hang for minutes.
      const singles = chunk.slice(0, 40);
      log?.(`Expo mixed experience IDs — sending up to ${singles.length} singles`);
      await mapPool(singles, 10, async (msg) => {
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
      if (chunk.length > singles.length) stoppedEarly = true;
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
    if (Date.now() >= deadlineAt) {
      stoppedEarly = true;
      break;
    }
    await sendChunk(messages.slice(i, i + 100));
  }

  return { pushed, errors, stoppedEarly };
}

async function broadcast({ creatorUserId, creatorEmail, type, postId, log }) {
  if (!isPlatformBroadcaster({ userId: creatorUserId, email: creatorEmail })) {
    throw new Error('Not authorized for platform broadcast. Configure ADMIN_EMAILS / CEO_USER_ID.');
  }

  if (!appwriteBase() || !process.env.APPWRITE_DATABASE_ID) {
    throw new Error('Missing APPWRITE_ENDPOINT / APPWRITE_DATABASE_ID');
  }

  const started = Date.now();
  const deadlineAt = started + TOTAL_BUDGET_MS;

  const userCol = process.env.APPWRITE_USER_COLLECTION_ID;
  const creator = await fetchJson(`${collectionUrl(userCol)}/${encodeURIComponent(creatorUserId)}`, {
    headers: appwriteHeaders(),
  });

  const users = await listAllUsers(creatorUserId, log, deadlineAt);
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

  const pushResult = await sendExpoPushMessages(messages, log, deadlineAt);
  log?.(`Pushed ${pushResult.pushed}/${tokens.length} in ${Date.now() - started}ms`);

  return {
    recipients: users.length,
    notified: 0,
    pushed: pushResult.pushed,
    tokensFound: tokens.length,
    inboxSkipped: true,
    stoppedEarly: !!pushResult.stoppedEarly || Date.now() >= deadlineAt,
    elapsedMs: Date.now() - started,
    pushErrors: pushResult.errors.slice(0, 5),
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

    if (!creatorUserId || !type) {
      return res.json(
        {
          error: 'creatorUserId and type required',
          howToFix:
            'In Postman use Method POST, URL without //, Body raw JSON with creatorUserId + type. Opening the domain in a browser is GET with empty body.',
          hintPost:
            'POST https://6a4878b30030831b2cf1.nyc.appwrite.run  JSON: {"creatorUserId":"697241bb002e97efc1e9","creatorEmail":"randydillon97@gmail.com","type":"video_post","postId":"browser-test"}',
          hintGet:
            'GET https://6a4878b30030831b2cf1.nyc.appwrite.run/?creatorUserId=697241bb002e97efc1e9&creatorEmail=randydillon97%40gmail.com&type=video_post&postId=browser-test',
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
      log,
    });

    return res.json({ ok: true, ...result }, 200, cors);
  } catch (e) {
    error?.(e?.message || e);
    const status = String(e?.message || '').includes('Not authorized') ? 403 : 500;
    return res.json({ error: e?.message || 'Broadcast failed' }, status, cors);
  }
};
