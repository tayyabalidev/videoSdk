import jwt from "jsonwebtoken";

function getQueryParam(req, name) {
  if (req.query && req.query[name] != null && req.query[name] !== "") {
    return String(req.query[name]);
  }
  const qs = typeof req.queryString === "string" ? req.queryString : "";
  if (!qs) return "";
  const params = new URLSearchParams(qs);
  const v = params.get(name);
  return v != null ? String(v) : "";
}

export default async ({ req, res, log }) => {
  if (req.method === "OPTIONS") {
    return res.send("", 204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
    });
  }

  if (req.method !== "GET") {
    return res.json({ error: "Method not allowed" }, 405);
  }

  const API_KEY = String(process.env.VIDEOSDK_API_KEY || "").trim();
  const SECRET = String(process.env.VIDEOSDK_SECRET_KEY || "").trim();

  if (!API_KEY || !SECRET) {
    log("Missing VIDEOSDK_API_KEY or VIDEOSDK_SECRET_KEY");
    return res.json({ error: "VideoSDK not configured" }, 503);
  }

  const meetingId = getQueryParam(req, "meetingId");
  const participantId = getQueryParam(req, "participantId");

  const payload = {
    apikey: API_KEY,
    permissions: ["allow_join"],
    version: 2,
    roles: ["rtc"],
  };
  if (meetingId) payload.roomId = meetingId;
  if (participantId) payload.participantId = participantId;

  try {
    const token = jwt.sign(payload, SECRET, {
      algorithm: "HS256",
      expiresIn: "1h",
    });
    return res.json({ token }, 200, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    });
  } catch (e) {
    log(String(e?.message || e));
    return res.json({ error: "Token generation failed", message: e.message }, 500);
  }
};