const crypto = require("crypto");
const sdk = require("node-appwrite");

function parseMuxSignature(sigHeader) {
  // format: t=...,v1=...
  const out = { t: null, v1: null };
  if (!sigHeader || typeof sigHeader !== "string") return out;
  for (const part of sigHeader.split(",")) {
    const [k, v] = part.split("=");
    if (!k || !v) continue;
    const key = k.trim();
    const val = v.trim();
    if (key === "t") out.t = val;
    if (key === "v1") out.v1 = val;
  }
  return out;
}

function verifyMuxSignature(rawBodyText, sigHeader, secret) {
  const { t, v1 } = parseMuxSignature(sigHeader);
  if (!t || !v1 || !secret) return false;

  const payload = `${t}.${rawBodyText}`;
  const digest = crypto.createHmac("sha256", secret).update(payload).digest("hex");

  try {
    return crypto.timingSafeEqual(Buffer.from(digest, "hex"), Buffer.from(v1, "hex"));
  } catch {
    return false;
  }
}

function getBodyText(req) {
  if (typeof req.bodyText === "string") return req.bodyText;
  if (typeof req.bodyRaw === "string") return req.bodyRaw;
  if (typeof req.body === "string") return req.body;
  if (req.body && typeof req.body === "object") return JSON.stringify(req.body);
  return "";
}

function getBodyJson(req) {
  if (req.bodyJson && typeof req.bodyJson === "object") return req.bodyJson;
  const txt = getBodyText(req);
  if (!txt) return {};
  try {
    return JSON.parse(txt);
  } catch {
    return {};
  }
}

module.exports = async ({ req, res, log }) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, mux-signature, Mux-Signature",
  };

  try {
    const method = String(req.method || "POST").toUpperCase();

    if (method === "OPTIONS") {
      return res.send("", 204, cors);
    }
    if (method !== "POST") {
      return res.json({ error: "Method not allowed" }, 405, cors);
    }

    const headers = req.headers || {};
    const sigHeader =
      headers["mux-signature"] ||
      headers["Mux-Signature"] ||
      headers["MUX-SIGNATURE"] ||
      "";

    const rawBody = getBodyText(req);
    const secret = String(process.env.MUX_WEBHOOK_SECRET || "").trim();

    if (!secret) {
      return res.json({ error: "Missing MUX_WEBHOOK_SECRET" }, 500, cors);
    }

    if (!verifyMuxSignature(rawBody, sigHeader, secret)) {
      return res.json({ error: "Invalid signature" }, 401, cors);
    }

    const event = getBodyJson(req);
    const type = event?.type;
    const data = event?.data || {};

    // documentId from passthrough (recommended)
    // direct-upload function should send passthrough JSON with documentId
    let documentId = null;
    if (typeof data.passthrough === "string" && data.passthrough) {
      try {
        const p = JSON.parse(data.passthrough);
        documentId = p.documentId || p.appwriteDocId || null;
      } catch {
        documentId = null;
      }
    }

    // fallback if you still use metadata
    if (!documentId && data?.metadata?.appwriteDocId) {
      documentId = data.metadata.appwriteDocId;
    }

    if (!documentId) {
      // don't fail webhook retries forever, just acknowledge
      return res.json({ ok: true, ignored: "missing documentId mapping" }, 200, cors);
    }

    const client = new sdk.Client()
      .setEndpoint(process.env.APPWRITE_ENDPOINT)
      .setProject(process.env.APPWRITE_PROJECT_ID)
      .setKey(process.env.APPWRITE_API_KEY);

    const databases = new sdk.Databases(client);

    const dbId = process.env.APPWRITE_DB_ID || process.env.APPWRITE_DATABASE_ID;
    const colId = process.env.APPWRITE_COLLECTION_ID || process.env.APPWRITE_VIDEO_COLLECTION_ID;

    if (!dbId || !colId) {
      return res.json({ error: "Missing APPWRITE_DB/COLLECTION env vars" }, 500, cors);
    }

    if (type === "video.asset.ready") {
      const playbackId = data?.playback_ids?.[0]?.id || null;
      const assetId = data?.id || null;

      const patch = {
        mux_status: "ready",
        mux_asset_id: assetId,
      };

      if (playbackId) {
        patch.mux_playback_id = playbackId;
        patch.video = `https://stream.mux.com/${playbackId}.m3u8`;
        patch.thumbnail = `https://image.mux.com/${playbackId}/thumbnail.jpg?time=1&width=720`;
      }

      await databases.updateDocument(dbId, colId, documentId, patch);
      return res.json({ ok: true, updated: "ready" }, 200, cors);
    }

    if (type === "video.asset.errored") {
      await databases.updateDocument(dbId, colId, documentId, {
        mux_status: "error",
      });
      return res.json({ ok: true, updated: "error" }, 200, cors);
    }

    if (type === "video.upload.asset_created") {
      await databases.updateDocument(dbId, colId, documentId, {
        mux_status: "processing",
        mux_asset_id: data?.id || null,
      });
      return res.json({ ok: true, updated: "processing" }, 200, cors);
    }

    // acknowledge unhandled events
    return res.json({ ok: true, ignored: type || "unknown" }, 200, cors);
  } catch (err) {
    try {
      log(String(err?.stack || err?.message || err));
    } catch (_) {}
    return res.json({ error: err?.message || "webhook failed" }, 500, cors);
  }
};