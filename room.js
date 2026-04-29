"use strict";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept",
};

const VIDEOSDK_ROOMS_URL = "https://api.videosdk.live/v2/rooms";

module.exports = async ({ req, res, log }) => {
  try {
    if (req.method === "OPTIONS") {
      return res.send("", 204, CORS_HEADERS);
    }

    if (req.method !== "POST") {
      return res.json({ error: "Method not allowed" }, 405, CORS_HEADERS);
    }

    // 🔥 MUST USE JWT (not API KEY)
    const authToken = String(process.env.VIDEOSDK_AUTH_TOKEN || "").trim();

    if (!authToken) {
      return res.json(
        { error: "Missing VIDEOSDK_AUTH_TOKEN (JWT required)" },
        503,
        CORS_HEADERS
      );
    }

    log("Creating VideoSDK room...");

    const response = await fetch(VIDEOSDK_ROOMS_URL, {
      method: "POST",
      headers: {
        Authorization: authToken, // ✅ JWT ONLY
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({}),
    });

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      log("Room creation failed", { status: response.status, data });

      return res.json(
        {
          error: "Failed to create VideoSDK room",
          status: response.status,
          details: data,
        },
        response.status,
        CORS_HEADERS
      );
    }

    const roomId = data?.roomId || data?.room_id || data?.id;

    if (!roomId) {
      return res.json(
        { error: "No roomId returned", details: data },
        502,
        CORS_HEADERS
      );
    }

    log("Room created:", roomId);

    return res.json({ roomId }, 200, CORS_HEADERS);
  } catch (e) {
    log("Exception:", e?.message || e);

    return res.json(
      { error: "Room creation failed", message: e?.message },
      500,
      CORS_HEADERS
    );
  }
};