const crypto = require("crypto");
const sdk = require("node-appwrite");

function getHeader(headers, key) {
  if (!headers) return "";
  const lower = key.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (String(k).toLowerCase() === lower) return String(v || "");
  }
  return "";
}

function parseMuxSignature(sigHeader) {
  const out = { t: "", v1: "" };
  if (!sigHeader) return out;
  for (const part of String(sigHeader).split(",")) {
    const [k, v] = part.split("=");
    if (!k || !v) continue;
    if (k.trim() === "t") out.t = v.trim();
    if (k.trim() === "v1") out.v1 = v.trim();
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
    if (method === "OPTIONS") return res.send("", 204, cors);
    if (method !== "POST") return res.json({ error: "Method not allowed" }, 405, cors);

    const secret = String(process.env.MUX_WEBHOOK_SECRET || "").trim();
    if (!secret) return res.json({ error: "Missing MUX_WEBHOOK_SECRET" }, 500, cors);

    const sigHeader =
      getHeader(req.headers, "mux-signature") ||
      getHeader(req.headers, "Mux-Signature");

    const rawBody = getBodyText(req);
    if (!verifyMuxSignature(rawBody, sigHeader, secret)) {
      return res.json({ error: "Invalid signature" }, 401, cors);
    }

    const event = getBodyJson(req);
    const type = event?.type;
    const data = event?.data || {};

    let documentId = null;
    if (typeof data.passthrough === "string" && data.passthrough) {
      try {
        const p = JSON.parse(data.passthrough);
        documentId = p.documentId || p.appwriteDocId || null;
      } catch {}
    }
    if (!documentId && data?.metadata?.appwriteDocId) {
      documentId = data.metadata.appwriteDocId;
    }
    if (!documentId) {
      return res.json({ ok: true, ignored: "no documentId in passthrough" }, 200, cors);
    }

    const endpoint = String(process.env.APPWRITE_ENDPOINT || "").replace(/\/$/, "");
    const projectId = String(process.env.APPWRITE_PROJECT_ID || "").trim();
    const apiKey = String(process.env.APPWRITE_API_KEY || "").trim();
    const dbId = String(process.env.APPWRITE_DB_ID || process.env.APPWRITE_DATABASE_ID || "").trim();
    const colId = String(process.env.APPWRITE_COLLECTION_ID || process.env.APPWRITE_VIDEO_COLLECTION_ID || "").trim();

    if (!endpoint || !projectId || !apiKey || !dbId || !colId) {
      return res.json({ error: "Missing Appwrite env vars" }, 500, cors);
    }

    // Debug to confirm updated key is actually loaded at runtime.
    log("apiKey prefix: " + String(process.env.APPWRITE_API_KEY || "").slice(0, 6));

    const client = new sdk.Client().setEndpoint(endpoint).setProject(projectId).setKey(apiKey);
    const databases = new sdk.Databases(client);

    if (type === "video.upload.asset_created") {
      await databases.updateDocument(dbId, colId, documentId, {
        status: "processing",
        mux_status: "processing",
        assetId: data?.id || null,
        mux_asset_id: data?.id || null,
      });
      return res.json({ ok: true, updated: "processing" }, 200, cors);
    }

    if (type === "video.asset.ready") {
      const playbackId = data?.playback_ids?.[0]?.id || null;
      const assetId = data?.id || null;

      const patch = {
        status: "ready",
        mux_status: "ready",
        playbackId,
        mux_playback_id: playbackId,
        assetId,
        mux_asset_id: assetId,
      };

      if (playbackId) {
        patch.video = `https://stream.mux.com/${playbackId}.m3u8`;
        patch.thumbnail = `https://image.mux.com/${playbackId}/thumbnail.jpg?time=1&width=720`;
      }

      await databases.updateDocument(dbId, colId, documentId, patch);
      return res.json({ ok: true, updated: "ready" }, 200, cors);
    }

    if (type === "video.asset.errored") {
      await databases.updateDocument(dbId, colId, documentId, {
        status: "error",
        mux_status: "error",
      });
      return res.json({ ok: true, updated: "error" }, 200, cors);
    }

    return res.json({ ok: true, ignored: type || "unknown" }, 200, cors);
  } catch (err) {
    try {
      log(String(err?.stack || err?.message || err));
    } catch {}
    return res.json({ error: err?.message || "webhook failed" }, 500, cors);
  }
};
