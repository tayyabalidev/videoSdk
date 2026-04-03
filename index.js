import jwt from "jsonwebtoken";

export default async ({ req, res }) => {
  const meetingId = req.query.meetingId;
  const participantId = req.query.participantId;

  const API_KEY = process.env.VIDEOSDK_API_KEY;
  const SECRET = process.env.VIDEOSDK_SECRET_KEY;

  const payload = {
    apikey: API_KEY,
    permissions: ["allow_join"],
    version: 2,
    roles: ["rtc"],
    roomId: meetingId,
    participantId: participantId,
  };

  const token = jwt.sign(payload, SECRET, {
    algorithm: "HS256",
    expiresIn: "1h",
  });

  return res.json({ token });
};