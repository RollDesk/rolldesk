// The "open the app" link appended to outgoing notifications.
//
// Every delivery channel needs the same link in its own markup — plain text for
// e-mail, Slack's `<url|label>`, a MessageCard action for a Teams webhook, an
// anchor for Microsoft Graph — and the label has to read the same in all of
// them. Keeping the shapes here (pure, so they are unit-testable) is what
// stopped the Graph path from quietly being the one channel with no link at all.
//
// The URL comes from APP_BASE_URL, which is a single value per instance: it is
// also the SSO callback and the base of invitation links, so notifications
// cannot vary it per recipient. When it is unset every helper returns an empty
// string and the caller simply sends no link.
export const APP_LINK_LABEL = 'Open RollDesk';

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// A plain-text notification body as an HTML paragraph. The body carries text a
// person typed (a failure reason, a target name), so it must be escaped rather
// than interpolated — an `<` in a reason used to swallow the rest of the line in
// an HTML mail client. Newlines become <br> so the layout survives.
export function bodyToHtml(text) {
  return `<p>${escapeHtml(String(text == null ? '' : text)).replace(/\n/g, '<br>')}</p>`;
}

// Only http(s) is a usable link in an e-mail client or a Teams card, and an
// unvalidated value from the environment would otherwise let a typo through as
// a `javascript:` href. Anything else is treated as not configured.
export function isUsableAppUrl(appUrl) {
  const url = String(appUrl || '').trim();
  return /^https?:\/\//i.test(url);
}

// Trailing text for a plain-text body (e-mail). Leading blank line included so
// the link stands apart from the message.
export function appLinkText(appUrl) {
  return isUsableAppUrl(appUrl) ? `\n\n${APP_LINK_LABEL}: ${String(appUrl).trim()}` : '';
}

// Trailing HTML paragraph for an HTML body (e-mail, Graph channel message).
export function appLinkHtml(appUrl) {
  if (!isUsableAppUrl(appUrl)) return '';
  const url = escapeHtml(String(appUrl).trim());
  return `<p><a href="${url}">${APP_LINK_LABEL}</a></p>`;
}

// Slack renders `<url|label>` as a link inside the message text.
export function appLinkSlack(appUrl) {
  return isUsableAppUrl(appUrl) ? `\n<${String(appUrl).trim()}|${APP_LINK_LABEL}>` : '';
}

// MessageCard action for a Teams incoming webhook. Returns null when there is
// no link, so the caller can leave `potentialAction` off the payload entirely.
export function appLinkCardAction(appUrl) {
  if (!isUsableAppUrl(appUrl)) return null;
  return {
    '@type': 'OpenUri',
    name: APP_LINK_LABEL,
    targets: [{ os: 'default', uri: String(appUrl).trim() }],
  };
}
