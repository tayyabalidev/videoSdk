/**
 * Appwrite Function — VideoSDK Room Creation
 *
 * Contract:
 *   POST /
 *   Response: { "roomId": "<videosdk-room-id>" }
 *
 * Required env vars in Appwrite Function:
 * - VIDEOSDK_AUTH_TOKEN (preferred)
 *   OR
 * - VIDEOSDK_API_KEY
 */

"use strict";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept",
};

const VIDEOSDK_ROOMS_URL = "https://api.videosdk.live/v2/rooms";

module.exports = async ({ req, res, log }) => {
  try {
    const method = String(req.method || "POST").toUpperCase();

    if (method === "OPTIONS") {
      return res.send("", 204, CORS_HEADERS);
    }

    if (method !== "POST") {
      return res.json({ error: "Method not allowed" }, 405, CORS_HEADERS);
    }

    const authToken = String(process.env.VIDEOSDK_AUTH_TOKEN || "").trim();
    const apiKey = String(process.env.VIDEOSDK_API_KEY || "").trim();
    const authHeader = authToken || apiKey;

    if (!authHeader) {
      log("Missing VIDEOSDK_AUTH_TOKEN and VIDEOSDK_API_KEY");
      return res.json(
        {
          error: "VideoSDK not configured",
          message:
            "Set VIDEOSDK_AUTH_TOKEN (preferred) or VIDEOSDK_API_KEY in this Appwrite function environment.",
        },
        503,
        CORS_HEADERS
      );
    }

    // Use global fetch available in Node 18+ runtime
    const response = await fetch(VIDEOSDK_ROOMS_URL, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({}),
    });

    let data = null;
    try {
      data = await response.json();
    } catch (_) {
      data = null;
    }

    if (!response.ok) {
      return res.json(
        {
          error: "Failed to create VideoSDK room",
          status: response.status,
          details: data || null,
        },
        response.status || 500,
        CORS_HEADERS
      );
    }

    const roomId = data?.roomId || data?.room_id || data?.id || "";
    if (!roomId) {
      return res.json(
        {
          error: "Room creation response missing roomId",
          details: data || null,
        },
        502,
        CORS_HEADERS
      );
    }

    return res.json({ roomId }, 200, {
      ...CORS_HEADERS,
      "Content-Type": "application/json",
    });
  } catch (e) {
    try {
      log(String((e && e.message) || e));
    } catch (_) {}

    return res.json(
      {
        error: "Room creation failed",
        message: (e && e.message) || "unknown",
      },
      500,
      CORS_HEADERS
    );
  }
};