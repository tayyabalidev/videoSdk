const sdk = require("node-appwrite");

module.exports = async ({ req, res, log }) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, x-appwrite-user-jwt, x-appwrite-key",
  };

  try {
    const method = String(req.method || "POST").toUpperCase();

    if (method === "OPTIONS") {
      return res.send("", 204, cors);
    }
    if (method !== "POST") {
      return res.json({ error: "Method not allowed" }, 405, cors);
    }

    const body =
      (req.bodyJson && typeof req.bodyJson === "object" ? req.bodyJson : null) ||
      (() => {
        try {
          return JSON.parse(req.bodyText || "{}");
        } catch {
          return {};
        }
      })();

    const filename = body.filename;
    const appwriteDocId = body.appwriteDocId || body.documentId || body.document_id;

    if (!filename || !appwriteDocId) {
      return res.json({ error: "filename and appwriteDocId required" }, 400, cors);
    }

    const auth = Buffer.from(
      `${process.env.MUX_TOKEN_ID}:${process.env.MUX_TOKEN_SECRET}`
    ).toString("base64");

    const muxRes = await fetch("https://api.mux.com/video/v1/uploads", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify({
        cors_origin: "*",
        passthrough: JSON.stringify({ appwriteDocId, filename }),
        new_asset_settings: {
          playback_policy: ["public"],
          passthrough: JSON.stringify({ appwriteDocId, filename }),
        },
      }),
    });

    const data = await muxRes.json();

    if (!muxRes.ok || !data?.data?.url) {
      return res.json(
        { error: "Failed to create Mux upload URL", muxResponse: data },
        502,
        cors
      );
    }

    const client = new sdk.Client()
      .setEndpoint(process.env.APPWRITE_ENDPOINT || process.env.APPWRITE_FUNCTION_API_ENDPOINT)
      .setProject(process.env.APPWRITE_PROJECT_ID || process.env.APPWRITE_FUNCTION_PROJECT_ID)
      .setKey(process.env.APPWRITE_API_KEY || req.headers["x-appwrite-key"]);

    const database = new sdk.Databases(client);

    await database.updateDocument(
      process.env.APPWRITE_DB_ID || process.env.APPWRITE_DATABASE_ID,
      process.env.APPWRITE_COLLECTION_ID || process.env.APPWRITE_VIDEO_COLLECTION_ID,
      appwriteDocId,
      {
        mux_status: "uploading",
        mux_upload_id: data.data.id,
      }
    );

    return res.json(
      {
        uploadUrl: data.data.url,
        uploadId: data.data.id,
      },
      200,
      cors
    );
  } catch (err) {
    log(`MUX DIRECT UPLOAD ERROR: ${err?.message || err}`);
    return res.json({ error: err?.message || "unknown error" }, 500, cors);
  }
};