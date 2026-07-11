/**
 * Appwrite-only paid stream check for VideoSDK token minting (no Stripe).
 * Used by videosdk-token function and Node /get-token.
 */
'use strict';

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

function isPaidStream(stream) {
  if (!stream) return false;
  if (stream.isPaid === true || stream.isPaid === 'true' || stream.isPaid === 1) {
    const price = Number(stream.price);
    return Number.isFinite(price) && price > 0;
  }
  return false;
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
    throw new Error(`Appwrite getDocument failed (${res.status}): ${body.slice(0, 200)}`);
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
    throw new Error(`Appwrite listDocuments failed (${res.status}): ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.documents || [];
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

async function findStreamByRoomId(cfg, roomId) {
  const rid = String(roomId || '').trim();
  if (!rid) return null;
  const docs = await appwriteListDocuments(cfg, cfg.liveStreamsCollectionId, [
    `equal("videosdkRoomId", ["${rid}"])`,
    'limit(1)',
  ]);
  return docs[0] || null;
}

/**
 * Resolve stream doc by explicit streamId or VideoSDK roomId.
 */
async function resolveStreamDoc(cfg, { streamId, roomId }) {
  const sid = String(streamId || '').trim();
  if (sid) {
    return appwriteGetDocument(cfg, cfg.liveStreamsCollectionId, sid);
  }
  return findStreamByRoomId(cfg, roomId);
}

/**
 * Whether a live viewer may receive a VideoSDK meeting token.
 * @returns {Promise<{ allowed: boolean, reason?: string, streamId?: string }>}
 */
async function checkLiveViewerTokenAccess({ streamId, roomId, userId }) {
  const cfg = appwriteConfig();
  const uid = String(userId || '').trim();

  if (!uid) {
    return { allowed: false, reason: 'missing_user' };
  }

  if (!isBackendConfigured(cfg)) {
    return { allowed: false, reason: 'appwrite_not_configured' };
  }

  let stream;
  try {
    stream = await resolveStreamDoc(cfg, { streamId, roomId });
  } catch (e) {
    return { allowed: false, reason: 'server_error', message: e.message };
  }

  if (!stream) {
    // Unknown stream — allow token (free / legacy streams not in DB).
    return { allowed: true, reason: 'stream_not_found' };
  }

  const resolvedStreamId = stream.$id;

  if (!isPaidStream(stream)) {
    return { allowed: true, reason: 'free_stream', streamId: resolvedStreamId };
  }

  if (String(stream.hostId || '') === uid) {
    return { allowed: true, reason: 'host', streamId: resolvedStreamId };
  }

  try {
    const purchase = await findCompletedPurchase(cfg, resolvedStreamId, uid);
    if (purchase) {
      return { allowed: true, reason: 'purchased', streamId: resolvedStreamId };
    }
  } catch (e) {
    return { allowed: false, reason: 'server_error', message: e.message };
  }

  return { allowed: false, reason: 'payment_required', streamId: resolvedStreamId };
}

module.exports = {
  checkLiveViewerTokenAccess,
  findStreamByRoomId,
  isPaidStream,
};
