const sdk = require("node-appwrite");

module.exports = async ({ req, res, log }) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, x-appwrite-user-jwt, x-appwrite-jwt, x-appwrite-key, X-Appwrite-Project",
  };

  try {
    const method = String(req.method || "POST").toUpperCase();

    if (method === "OPTIONS") return res.send("", 204, cors);
    if (method !== "POST") {
      return res.json({ error: "Method not allowed" }, 405, cors);
    }

    // Appwrite body parsing
    let body = {};
    if (req.bodyJson && typeof req.bodyJson === "object") {
      body = req.bodyJson;
    } else if (typeof req.bodyText === "string" && req.bodyText.trim()) {
      try {
        body = JSON.parse(req.bodyText);
      } catch {
        body = {};
      }
    }

    const documentId = body.documentId || body.document_id || body.appwriteDocId;
    if (!documentId) {
      return res.json({ error: "documentId required" }, 400, cors);
    }

    const muxId = String(process.env.MUX_TOKEN_ID || "").trim();
    const muxSecret = String(process.env.MUX_TOKEN_SECRET || "").trim();
    if (!muxId || !muxSecret) {
      return res.json(
        { error: "Missing MUX_TOKEN_ID or MUX_TOKEN_SECRET" },
        503,
        cors
      );
    }

    const auth = `Basic ${Buffer.from(`${muxId}:${muxSecret}`).toString("base64")}`;

    const muxRes = await fetch("https://api.mux.com/video/v1/uploads", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: auth,
      },
      body: JSON.stringify({
        cors_origin: "*",
        passthrough: JSON.stringify({ documentId }),
        new_asset_settings: {
          playback_policy: ["public"],
          passthrough: JSON.stringify({ documentId }),
        },
      }),
    });

    const muxJson = await muxRes.json();

    if (!muxRes.ok || !muxJson?.data?.url) {
      return res.json(
        {
          error: "Failed to create Mux upload URL",
          muxStatus: muxRes.status,
          muxResponse: muxJson,
        },
        502,
        cors
      );
    }

    const uploadUrl = muxJson.data.url;
    const uploadId = muxJson.data.id;

    // Optional: patch Appwrite doc (best effort)
    try {
      const endpoint = String(
        process.env.APPWRITE_ENDPOINT || process.env.APPWRITE_FUNCTION_API_ENDPOINT || ""
      ).replace(/\/$/, "");
      const projectId = String(
        process.env.APPWRITE_PROJECT_ID || process.env.APPWRITE_FUNCTION_PROJECT_ID || ""
      ).trim();
      const apiKey = String(process.env.APPWRITE_API_KEY || "").trim();
      const dbId = String(process.env.APPWRITE_DATABASE_ID || process.env.APPWRITE_DB_ID || "").trim();
      const colId = String(
        process.env.APPWRITE_VIDEO_COLLECTION_ID || process.env.APPWRITE_COLLECTION_ID || ""
      ).trim();

      if (endpoint && projectId && apiKey && dbId && colId) {
        const client = new sdk.Client()
          .setEndpoint(endpoint)
          .setProject(projectId)
          .setKey(apiKey);

        const databases = new sdk.Databases(client);

        await databases.updateDocument(dbId, colId, documentId, {
          mux_status: "uploading",
          mux_upload_id: uploadId,
        });
      }
    } catch (e) {
      log(`Optional Appwrite patch skipped: ${e?.message || e}`);
    }

    return res.json({ uploadUrl, uploadId }, 200, cors);
  } catch (err) {
    log(`mux-direct-upload error: ${err?.message || err}`);
    return res.json({ error: err?.message || "unknown error" }, 500, cors);
  }
};