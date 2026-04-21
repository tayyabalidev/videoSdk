/**
 * Appwrite Function — VideoSDK JWT for calls + live streaming
 *
 * GET /?meetingId=<room>&participantId=<optional>
 * Response: { token: "..." }
 *
 * Required env vars in Appwrite Function:
 * - VIDEOSDK_API_KEY
 * - VIDEOSDK_SECRET_KEY
 */

import jwt from "jsonwebtoken";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept",
};

function getQueryParam(req, name) {
  if (req.query && req.query[name] != null && req.query[name] !== "") {
    return String(req.query[name]);
  }

  const raw =
    (typeof req.queryString === "string" && req.queryString) ||
    (typeof req.url === "string" && req.url.includes("?") ? req.url.split("?")[1] : "") ||
    "";

  if (!raw) return "";
  const params = new URLSearchParams(raw);
  const v = params.get(name);
  return v != null ? String(v) : "";
}

export default async ({ req, res, log }) => {
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

    const meetingId = getQueryParam(req, "meetingId");
    const participantId = getQueryParam(req, "participantId");

    const payload = {
      apikey: API_KEY,
      permissions: ["allow_join", "allow_mod", "ask_join"], // important for host/live controls
      version: 2,
      roles: ["rtc"],
    };

    if (meetingId) payload.roomId = meetingId;
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
    log(String(e?.message || e));
    return res.json(
      {
        error: "Token generation failed",
        message: e?.message || "unknown",
      },
      500,
      CORS_HEADERS
    );
  }
};