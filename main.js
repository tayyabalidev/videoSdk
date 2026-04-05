const sdk = require("node-appwrite");
const fetch = require("node-fetch");

module.exports = async function (req, res) {
  try {
    const { filename, appwriteDocId } = JSON.parse(req.payload);

    if (!filename || !appwriteDocId) {
      return res.status(400).send({ error: "filename and appwriteDocId required" });
    }

    const response = await fetch("https://api.mux.com/video/v1/uploads", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization:
          "Basic " +
          Buffer.from(
            process.env.MUX_TOKEN_ID + ":" + process.env.MUX_TOKEN_SECRET
          ).toString("base64"),
      },
      body: JSON.stringify({
        new_asset_settings: { playback_policy: ["public"] },
        cors_origin: ["*"],
        metadata: { appwriteDocId, filename },
      }),
    });

    const data = await response.json();

    if (!data.data || !data.data.url) {
      return res.status(500).send({ error: "Failed to create Mux upload URL", muxResponse: data });
    }

    const client = new sdk.Client()
      .setEndpoint(process.env.APPWRITE_ENDPOINT)
      .setProject(process.env.APPWRITE_PROJECT_ID)
      .setKey(process.env.APPWRITE_API_KEY);

    const database = new sdk.Databases(client);

    await database.updateDocument(
      process.env.APPWRITE_DB_ID,
      process.env.APPWRITE_COLLECTION_ID,
      appwriteDocId,
      {
        status: "uploading",
        muxUploadId: data.data.id,
        uploadUrl: data.data.url,
      }
    );

    return res.json({
      uploadUrl: data.data.url,
      uploadId: data.data.id,
    });
  } catch (err) {
    console.error("MUX DIRECT UPLOAD ERROR:", err);
    return res.status(500).send({ error: err.message });
  }
};