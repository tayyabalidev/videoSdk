/**
 * Appwrite Function — paid live stream processing (zero npm deps — uses fetch only).
 *
 * Entry file: index.js OR streamAccess.js (must match Appwrite Settings → Entrypoint).
 *
 * Routes:
 *   GET  /api/health
 *   GET  /api/check-stream-access?streamId=&userId=
 *   POST /api/create-stream-access-payment-intent
 */
'use strict';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization',
};

function appwriteHeaders() {
  const project =
    process.env.APPWRITE_FUNCTION_PROJECT_ID || process.env.APPWRITE_PROJECT_ID;
  const key =
    process.env.APPWRITE_FUNCTION_API_KEY || process.env.APPWRITE_API_KEY;
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

function isConfigured() {
  return Boolean(
    appwriteBase() &&
      (process.env.APPWRITE_FUNCTION_PROJECT_ID || process.env.APPWRITE_PROJECT_ID) &&
      (process.env.APPWRITE_FUNCTION_API_KEY || process.env.APPWRITE_API_KEY) &&
      process.env.APPWRITE_DATABASE_ID &&
      process.env.APPWRITE_LIVE_STREAMS_COLLECTION_ID &&
      process.env.APPWRITE_STREAM_PURCHASES_COLLECTION_ID
  );
}

async function appwriteGet(url) {
  const response = await fetch(url, { headers: appwriteHeaders() });
  if (!response.ok) {
    const err = new Error(`appwrite_get_failed (${response.status})`);
    err.status = response.status;
    throw err;
  }
  return response.json();
}

async function getDocument(collectionId, documentId) {
  const db = process.env.APPWRITE_DATABASE_ID;
  const url = `${appwriteBase()}/databases/${db}/collections/${collectionId}/documents/${documentId}`;
  return appwriteGet(url);
}

async function listDocuments(collectionId, queries = []) {
  const db = process.env.APPWRITE_DATABASE_ID;
  const params = new URLSearchParams();
  queries.forEach((q) => params.append('queries[]', q));
  const qs = params.toString();
  const url = `${appwriteBase()}/databases/${db}/collections/${collectionId}/documents${qs ? `?${qs}` : ''}`;
  const data = await appwriteGet(url);
  return data?.documents || [];
}

function isPaidStream(stream) {
  if (!stream) return false;
  const price = parseFloat(stream.price);
  const hasPrice = Number.isFinite(price) && price > 0;
  if (!hasPrice) return false;
  if (stream.isPaid === true || stream.isPaid === 'true' || stream.isPaid === 1) {
    return true;
  }
  return hasPrice;
}

async function checkStreamAccess(streamId, userId) {
  if (!streamId || !userId) {
    return { allowed: false, reason: 'streamId and userId are required' };
  }
  if (!isConfigured()) {
    return { allowed: true, reason: 'appwrite_not_configured' };
  }
  try {
    const stream = await getDocument(
      process.env.APPWRITE_LIVE_STREAMS_COLLECTION_ID,
      streamId
    );
    if (!isPaidStream(stream)) {
      return { allowed: true, reason: 'not_paid_stream' };
    }
    if (stream.hostId === userId) {
      return { allowed: true, reason: 'host_access' };
    }

    const purchases = await listDocuments(process.env.APPWRITE_STREAM_PURCHASES_COLLECTION_ID, [
      JSON.stringify({ method: 'equal', attribute: 'streamId', values: [streamId] }),
      JSON.stringify({ method: 'equal', attribute: 'buyerId', values: [userId] }),
      JSON.stringify({ method: 'equal', attribute: 'status', values: ['completed'] }),
      JSON.stringify({ method: 'limit', values: [1] }),
    ]);
    return purchases.length > 0
      ? { allowed: true, reason: 'purchase_verified' }
      : { allowed: false, reason: 'payment_required' };
  } catch (error) {
    const status = error?.status;
    if (status === 404) return { allowed: false, reason: 'stream_not_found' };
    return { allowed: false, reason: error?.message || 'access_check_failed' };
  }
}

async function createStripePaymentIntent({ amountInCents, currency, buyerId, hostId, streamId }) {
  const key = String(process.env.STRIPE_SECRET_KEY || '').trim();
  if (!key) {
    throw new Error('STRIPE_SECRET_KEY is not set on this function');
  }

  const body = new URLSearchParams({
    amount: String(amountInCents),
    currency: String(currency || 'usd').toLowerCase(),
    'automatic_payment_methods[enabled]': 'true',
    'metadata[buyerId]': String(buyerId),
    'metadata[hostId]': String(hostId),
    'metadata[streamId]': String(streamId),
    'metadata[type]': 'stream_access',
  });

  const response = await fetch('https://api.stripe.com/v1/payment_intents', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error?.message || `Stripe error (${response.status})`);
  }
  return data;
}

function getPath(req) {
  const raw =
    (typeof req.path === 'string' && req.path) ||
    (typeof req.pathname === 'string' && req.pathname) ||
    '';
  if (raw) return raw.split('?')[0];
  const url = typeof req.url === 'string' ? req.url : '';
  if (!url) return '/';
  try {
    if (url.includes('://')) return new URL(url).pathname;
    return url.split('?')[0] || '/';
  } catch (_) {
    return url.split('?')[0] || '/';
  }
}

function getQuery(req) {
  if (req.query && typeof req.query === 'object' && !Array.isArray(req.query)) {
    return req.query;
  }
  const raw =
    (typeof req.queryString === 'string' && req.queryString) ||
    (typeof req.url === 'string' && req.url.includes('?') ? req.url.split('?')[1] : '') ||
    '';
  const params = new URLSearchParams(raw);
  const out = {};
  params.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function getBodyJson(req) {
  if (req.bodyJson && typeof req.bodyJson === 'object' && !Array.isArray(req.bodyJson)) {
    return req.bodyJson;
  }
  const text =
    (typeof req.bodyText === 'string' && req.bodyText) ||
    (typeof req.bodyRaw === 'string' && req.bodyRaw) ||
    (typeof req.body === 'string' && req.body) ||
    '';
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch (_) {
    return {};
  }
}

module.exports = async ({ req, res, log }) => {
  try {
    const method = String(req.method || 'GET').toUpperCase();
    if (method === 'OPTIONS') {
      return res.send('', 204, cors);
    }

    const path = getPath(req);
    const query = getQuery(req);

    if (path === '/' || path === '') {
      return res.json(
        {
          ok: true,
          service: 'stream-access',
          routes: ['/api/health', '/api/check-stream-access', '/api/create-stream-access-payment-intent'],
        },
        200,
        cors
      );
    }

    if (path === '/api/health' || path.endsWith('/api/health')) {
      return res.json(
        {
          status: 'ok',
          service: 'stream-access',
          appwriteConfigured: isConfigured(),
          stripeConfigured: Boolean(process.env.STRIPE_SECRET_KEY),
        },
        200,
        cors
      );
    }

    if (
      method === 'GET' &&
      (path === '/api/check-stream-access' || path.endsWith('/api/check-stream-access'))
    ) {
      const streamId = String(query.streamId || '').trim();
      const userId = String(query.userId || '').trim();
      if (!streamId || !userId) {
        return res.json({ error: 'streamId and userId are required' }, 400, cors);
      }
      const access = await checkStreamAccess(streamId, userId);
      return res.json(
        { allowed: access.allowed, reason: access.reason || null },
        200,
        cors
      );
    }

    if (
      method === 'POST' &&
      (path === '/api/create-stream-access-payment-intent' ||
        path.endsWith('/api/create-stream-access-payment-intent'))
    ) {
      const body = getBodyJson(req);
      const { amount, currency = 'usd', buyerId, hostId, streamId } = body;

      if (!amount || amount <= 0) {
        return res.json({ error: 'Invalid amount' }, 400, cors);
      }
      if (!buyerId || !hostId || !streamId) {
        return res.json({ error: 'buyerId, hostId, and streamId are required' }, 400, cors);
      }

      if (isConfigured()) {
        const access = await checkStreamAccess(streamId, buyerId);
        if (access.allowed) {
          return res.json({ error: 'You already have access to this stream' }, 400, cors);
        }
      }

      const amountInCents = Math.round(parseFloat(amount) * 100);
      const paymentIntent = await createStripePaymentIntent({
        amountInCents,
        currency,
        buyerId,
        hostId,
        streamId,
      });

      return res.json(
        {
          clientSecret: paymentIntent.client_secret,
          paymentIntentId: paymentIntent.id,
        },
        200,
        cors
      );
    }

    return res.json({ error: 'Not found', path, method }, 404, cors);
  } catch (error) {
    try {
      log(String(error?.message || error));
    } catch (_) {}
    return res.json(
      { error: error?.message || 'stream-access function failed' },
      500,
      cors
    );
  }
};
