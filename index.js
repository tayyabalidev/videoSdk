/**
 * Appwrite Function — VideoSDK JWT for calls + live streaming
 *
 * Contract:
 *   GET /?roomId=<room>&participantId=<optional>
 *   (backward compatible: also accepts meetingId)
 *   Response: { "token": "<jwt>" }
 *
 * Required env vars in Appwrite Function:
 * - VIDEOSDK_API_KEY
 * - VIDEOSDK_SECRET_KEY
 *
 * Notes:
 * - Uses CommonJS to match Appwrite Node function runtime defaults.
 * - Must return every res.* call.
 */
"use strict";

const jwt = require("jsonwebtoken");

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept",
};

function getQueryParam(req, name) {
  if (req.query && typeof req.query === "object" && !Array.isArray(req.query)) {
    const v = req.query[name];
    if (v != null && String(v).trim() !== "") {
      return String(v).trim();
    }
  }

  const raw =
    (typeof req.queryString === "string" && req.queryString) ||
    (typeof req.url === "string" && req.url.includes("?") ? req.url.split("?")[1] : "") ||
    "";

  if (!raw) return "";
  const params = new URLSearchParams(raw);
  const v = params.get(name);
  return v != null ? String(v).trim() : "";
}

module.exports = async ({ req, res, log }) => {
  try {
    const method = String(req.method || "GET").toUpperCase();

    if (method === "OPTIONS") {
      return res.send("", 204, CORS_HEADERS);
    }

    if (method !== "GET") {
      return res.json({ error: "Method not allowed" }, 405, CORS_HEADERS);
    }

    const API_KEY = String(process.env.VIDEOSDK_API_KEY || "").trim();
    const SECRET = String(process.env.VIDEOSDK_SECRET_KEY || "").trim();

    if (!API_KEY || !SECRET) {
      log("Missing VIDEOSDK_API_KEY or VIDEOSDK_SECRET_KEY");
      return res.json(
        {
          error: "VideoSDK not configured",
          message:
            "Set VIDEOSDK_API_KEY and VIDEOSDK_SECRET_KEY in this Appwrite function environment, then redeploy.",
        },
        503,
        CORS_HEADERS
      );
    }

    // Primary param: roomId (current app flow)
    // Backward compatibility: meetingId (older flow)
    const roomId = getQueryParam(req, "roomId") || getQueryParam(req, "meetingId");
    const participantId = getQueryParam(req, "participantId");

    if (!roomId) {
      return res.json(
        { error: "roomId is required" },
        400,
        CORS_HEADERS
      );
    }

    const payload = {
      apikey: API_KEY,
      permissions: ["allow_join", "allow_mod", "ask_join"],
      version: 2,
      roles: ["rtc"],
      roomId,
    };

    if (participantId) payload.participantId = participantId;

    const token = jwt.sign(payload, SECRET, {
      algorithm: "HS256",
      expiresIn: "2h",
    });

    return res.json({ token }, 200, {
      ...CORS_HEADERS,
      "Content-Type": "application/json",
    });
  } catch (e) {
    try {
      log(String((e && e.message) || e));
    } catch (_) {}
    return res.json(
      {
        error: "Token generation failed",
        message: (e && e.message) || "unknown",
      },
      500,
      CORS_HEADERS
    );
  }
};