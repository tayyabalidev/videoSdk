/**
 * Appwrite Function — VideoSDK Room Creation (FIXED)
 *
 * POST /
 * Response: { roomId: "<videosdk-room-id>" }
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

    // Handle preflight
    if (method === "OPTIONS") {
      return res.send("", 204, CORS_HEADERS);
    }

    // Only POST allowed
    if (method !== "POST") {
      return res.json({ error: "Method not allowed" }, 405, CORS_HEADERS);
    }

    // ✅ ONLY API KEY (NO AUTH TOKEN HERE)
    const apiKey = String(process.env.VIDEOSDK_API_KEY || "").trim();

    if (!apiKey) {
      log("Missing VIDEOSDK_API_KEY");
      return res.json(
        {
          error: "VideoSDK not configured",
          message: "Missing VIDEOSDK_API_KEY in Appwrite environment variables",
        },
        503,
        CORS_HEADERS
      );
    }

    log("Creating VideoSDK room...");

    const response = await fetch(VIDEOSDK_ROOMS_URL, {
      method: "POST",
      headers: {
        Authorization: apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({}),
    });

    let data;
    try {
      data = await response.json();
    } catch (e) {
      data = null;
    }

    // ❌ API failure
    if (!response.ok) {
      log("VideoSDK room creation failed", {
        status: response.status,
        data,
      });

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

    // Extract roomId safely
    const roomId = data?.roomId || data?.room_id || data?.id;

    if (!roomId) {
      return res.json(
        {
          error: "Room creation failed - missing roomId",
          details: data || null,
        },
        502,
        CORS_HEADERS
      );
    }

    log("Room created successfully:", roomId);

    return res.json(
      { roomId },
      200,
      {
        ...CORS_HEADERS,
        "Content-Type": "application/json",
      }
    );
  } catch (e) {
    log("Room creation exception:", String(e?.message || e));

    return res.json(
      {
        error: "Room creation failed",
        message: e?.message || "unknown error",
      },
      500,
      CORS_HEADERS
    );
  }
};