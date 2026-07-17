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
  const headerMethod =
    req?.headers?.['x-forwarded-method'] ||
    req?.headers?.['X-Forwarded-Method'] ||
    req?.headers?.['request-method'];
  const raw = req?.method || headerMethod || 'POST';
  return String(raw).trim().toUpperCase() || 'POST';
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

function appwriteHeaders() {
  // Prefer full API key — dynamic function key may lack scopes.
  const key =
    process.env.APPWRITE_API_KEY ||
    process.env.APPWRITE_FUNCTION_API_KEY;
  const project =
    process.env.APPWRITE_PROJECT_ID ||
    process.env.APPWRITE_FUNCTION_PROJECT_ID;
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

function userDocUrl(userId) {
  const db = process.env.APPWRITE_DATABASE_ID;
  const col = process.env.APPWRITE_USER_COLLECTION_ID;
  return `${appwriteBase()}/databases/${db}/collections/${col}/documents/${encodeURIComponent(userId)}`;
}

function getBodyJson(req) {
  // IMPORTANT: never read req.bodyJson unless body text exists.
  // Appwrite lazily JSON.parses bodyJson and throws "Unexpected end of JSON input" on empty body.
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

  // Only touch bodyJson when we already know there is body text, or as last resort in try/catch.
  try {
    if (req.bodyJson && typeof req.bodyJson === 'object' && !Array.isArray(req.bodyJson)) {
      return req.bodyJson;
    }
  } catch (_) {
    /* empty body — Appwrite may throw while parsing bodyJson */
  }

  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    if (typeof req.body.data === 'string') {
      const nested = safeJsonParse(req.body.data);
      if (nested && typeof nested === 'object') return nested;
    }
    if (typeof req.body.body === 'string') {
      const nested = safeJsonParse(req.body.body);
      if (nested && typeof nested === 'object') return nested;
    }
    if (req.body.payload && typeof req.body.payload === 'object') {
      return req.body.payload;
    }
    if (Array.isArray(req.body.toUserIds) || req.body.toUserIds || req.body.title) {
      return req.body;
    }
  }

  return {};
}

function bodyDebug(req) {
  let bodyJsonSafe = false;
  try {
    bodyJsonSafe = Boolean(req?.bodyJson && typeof req.bodyJson === 'object');
  } catch (_) {
    bodyJsonSafe = false;
  }
  return {
    method: req?.method || null,
    path: req?.path || null,
    hasBodyJson: bodyJsonSafe,
    bodyTextLen: typeof req?.bodyText === 'string' ? req.bodyText.length : 0,
    bodyRawLen: typeof req?.bodyRaw === 'string' ? req.bodyRaw.length : 0,
    bodyType: req?.body == null ? 'null' : Array.isArray(req.body) ? 'array' : typeof req.body,
    queryKeys: req?.query && typeof req.query === 'object' ? Object.keys(req.query) : [],
  };
}

function normalizeToUserIds(raw) {
  if (Array.isArray(raw)) {
    return raw.map(String).map((s) => s.trim()).filter(Boolean);
  }
  if (typeof raw === 'string' && raw.trim()) {
    const parsed = safeJsonParse(raw);
    if (Array.isArray(parsed)) return normalizeToUserIds(parsed);
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

function getQueryJson(req) {
  if (req.query && typeof req.query === 'object' && !Array.isArray(req.query)) {
    const out = { ...req.query };
    if (typeof out.toUserIds === 'string') {
      const parsed = safeJsonParse(out.toUserIds);
      out.toUserIds = Array.isArray(parsed)
        ? parsed
        : out.toUserIds.split(',').map((s) => s.trim()).filter(Boolean);
    }
    if (typeof out.data === 'string') {
      const parsed = safeJsonParse(out.data);
      if (parsed) out.data = parsed;
    }
    return out;
  }

  const raw = req.queryString || '';
  if (!raw || typeof raw !== 'string') return {};
  try {
    const params = new URLSearchParams(raw.startsWith('?') ? raw.slice(1) : raw);
    const out = {};
    for (const [key, value] of params.entries()) out[key] = value;
    if (typeof out.toUserIds === 'string') {
      const parsed = safeJsonParse(out.toUserIds);
      out.toUserIds = Array.isArray(parsed)
        ? parsed
        : out.toUserIds.split(',').map((s) => s.trim()).filter(Boolean);
    }
    return out;
  } catch {
    return {};
  }
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

async function sendExpoPush(messages, log) {
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
      const result = await sendExpoPush(chunk, log);
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
          log?.(`Expo mixed experience IDs — splitting into ${byExperience.size} group(s)`);
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
      log?.(`Expo push ok status=${result.status} count=${chunk.length}`);
    }
  }

  await sendOneGroup(messages);
  return { pushed, errors };
}

async function relayPush({ toUserIds, title, body, channelId, data, log }) {
  const recipients = [...new Set((toUserIds || []).filter(Boolean).map(String))];
  if (!recipients.length) {
    return { pushed: 0, recipients: 0 };
  }

  if (!appwriteBase() || !process.env.APPWRITE_DATABASE_ID || !process.env.APPWRITE_USER_COLLECTION_ID) {
    throw new Error(
      'Missing APPWRITE_ENDPOINT/APPWRITE_FUNCTION_API_ENDPOINT, APPWRITE_DATABASE_ID, or APPWRITE_USER_COLLECTION_ID'
    );
  }

  const key =
    process.env.APPWRITE_API_KEY ||
    process.env.APPWRITE_FUNCTION_API_KEY;
  if (!key) {
    throw new Error('Missing APPWRITE_API_KEY / APPWRITE_FUNCTION_API_KEY');
  }

  const tokens = [];
  for (const userId of recipients) {
    try {
      const user = await fetchJson(userDocUrl(userId), { headers: appwriteHeaders() });
      const token = user?.expoPushToken;
      if (token && typeof token === 'string' && token.startsWith('ExponentPushToken')) {
        tokens.push(token);
      } else {
        log?.(`No expoPushToken for user ${userId}`);
      }
    } catch (err) {
      log?.(`Failed reading user ${userId}: ${err?.message || err}`);
    }
  }

  if (!tokens.length) {
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

  const pushResult = await sendExpoPushMessages(messages, log);
  return {
    pushed: pushResult.pushed,
    recipients: recipients.length,
    pushErrors: pushResult.errors,
  };
}

module.exports = async ({ req, res, log, error }) => {
  try {
    const path = String(req.path || req.url || '/');
    if (path.includes('favicon.ico')) {
      return res.send('', 204, cors);
    }

    const method = resolveMethod(req);
    log?.(`push-relay method=${method} path=${path}`);

    if (method === 'OPTIONS' || method === 'HEAD') {
      return res.send('', 204, cors);
    }

    if (method !== 'POST' && method !== 'GET') {
      return res.json({ error: 'Method not allowed', method }, 405, cors);
    }

    const parsed = { ...getQueryJson(req), ...getBodyJson(req) };
    const toUserIds = normalizeToUserIds(parsed.toUserIds || parsed.userIds || parsed.userId);

    if (!toUserIds.length) {
      return res.json(
        {
          error: 'toUserIds is required',
          hint:
            'POST JSON to the Function Domain URL (Functions → Domains). Example: {"toUserIds":["USER_DOCUMENT_ID"],"title":"Test","body":"Hello"}',
          receivedKeys: Object.keys(parsed || {}),
          debug: bodyDebug(req),
        },
        400,
        cors
      );
    }

    const result = await relayPush({
      toUserIds,
      title: parsed.title,
      body: parsed.body,
      channelId: parsed.channelId,
      data: parsed.data,
      log,
    });

    return res.json({ ok: true, ...result }, 200, cors);
  } catch (err) {
    error?.(err?.message || err);
    return res.json({ error: String(err?.message || err || 'Push relay failed') }, 500, cors);
  }
};
