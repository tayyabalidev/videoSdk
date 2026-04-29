"use strict";

const jwt = require("jsonwebtoken");

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept",
};

module.exports = async ({ req, res, log }) => {
  try {
    if (req.method === "OPTIONS") {
      return res.send("", 204, CORS_HEADERS);
    }

    if (req.method !== "POST") {
      return res.json({ error: "Method not allowed" }, 405, CORS_HEADERS);
    }

    const apiKey = process.env.VIDEOSDK_API_KEY;
    const secret = process.env.VIDEOSDK_SECRET_KEY;

    const { roomId, participantId } = JSON.parse(req.body || "{}");

    if (!roomId || !participantId) {
      return res.json(
        { error: "roomId and participantId required" },
        400,
        CORS_HEADERS
      );
    }

    if (!apiKey || !secret) {
      return res.json(
        { error: "Missing API credentials" },
        503,
        CORS_HEADERS
      );
    }

    // 🔥 GENERATE JWT
    const token = jwt.sign(
      {
        apikey: apiKey,
        permissions: ["allow_join", "allow_mod"],
        roomId: roomId,
        participantId: participantId,
      },
      secret,
      {
        expiresIn: "1h",
        algorithm: "HS256",
      }
    );

    log("Token generated for room:", roomId);

    return res.json({ token }, 200, CORS_HEADERS);
  } catch (e) {
    log("Token error:", e?.message || e);

    return res.json(
      { error: "Token generation failed", message: e?.message },
      500,
      CORS_HEADERS
    );
  }
};