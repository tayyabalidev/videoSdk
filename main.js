const sdk = require("node-appwrite");

module.exports = async ({ req, res, log }) => {
const cors = {
"Access-Control-Allow-Origin": "*",
"Access-Control-Allow-Methods": "POST, OPTIONS",
"Access-Control-Allow-Headers":
"Content-Type, x-appwrite-user-jwt, x-appwrite-jwt, x-appwrite-key, X-Appwrite-Project",
};

try {
const method = (req.method || "POST").toUpperCase();

// Handle prefligh
// Handle preflight
if (method === "OPTIONS") return res.send("", 204, cors);
if (method !== "POST") {
  return res.json({ error: "Method not allowed" }, 405, cors);
}

// Parse request body safely
let body = {};
try {
  if (req.bodyJson) body = req.bodyJson;
  else if (req.bodyText) body = JSON.parse(req.bodyText);
} catch (e) {
  return res.json({ error: "Invalid JSON body" }, 400, cors);
}

const documentId =
  body.documentId || body.document_id || body.appwriteDocId;

if (!documentId) {
  return res.json({ error: "documentId required" }, 400, cors);
}

// Validate Mux credentials
const muxId = process.env.MUX_TOKEN_ID?.trim();
const muxSecret = process.env.MUX_TOKEN_SECRET?.trim();

if (!muxId || !muxSecret) {
  return res.json(
    { error: "Missing MUX credentials" },
    503,
    cors
  );
}

const auth = `Basic ${Buffer.from(`${muxId}:${muxSecret}`).toString("base64")}`;

// Create Mux upload
const muxRes = await fetch("https://api.mux.com/video/v1/uploads", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: auth,
  },
  body: JSON.stringify({
    cors_origin: "*",
    new_asset_settings: {
      playback_policy: ["public"],
      // Optional: enable MP4 support
      mp4_support: "standard",
      passthrough: JSON.stringify({ documentId }),
    },
    passthrough: JSON.stringify({ documentId }),
  }),
});

const muxJson = await muxRes.json();

if (!muxRes.ok || !muxJson?.data?.url) {
  log(`Mux error: ${JSON.stringify(muxJson)}`);
  return res.json(
    {
      error: "Failed to create upload URL",
      details: muxJson,
    },
    502,
    cors
  );
}

const { url: uploadUrl, id: uploadId } = muxJson.data;

// Update Appwrite document (safe + optional)
try {
  const endpoint =
    process.env.APPWRITE_ENDPOINT?.replace(/\/$/, "") || "";
  const projectId = process.env.APPWRITE_PROJECT_ID?.trim();
  const apiKey = process.env.APPWRITE_API_KEY?.trim();
  const dbId = process.env.APPWRITE_DATABASE_ID?.trim();
  const colId = process.env.APPWRITE_VIDEO_COLLECTION_ID?.trim();

  if (endpoint && projectId && apiKey && dbId && colId) {
    const client = new sdk.Client()
      .setEndpoint(endpoint)
      .setProject(projectId)
      .setKey(apiKey);

    const databases = new sdk.Databases(client);

    await databases.updateDocument(dbId, colId, documentId, {
      mux_status: "waiting_upload",
      mux_upload_id: uploadId,
    });
  }
} catch (err) {
  log(`Appwrite update failed: ${err.message}`);
}

return res.json(
  {
    success: true,
    uploadUrl,
    uploadId,
  },
  200,
  cors
);


} catch (err) {
log(`Fatal error: ${err.message}`);
return res.json(
{ error: "Internal server error" },
500,
cors
);
}
};
