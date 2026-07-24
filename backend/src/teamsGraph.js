// Microsoft Graph / Teams integration.
//
// When GRAPH_* and TEAMS_* are configured (see config.js / .env.example), the
// backend posts deployment notifications to a Teams channel and *threads* them
// per deployment: the first event for a deployment creates a root channel
// message, and every later event is posted as a reply to that same message.
// The deployment→root-message mapping lives in the `teams_threads` table.
//
// IMPORTANT CAVEAT (application permissions): Microsoft restricts sending
// channel messages with application (app-only) permissions. Full
// `POST /teams/{id}/channels/{id}/messages` in app-only mode is generally only
// available with the special "protected/migration" permissions or via RSC;
// otherwise it needs a delegated `ChannelMessage.Send`. Reading teams/channels
// works with application permissions (Team.ReadBasic.All / Channel.ReadBasic.All).
// This module therefore fails gracefully: if a send is rejected (401/403), it
// reports the error to the caller, which falls back to the existing webhooks.
import { config } from './config.js';
import { query } from './db.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const LOGIN = 'https://login.microsoftonline.com';

// Cached app-only access token (client-credentials flow).
let tokenCache = { value: '', expiresAt: 0 };

export function isConfigured() {
  const g = config.graph;
  return !!(g.tenantId && g.clientId && g.clientSecret);
}

// Is the integration fully wired to a concrete channel (so we can actually post)?
export function canPost() {
  return isConfigured() && !!(config.graph.teamId && config.graph.channelId);
}

// Fetch (and cache) an app-only token for Microsoft Graph.
async function getToken() {
  const now = Date.now();
  if (tokenCache.value && now < tokenCache.expiresAt - 60_000) return tokenCache.value;
  const g = config.graph;
  const body = new URLSearchParams({
    client_id: g.clientId,
    client_secret: g.clientSecret,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });
  const res = await fetch(`${LOGIN}/${g.tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json.error_description || json.error || `token HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  tokenCache = { value: json.access_token, expiresAt: now + (json.expires_in || 3600) * 1000 };
  return tokenCache.value;
}

// Thin Graph fetch wrapper that attaches the bearer token and parses JSON.
async function graphFetch(path, options = {}) {
  const token = await getToken();
  const res = await fetch(path.startsWith('http') ? path : `${GRAPH}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await res.text().catch(() => '');
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
  if (!res.ok) {
    const msg = (json && json.error && (json.error.message || json.error.code)) || text || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return json;
}

// --- Diagnostics: list teams and channels so an admin can discover ids. ---
export async function listTeams() {
  const json = await graphFetch(`/groups?$filter=${encodeURIComponent("resourceProvisioningOptions/Any(x:x eq 'Team')")}&$select=id,displayName`);
  return (json.value || []).map((t) => ({ id: t.id, displayName: t.displayName }));
}

export async function listChannels(teamId) {
  const json = await graphFetch(`/teams/${encodeURIComponent(teamId)}/channels?$select=id,displayName`);
  return (json.value || []).map((c) => ({ id: c.id, displayName: c.displayName }));
}

// Build a Graph channel-message body with an HTML content block.
function messageBody(subject, html) {
  const content = subject ? `<h3>${escapeHtml(subject)}</h3>${html}` : html;
  return { body: { contentType: 'html', content } };
}

// Post a new root message to the configured channel; returns the message id.
async function postChannelMessage(subject, html) {
  const { teamId, channelId } = config.graph;
  const json = await graphFetch(
    `/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages`,
    { method: 'POST', body: JSON.stringify(messageBody(subject, html)) }
  );
  return json.id;
}

// Post a reply under an existing root message.
async function postReply(messageId, subject, html) {
  const { teamId, channelId } = config.graph;
  await graphFetch(
    `/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/replies`,
    { method: 'POST', body: JSON.stringify(messageBody(subject, html)) }
  );
}

// Look up / store the root message id for a deployment.
async function getThreadId(deploymentId) {
  const { rows } = await query('SELECT message_id FROM teams_threads WHERE deployment_id = $1', [String(deploymentId)]);
  return rows[0] ? rows[0].message_id : null;
}
async function saveThreadId(deploymentId, messageId) {
  await query(
    `INSERT INTO teams_threads (deployment_id, message_id) VALUES ($1, $2)
     ON CONFLICT (deployment_id) DO UPDATE SET message_id = EXCLUDED.message_id`,
    [String(deploymentId), String(messageId)]
  );
}

// Convert the plain-text notification body into simple HTML (line breaks).
function textToHtml(text) {
  return escapeHtml(String(text == null ? '' : text)).replace(/\n/g, '<br>');
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Post an event for a deployment: creates the thread on the first event and
// replies to it afterwards. `deploymentId` may be falsy (e.g. a generic event),
// in which case a standalone channel message is posted. Never throws — returns
// a normalised result so the caller can fall back to webhooks on failure.
export async function postDeploymentEvent({ deploymentId, subject, text }) {
  if (!canPost()) return { ok: false, skipped: true, error: 'Graph/Teams not configured' };
  const html = textToHtml(text);
  try {
    if (!deploymentId) {
      const id = await postChannelMessage(subject, html);
      return { ok: true, messageId: id, threaded: false };
    }
    const existing = await getThreadId(deploymentId);
    if (existing) {
      await postReply(existing, subject, html);
      return { ok: true, messageId: existing, threaded: true };
    }
    const id = await postChannelMessage(subject, html);
    await saveThreadId(deploymentId, id);
    return { ok: true, messageId: id, threaded: false };
  } catch (err) {
    return { ok: false, status: err.status, error: err.message };
  }
}

// Overall status for the diagnostics endpoint.
export async function status() {
  const s = { configured: isConfigured(), canPost: canPost(), tokenOk: false };
  if (!isConfigured()) return s;
  try { await getToken(); s.tokenOk = true; } catch (err) { s.tokenError = err.message; }
  return s;
}
