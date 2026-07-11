/**
 * Paid live stream access — shared logic for Node server and Appwrite Function.
 *
 * Routes:
 *   GET  /api/health
 *   GET  /api/check-stream-access?streamId=&userId=
 *   POST /api/create-stream-access-payment-intent  { streamId, buyerId }
 *   POST /api/confirm-stream-access-payment        { paymentIntentId, purchaseId? }
 */
'use strict';

const crypto = require('crypto');

const PLATFORM_FEE_RATE = 0.1;
const MIN_PRICE = 0.99;
const MAX_PRICE = 999.99;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function readEnv(key, fallback = '') {
  const v = process.env[key];
  return v != null && String(v).trim() ? String(v).trim() : fallback;
}

function appwriteConfig() {
  return {
    endpoint: readEnv(
      'APPWRITE_FUNCTION_API_ENDPOINT',
      readEnv('APPWRITE_ENDPOINT', 'https://nyc.cloud.appwrite.io/v1')
    ).replace(/\/$/, ''),
    projectId: readEnv('APPWRITE_FUNCTION_PROJECT_ID', readEnv('APPWRITE_PROJECT_ID', '')),
    apiKey: readEnv('APPWRITE_FUNCTION_API_KEY', readEnv('APPWRITE_API_KEY', '')),
    databaseId: readEnv('APPWRITE_DATABASE_ID', ''),
    liveStreamsCollectionId: readEnv(
      'APPWRITE_LIVE_STREAMS_COLLECTION_ID',
      '68f20f1f00332e083aff'
    ),
    streamPurchasesCollectionId: readEnv('APPWRITE_STREAM_PURCHASES_COLLECTION_ID', ''),
  };
}

function isPaidStream(stream) {
  if (!stream) return false;
  if (stream.isPaid === true || stream.isPaid === 'true' || stream.isPaid === 1) {
    const price = Number(stream.price);
    return Number.isFinite(price) && price > 0;
  }
  return false;
}

function calculateFees(amount) {
  const value = Number(amount);
  const platformFee = Math.round(value * PLATFORM_FEE_RATE * 100) / 100;
  const hostReceives = Math.round((value - platformFee) * 100) / 100;
  return { amount: value, platformFee, hostReceives };
}

function appwriteHeaders(cfg) {
  return {
    'X-Appwrite-Project': cfg.projectId,
    'X-Appwrite-Key': cfg.apiKey,
    'Content-Type': 'application/json',
  };
}

function collectionDocsUrl(cfg, collectionId) {
  return `${cfg.endpoint}/databases/${cfg.databaseId}/collections/${collectionId}/documents`;
}

async function appwriteGetDocument(cfg, collectionId, documentId) {
  const url = `${collectionDocsUrl(cfg, collectionId)}/${encodeURIComponent(documentId)}`;
  const res = await fetch(url, { headers: appwriteHeaders(cfg) });
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Appwrite getDocument failed (${res.status}): ${body.slice(0, 240)}`);
  }
  return res.json();
}

async function appwriteListDocuments(cfg, collectionId, queryStrings) {
  const qs = (queryStrings || [])
    .map((q) => `queries[]=${encodeURIComponent(q)}`)
    .join('&');
  const url = `${collectionDocsUrl(cfg, collectionId)}?${qs}`;
  const res = await fetch(url, { headers: appwriteHeaders(cfg) });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Appwrite listDocuments failed (${res.status}): ${body.slice(0, 240)}`);
  }
  const data = await res.json();
  return data.documents || [];
}

async function appwriteCreateDocument(cfg, collectionId, documentId, data) {
  const res = await fetch(collectionDocsUrl(cfg, collectionId), {
    method: 'POST',
    headers: appwriteHeaders(cfg),
    body: JSON.stringify({ documentId, data }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Appwrite createDocument failed (${res.status}): ${body.slice(0, 240)}`);
  }
  return res.json();
}

async function appwriteUpdateDocument(cfg, collectionId, documentId, data) {
  const url = `${collectionDocsUrl(cfg, collectionId)}/${encodeURIComponent(documentId)}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: appwriteHeaders(cfg),
    body: JSON.stringify({ data }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Appwrite updateDocument failed (${res.status}): ${body.slice(0, 240)}`);
  }
  return res.json();
}

function isBackendConfigured(cfg) {
  return Boolean(
    cfg.endpoint &&
      cfg.projectId &&
      cfg.apiKey &&
      cfg.databaseId &&
      cfg.liveStreamsCollectionId &&
      cfg.streamPurchasesCollectionId
  );
}

async function findCompletedPurchase(cfg, streamId, buyerId) {
  const docs = await appwriteListDocuments(cfg, cfg.streamPurchasesCollectionId, [
    `equal("streamId", ["${streamId}"])`,
    `equal("buyerId", ["${buyerId}"])`,
    `equal("status", ["completed"])`,
    'limit(1)',
  ]);
  return docs[0] || null;
}

async function findPurchaseByPaymentIntent(cfg, paymentIntentId) {
  if (!paymentIntentId) return null;
  const docs = await appwriteListDocuments(cfg, cfg.streamPurchasesCollectionId, [
    `equal("paymentIntentId", ["${paymentIntentId}"])`,
    'limit(1)',
  ]);
  return docs[0] || null;
}

/**
 * Check whether a user may watch a stream.
 * @returns {Promise<object>}
 */
async function checkStreamAccess(streamId, userId) {
  const cfg = appwriteConfig();
  const sid = String(streamId || '').trim();
  const uid = String(userId || '').trim();

  if (!sid || !uid) {
    return { allowed: false, reason: 'missing_params' };
  }

  if (!isBackendConfigured(cfg)) {
    return { allowed: false, reason: 'appwrite_not_configured' };
  }

  let stream;
  try {
    stream = await appwriteGetDocument(cfg, cfg.liveStreamsCollectionId, sid);
  } catch (e) {
    return { allowed: false, reason: 'server_error', message: e.message };
  }

  if (!stream) {
    return { allowed: false, reason: 'stream_not_found' };
  }

  if (!isPaidStream(stream)) {
    return { allowed: true, isPaid: false };
  }

  const price = Number(stream.price);
  const currency = String(stream.currency || 'USD').toUpperCase();

  if (String(stream.hostId || '') === uid) {
    return { allowed: true, isPaid: true, isHost: true, price, currency };
  }

  try {
    const purchase = await findCompletedPurchase(cfg, sid, uid);
    if (purchase) {
      return {
        allowed: true,
        isPaid: true,
        purchaseId: purchase.$id,
        price,
        currency,
      };
    }
  } catch (e) {
    return { allowed: false, reason: 'server_error', isPaid: true, message: e.message };
  }

  return {
    allowed: false,
    reason: 'payment_required',
    isPaid: true,
    price,
    currency,
  };
}

function validateTicketPrice(price) {
  const value = Number(price);
  if (!Number.isFinite(value) || value < MIN_PRICE || value > MAX_PRICE) {
    return {
      ok: false,
      error: `Price must be between $${MIN_PRICE.toFixed(2)} and $${MAX_PRICE.toFixed(2)}.`,
    };
  }
  return { ok: true, price: Math.round(value * 100) / 100 };
}

/**
 * Create Stripe PaymentIntent + pending streamPurchases document.
 */
async function createStreamAccessPaymentIntent(stripe, { streamId, buyerId }) {
  const cfg = appwriteConfig();
  const sid = String(streamId || '').trim();
  const bid = String(buyerId || '').trim();

  if (!sid || !bid) {
    return { status: 400, body: { error: 'streamId and buyerId are required' } };
  }

  if (!stripe) {
    return { status: 500, body: { error: 'Stripe not configured' } };
  }

  if (!isBackendConfigured(cfg)) {
    return { status: 503, body: { error: 'Stream access backend not configured' } };
  }

  const stream = await appwriteGetDocument(cfg, cfg.liveStreamsCollectionId, sid);
  if (!stream) {
    return { status: 404, body: { error: 'Stream not found' } };
  }

  if (!isPaidStream(stream)) {
    return { status: 400, body: { error: 'This stream is free — no purchase required' } };
  }

  if (String(stream.hostId || '') === bid) {
    return { status: 400, body: { error: 'Host already has access to their own stream' } };
  }

  if (stream.isLive === false || stream.status === 'ended') {
    return { status: 400, body: { error: 'This stream is no longer live' } };
  }

  const priceCheck = validateTicketPrice(stream.price);
  if (!priceCheck.ok) {
    return { status: 400, body: { error: priceCheck.error } };
  }

  const existing = await findCompletedPurchase(cfg, sid, bid);
  if (existing) {
    return {
      status: 200,
      body: {
        alreadyPurchased: true,
        purchaseId: existing.$id,
        allowed: true,
      },
    };
  }

  const currency = String(stream.currency || 'USD').toLowerCase();
  const { amount, platformFee, hostReceives } = calculateFees(priceCheck.price);
  const amountInCents = Math.round(amount * 100);
  const purchaseId = crypto.randomUUID().replace(/-/g, '').slice(0, 20);

  await appwriteCreateDocument(cfg, cfg.streamPurchasesCollectionId, purchaseId, {
    streamId: sid,
    buyerId: bid,
    hostId: String(stream.hostId || ''),
    amount,
    platformFee,
    hostReceives,
    status: 'pending',
    paymentIntentId: '',
    currency: currency.toUpperCase(),
    purchasedAt: null,
  });

  let paymentIntent;
  try {
    paymentIntent = await stripe.paymentIntents.create({
      amount: amountInCents,
      currency,
      metadata: {
        type: 'stream_access',
        streamId: sid,
        buyerId: bid,
        hostId: String(stream.hostId || ''),
        purchaseId,
        platformFee: String(platformFee),
        hostReceives: String(hostReceives),
      },
      automatic_payment_methods: { enabled: true },
    });
  } catch (e) {
    await appwriteUpdateDocument(cfg, cfg.streamPurchasesCollectionId, purchaseId, {
      status: 'failed',
    }).catch(() => {});
    return { status: 500, body: { error: e.message || 'Failed to create payment intent' } };
  }

  await appwriteUpdateDocument(cfg, cfg.streamPurchasesCollectionId, purchaseId, {
    paymentIntentId: paymentIntent.id,
  });

  return {
    status: 200,
    body: {
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      purchaseId,
      amount,
      platformFee,
      hostReceives,
      currency: currency.toUpperCase(),
      streamId: sid,
      hostId: String(stream.hostId || ''),
    },
  };
}

/**
 * Verify Stripe payment succeeded and mark purchase completed.
 */
async function confirmStreamAccessPayment(stripe, { paymentIntentId, purchaseId }) {
  const cfg = appwriteConfig();
  const piId = String(paymentIntentId || '').trim();

  if (!piId) {
    return { status: 400, body: { error: 'paymentIntentId is required' } };
  }

  if (!stripe) {
    return { status: 500, body: { error: 'Stripe not configured' } };
  }

  if (!isBackendConfigured(cfg)) {
    return { status: 503, body: { error: 'Stream access backend not configured' } };
  }

  const paymentIntent = await stripe.paymentIntents.retrieve(piId);
  if (paymentIntent.metadata?.type !== 'stream_access') {
    return { status: 400, body: { error: 'Not a stream access payment' } };
  }

  if (paymentIntent.status !== 'succeeded') {
    return {
      status: 200,
      body: {
        success: false,
        status: paymentIntent.status,
        message: `Payment status: ${paymentIntent.status}`,
      },
    };
  }

  const resolvedPurchaseId =
    String(purchaseId || '').trim() || String(paymentIntent.metadata?.purchaseId || '').trim();

  let purchase =
    (resolvedPurchaseId &&
      (await appwriteGetDocument(cfg, cfg.streamPurchasesCollectionId, resolvedPurchaseId))) ||
    (await findPurchaseByPaymentIntent(cfg, piId));

  if (!purchase) {
    return { status: 404, body: { error: 'Purchase record not found' } };
  }

  const finalized = await finalizeStreamPurchaseRecord(cfg, purchase, piId);

  return {
    status: 200,
    body: {
      success: true,
      allowed: true,
      purchaseId: finalized.$id,
      streamId: finalized.streamId,
      buyerId: finalized.buyerId,
      amount: finalized.amount,
      status: 'completed',
    },
  };
}

async function finalizeStreamPurchaseRecord(cfg, purchase, paymentIntentId) {
  if (!purchase || purchase.status === 'completed') {
    return purchase;
  }
  return appwriteUpdateDocument(cfg, cfg.streamPurchasesCollectionId, purchase.$id, {
    status: 'completed',
    paymentIntentId: String(paymentIntentId || purchase.paymentIntentId || ''),
    purchasedAt: new Date().toISOString(),
  });
}

/**
 * Mark a stream purchase completed from a succeeded Stripe PaymentIntent (idempotent).
 */
async function completeStreamPurchaseFromPaymentIntent(stripe, paymentIntentOrId) {
  const cfg = appwriteConfig();
  if (!stripe) {
    throw new Error('Stripe not configured');
  }
  if (!isBackendConfigured(cfg)) {
    throw new Error('Stream access backend not configured');
  }

  const paymentIntent =
    typeof paymentIntentOrId === 'string'
      ? await stripe.paymentIntents.retrieve(paymentIntentOrId)
      : paymentIntentOrId;

  if (paymentIntent?.metadata?.type !== 'stream_access') {
    return { ignored: true, reason: 'not_stream_access' };
  }

  if (paymentIntent.status !== 'succeeded') {
    return { success: false, status: paymentIntent.status };
  }

  const piId = paymentIntent.id;
  const resolvedPurchaseId = String(paymentIntent.metadata?.purchaseId || '').trim();

  let purchase =
    (resolvedPurchaseId &&
      (await appwriteGetDocument(cfg, cfg.streamPurchasesCollectionId, resolvedPurchaseId))) ||
    (await findPurchaseByPaymentIntent(cfg, piId));

  if (!purchase) {
    return { success: false, reason: 'purchase_not_found', paymentIntentId: piId };
  }

  const finalized = await finalizeStreamPurchaseRecord(cfg, purchase, piId);
  return {
    success: true,
    purchaseId: finalized.$id,
    streamId: finalized.streamId,
    buyerId: finalized.buyerId,
    alreadyCompleted: purchase.status === 'completed',
  };
}

async function markStreamPurchaseFailedByPaymentIntent(paymentIntentId) {
  const cfg = appwriteConfig();
  if (!isBackendConfigured(cfg)) return null;
  const piId = String(paymentIntentId || '').trim();
  if (!piId) return null;

  const purchase = await findPurchaseByPaymentIntent(cfg, piId);
  if (!purchase || purchase.status === 'completed') return purchase;

  return appwriteUpdateDocument(cfg, cfg.streamPurchasesCollectionId, purchase.$id, {
    status: 'failed',
    paymentIntentId: piId,
  });
}

function getRequestRawBody(req) {
  if (Buffer.isBuffer(req?.body)) return req.body;
  if (typeof req?.body === 'string') return req.body;
  if (typeof req?.bodyText === 'string') return req.bodyText;
  return '';
}

/**
 * Stripe webhook handler for stream_access PaymentIntents.
 * @returns {Promise<{ status: number, body: object|string }>}
 */
async function handleStripeStreamAccessWebhook(stripe, { rawBody, signature }) {
  const webhookSecret = readEnv('STRIPE_WEBHOOK_SECRET');
  if (!webhookSecret) {
    return { status: 400, body: 'Webhook secret not configured' };
  }
  if (!stripe) {
    return { status: 503, body: 'Stripe not configured' };
  }

  const payload = rawBody;
  if (!payload || (typeof payload === 'string' && !payload.trim())) {
    return { status: 400, body: 'Empty webhook body' };
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(payload, signature, webhookSecret);
  } catch (err) {
    return { status: 400, body: `Webhook Error: ${err.message}` };
  }

  switch (event.type) {
    case 'payment_intent.succeeded': {
      const paymentIntent = event.data.object;
      if (paymentIntent?.metadata?.type !== 'stream_access') {
        return { status: 200, body: { received: true, ignored: true } };
      }
      const result = await completeStreamPurchaseFromPaymentIntent(stripe, paymentIntent);
      return { status: 200, body: { received: true, ...result } };
    }
    case 'payment_intent.payment_failed': {
      const paymentIntent = event.data.object;
      if (paymentIntent?.metadata?.type !== 'stream_access') {
        return { status: 200, body: { received: true, ignored: true } };
      }
      await markStreamPurchaseFailedByPaymentIntent(paymentIntent.id);
      return { status: 200, body: { received: true, status: 'failed' } };
    }
    default:
      return { status: 200, body: { received: true } };
  }
}

function parseRequestPath(req) {
  const raw =
    (typeof req.path === 'string' && req.path) ||
    (typeof req.url === 'string' ? req.url.split('?')[0] : '') ||
    '';
  try {
    if (raw.startsWith('http')) return new URL(raw).pathname;
  } catch (_) {
    /* ignore */
  }
  return raw || '/';
}

function parseQuery(req) {
  const raw =
    (typeof req.url === 'string' && req.url.includes('?') ? req.url.split('?')[1] : '') ||
    '';
  const fromParams =
    req.query && typeof req.query === 'object' && !Array.isArray(req.query) ? req.query : null;
  if (fromParams) {
    return {
      streamId: String(fromParams.streamId || '').trim(),
      userId: String(fromParams.userId || '').trim(),
    };
  }
  const params = new URLSearchParams(raw);
  return {
    streamId: String(params.get('streamId') || '').trim(),
    userId: String(params.get('userId') || '').trim(),
  };
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

function healthBody() {
  const cfg = appwriteConfig();
  const appwriteOk = isBackendConfigured(cfg);
  const stripeOk = Boolean(readEnv('STRIPE_SECRET_KEY'));
  return {
    status: 'ok',
    service: 'stream-access',
    stripe: stripeOk,
    appwrite: appwriteOk,
    stripeConfigured: stripeOk,
    appwriteConfigured: appwriteOk,
  };
}

/** Express route registration */
function registerStreamAccessRoutes(app, stripe) {
  app.get('/api/check-stream-access', async (req, res) => {
    try {
      const { streamId, userId } = req.query || {};
      const result = await checkStreamAccess(streamId, userId);
      return res.status(200).json(result);
    } catch (e) {
      return res.status(500).json({ allowed: false, reason: 'server_error', message: e.message });
    }
  });

  app.post('/api/create-stream-access-payment-intent', async (req, res) => {
    try {
      const { streamId, buyerId } = req.body || {};
      const result = await createStreamAccessPaymentIntent(stripe, { streamId, buyerId });
      return res.status(result.status).json(result.body);
    } catch (e) {
      return res.status(500).json({ error: e.message || 'Failed to create payment intent' });
    }
  });

  app.post('/api/confirm-stream-access-payment', async (req, res) => {
    try {
      const { paymentIntentId, purchaseId } = req.body || {};
      const result = await confirmStreamAccessPayment(stripe, { paymentIntentId, purchaseId });
      return res.status(result.status).json(result.body);
    } catch (e) {
      return res.status(500).json({ error: e.message || 'Failed to confirm payment' });
    }
  });
}

/** Appwrite Function HTTP handler */
async function handleAppwriteRequest({ req, res, log }) {
  const method = String(req.method || 'GET').toUpperCase();
  const path = parseRequestPath(req);

  if (method === 'OPTIONS') {
    return res.send('', 204, cors);
  }

  const stripeKey = readEnv('STRIPE_SECRET_KEY');
  const stripe = stripeKey ? require('stripe')(stripeKey) : null;

  try {
    if (method === 'GET' && (path === '/api/health' || path.endsWith('/api/health'))) {
      return res.json(healthBody(), 200, cors);
    }

    if (
      method === 'GET' &&
      (path === '/api/check-stream-access' || path.endsWith('/api/check-stream-access'))
    ) {
      const { streamId, userId } = parseQuery(req);
      const result = await checkStreamAccess(streamId, userId);
      return res.json(result, 200, cors);
    }

    if (
      method === 'POST' &&
      (path === '/api/create-stream-access-payment-intent' ||
        path.endsWith('/api/create-stream-access-payment-intent'))
    ) {
      const body = getBodyJson(req);
      const result = await createStreamAccessPaymentIntent(stripe, {
        streamId: body.streamId,
        buyerId: body.buyerId,
      });
      return res.json(result.body, result.status, cors);
    }

    if (
      method === 'POST' &&
      (path === '/api/confirm-stream-access-payment' ||
        path.endsWith('/api/confirm-stream-access-payment'))
    ) {
      const body = getBodyJson(req);
      const result = await confirmStreamAccessPayment(stripe, {
        paymentIntentId: body.paymentIntentId,
        purchaseId: body.purchaseId,
      });
      return res.json(result.body, result.status, cors);
    }

    if (
      method === 'POST' &&
      (path === '/api/stripe-webhook' || path.endsWith('/api/stripe-webhook'))
    ) {
      const outcome = await handleStripeStreamAccessWebhook(stripe, {
        rawBody: getRequestRawBody(req),
        signature: req.headers?.['stripe-signature'] || req.headers?.['Stripe-Signature'] || '',
      });
      if (typeof outcome.body === 'string') {
        return res.send(outcome.body, outcome.status, cors);
      }
      return res.json(outcome.body, outcome.status, cors);
    }

    if (method === 'GET' && (path === '/' || path === '')) {
      return res.json(
        {
          service: 'stream-access',
          routes: [
            '/api/health',
            '/api/check-stream-access',
            '/api/create-stream-access-payment-intent',
            '/api/confirm-stream-access-payment',
            '/api/stripe-webhook',
          ],
        },
        200,
        cors
      );
    }

    return res.json({ error: 'Not found', path }, 404, cors);
  } catch (e) {
    log?.(`stream-access error: ${e.message}`);
    return res.json({ error: e.message || 'Internal error' }, 500, cors);
  }
}

module.exports = {
  PLATFORM_FEE_RATE,
  checkStreamAccess,
  createStreamAccessPaymentIntent,
  confirmStreamAccessPayment,
  completeStreamPurchaseFromPaymentIntent,
  handleStripeStreamAccessWebhook,
  registerStreamAccessRoutes,
  handleAppwriteRequest,
  isPaidStream,
};
