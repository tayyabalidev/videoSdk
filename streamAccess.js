/**
 * Appwrite Function — paid live stream processing (replaces Node server for Appwrite deploy).
 *
 * Routes (HTTP):
 *   GET  /api/health
 *   GET  /api/check-stream-access?streamId=&userId=
 *   POST /api/create-stream-access-payment-intent  { amount, currency, buyerId, hostId, streamId }
 *
 * Deploy in Appwrite Console, then set in app .env:
 *   EXPO_PUBLIC_PROCESSING_SERVER_URL=https://YOUR_FUNCTION_ID.nyc.appwrite.run
 *
 * Function variables: STRIPE_SECRET_KEY, APPWRITE_DATABASE_ID,
 *   APPWRITE_LIVE_STREAMS_COLLECTION_ID, APPWRITE_STREAM_PURCHASES_COLLECTION_ID
 * (APPWRITE_ENDPOINT / PROJECT_ID / API_KEY are injected at runtime or set manually)
 */
'use strict';

const axios = require('axios');
const Stripe = require('stripe');

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

async function getDocument(collectionId, documentId) {
  const db = process.env.APPWRITE_DATABASE_ID;
  const url = `${appwriteBase()}/databases/${db}/collections/${collectionId}/documents/${documentId}`;
  const { data } = await axios.get(url, { headers: appwriteHeaders() });
  return data;
}

async function listDocuments(collectionId, queries = []) {
  const db = process.env.APPWRITE_DATABASE_ID;
  const params = new URLSearchParams();
  queries.forEach((q) => params.append('queries[]', q));
  const qs = params.toString();
  const url = `${appwriteBase()}/databases/${db}/collections/${collectionId}/documents${qs ? `?${qs}` : ''}`;
  const { data } = await axios.get(url, { headers: appwriteHeaders() });
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
    if (!isPaidStream(stream)) return { allowed: true };
    if (stream.hostId === userId) return { allowed: true };

    const purchases = await listDocuments(process.env.APPWRITE_STREAM_PURCHASES_COLLECTION_ID, [
      JSON.stringify({ method: 'equal', attribute: 'streamId', values: [streamId] }),
      JSON.stringify({ method: 'equal', attribute: 'buyerId', values: [userId] }),
      JSON.stringify({ method: 'equal', attribute: 'status', values: ['completed'] }),
      JSON.stringify({ method: 'limit', values: [1] }),
    ]);
    return purchases.length > 0
      ? { allowed: true }
      : { allowed: false, reason: 'payment_required' };
  } catch (error) {
    const status = error?.response?.status;
    if (status === 404) return { allowed: false, reason: 'stream_not_found' };
    return { allowed: false, reason: error?.message || 'access_check_failed' };
  }
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

function getStripe() {
  const key = String(process.env.STRIPE_SECRET_KEY || '').trim();
  if (!key) return null;
  return new Stripe(key);
}

module.exports = async ({ req, res, log }) => {
  try {
    const method = String(req.method || 'GET').toUpperCase();
    if (method === 'OPTIONS') {
      return res.send('', 204, cors);
    }

    const path = getPath(req);
    const query = getQuery(req);

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

      const stripe = getStripe();
      if (!stripe) {
        return res.json(
          { error: 'Stripe not configured. Set STRIPE_SECRET_KEY on this function.' },
          500,
          cors
        );
      }

      if (isConfigured()) {
        const access = await checkStreamAccess(streamId, buyerId);
        if (access.allowed) {
          return res.json({ error: 'You already have access to this stream' }, 400, cors);
        }
      }

      const amountInCents = Math.round(parseFloat(amount) * 100);
      const paymentIntent = await stripe.paymentIntents.create({
        amount: amountInCents,
        currency: String(currency || 'usd').toLowerCase(),
        metadata: {
          buyerId: String(buyerId),
          hostId: String(hostId),
          streamId: String(streamId),
          type: 'stream_access',
        },
        automatic_payment_methods: { enabled: true },
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
