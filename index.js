"use strict";

const jwt = require("jsonwebtoken");

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept",
};

function parseQuery(req) {
  if (req.query && typeof req.query === "object" && !Array.isArray(req.query)) {
    const roomId = req.query.roomId ?? req.query["roomId"];
    const participantId = req.query.participantId ?? req.query["participantId"];
    if (roomId != null || participantId != null) {
      return {
        roomId: roomId != null ? String(roomId).trim() : "",
        participantId: participantId != null ? String(participantId).trim() : "",
      };
    }
  }

  const raw =
    (typeof req.queryString === "string" && req.queryString) ||
    (typeof req.url === "string" && req.url.includes("?") ? req.url.split("?")[1] : "") ||
    "";

  const params = new URLSearchParams(raw);
  return {
    roomId: String(params.get("roomId") || "").trim(),
    participantId: String(params.get("participantId") || "").trim(),
  };
}

module.exports = async ({ req, res, log }) => {
  try {
    const method = String(req.method || "").toUpperCase();

    if (method === "OPTIONS") {
      return res.send("", 204, CORS_HEADERS);
    }

    if (method !== "GET") {
      return res.json({ error: "Method not allowed" }, 405, CORS_HEADERS);
    }

    const apiKey = String(process.env.VIDEOSDK_API_KEY || "").trim();
    const secret = String(process.env.VIDEOSDK_SECRET_KEY || "").trim();

    const { roomId, participantId } = parseQuery(req);

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

    const token = jwt.sign(
      {
        apikey: apiKey,
        permissions: ["allow_join", "allow_mod"],
        roomId,
        participantId,
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