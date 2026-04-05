// index.js
const crypto = require("crypto");

module.exports = async function (req, res) {
  try {
    // 1. Mux signature verify
    const signature = req.headers['mux-signature'];
    const body = JSON.stringify(req.body);

    const expectedSignature = crypto
      .createHmac("sha256", process.env.MUX_WEBHOOK_SECRET)
      .update(body)
      .digest("hex");

    if (signature !== expectedSignature) {
      return res.status(400).send({ error: "Invalid signature" });
    }

    // 2. Event parse
    const event = req.body; // Mux sends JSON

    // 3. Check event type
    if (event.type === "video.asset.ready") {
      const playbackId = event.data.playback_ids[0].id;
      const assetId = event.data.id;

      // 4. Update Appwrite database document
      const sdk = require("node-appwrite"); // add as dependency
      const client = new sdk.Client();
      client
        .setEndpoint(process.env.APPWRITE_ENDPOINT)
        .setProject(process.env.APPWRITE_PROJECT_ID)
        .setKey(process.env.APPWRITE_API_KEY);

      const database = new sdk.Databases(client);
      await database.updateDocument(
        process.env.APPWRITE_DB_ID,      // database ID
        process.env.APPWRITE_COLLECTION_ID, // collection ID
        event.data.metadata.appwriteDocId, // store doc ID in metadata
        { status: "ready", playbackId, assetId }
      );
    }

    return res.status(200).send({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(500).send({ error: err.message });
  }
};