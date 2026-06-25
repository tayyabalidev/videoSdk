/**
 * Appwrite Function — bridges password-recovery email to the mobile deep link.
 *
 * Appwrite `createRecovery` only accepts https:// URLs on registered Web platforms.
 * Custom schemes (com.bilal.asab://) are rejected with "Invalid URI".
 *
 * Flow:
 * 1. App calls createRecovery(email, "https://THIS_FUNCTION_URL")
 * 2. User taps email link → Appwrite redirects here with ?userId=&secret=
 * 3. This function returns HTML/302 → com.bilal.asab://reset-password?userId=&secret=
 *
 * Console setup:
 * - Deploy this function (runtime: Node 18+)
 * - Settings → Execute access: Any (public GET for email links)
 * - Variables (optional): APP_DEEP_LINK_SCHEME=com.bilal.asab, APP_DEEP_LINK_PATH=reset-password
 * - Integrations → Platforms → Add Web app → hostname from your function URL
 *   (e.g. abc123.appwrite.global — no https://, no path)
 * - EAS secret: EXPO_PUBLIC_PASSWORD_RECOVERY_REDIRECT_URL=https://abc123.appwrite.global
 */
'use strict';

const HTML_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
};

function parseQuery(req) {
  const fromParams = (params) => ({
    userId: params.get('userId') || params.get('userid') || '',
    secret: params.get('secret') || '',
  });

  if (req.query && typeof req.query === 'object' && !Array.isArray(req.query)) {
    return {
      userId: String(req.query.userId || req.query.userid || '').trim(),
      secret: String(req.query.secret || '').trim(),
    };
  }

  const raw =
    (typeof req.queryString === 'string' && req.queryString) ||
    (typeof req.url === 'string' && req.url.includes('?') ? req.url.split('?')[1] : '') ||
    '';
  return fromParams(new URLSearchParams(raw));
}

function buildDeepLink(userId, secret) {
  const scheme = (process.env.APP_DEEP_LINK_SCHEME || 'com.bilal.asab').trim();
  const path = (process.env.APP_DEEP_LINK_PATH || 'reset-password').replace(/^\//, '');
  const qs = `userId=${encodeURIComponent(userId)}&secret=${encodeURIComponent(secret)}`;
  return `${scheme}://${path}?${qs}`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = async function passwordRecoveryRedirect(context) {
  const { req, res } = context;

  if (req.method === 'OPTIONS') {
    return res.empty();
  }

  const { userId, secret } = parseQuery(req);

  if (!userId || !secret) {
    const body = `<!DOCTYPE html><html><body><h1>Invalid link</h1><p>This password reset link is missing required parameters. Request a new link from the app.</p></body></html>`;
    return res.send(body, 400, HTML_HEADERS);
  }

  const deepLink = buildDeepLink(userId, secret);
  const safeDeepLink = escapeHtml(deepLink);
  const safeJsDeepLink = JSON.stringify(deepLink);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <meta http-equiv="refresh" content="0;url=${safeDeepLink}"/>
  <title>Opening ASAB…</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #0a0a0a; color: #f5f5f5; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 24px; text-align: center; }
    a { color: #d97706; }
  </style>
</head>
<body>
  <div>
    <p>Opening the ASAB app…</p>
    <p><a href="${safeDeepLink}">Tap here</a> if you are not redirected automatically.</p>
  </div>
  <script>window.location.replace(${safeJsDeepLink});</script>
</body>
</html>`;

  return res.send(html, 200, HTML_HEADERS);
};
