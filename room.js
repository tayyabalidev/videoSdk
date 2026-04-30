"use strict";

const jwt = require("jsonwebtoken");

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept",
};

const VIDEOSDK_ROOMS_URL = "https://api.videosdk.live/v2/rooms";

module.exports = async ({ req, res, log }) => {
  try {
    const method = String(req.method || "").toUpperCase();

    if (method === "OPTIONS") {
      return res.send("", 204, CORS_HEADERS);
    }

    if (method !== "POST") {
      return res.json({ error: "Method not allowed" }, 405, CORS_HEADERS);
    }

    // Must be VideoSDK auth JWT for room creation
    const authToken = String(process.env.VIDEOSDK_AUTH_TOKEN || "").trim();

    if (!authToken) {
      return res.json(
        { error: "Missing VIDEOSDK_AUTH_TOKEN (JWT required)" },
        503,
        CORS_HEADERS
      );
    }

    // Debug only (safe: no secret exposed)
    const decodedAuth = jwt.decode(authToken) || {};
    const authApiKey = decodedAuth?.apikey || null;
    log("Room function auth apikey:", authApiKey);

    const response = await fetch(VIDEOSDK_ROOMS_URL, {
      method: "POST",
      headers: {
        Authorization: authToken,
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
          debug: { authApiKey },
        },
        response.status,
        CORS_HEADERS
      );
    }

    const roomId = data?.roomId || data?.room_id || data?.id;

    if (!roomId) {
      return res.json(
        { error: "No roomId returned", details: data, debug: { authApiKey } },
        502,
        CORS_HEADERS
      );
    }

    log("Room created:", roomId);

    return res.json(
      {
        roomId,
        debug: { authApiKey },
      },
      200,
      CORS_HEADERS
    );
  } catch (e) {
    log("Room exception:", e?.message || e);

    return res.json(
      { error: "Room creation failed", message: e?.message },
      500,
      CORS_HEADERS
    );
  }
};