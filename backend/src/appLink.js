// The "open the app" link appended to outgoing notifications, and the
// per-channel formatting of a notification body.
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

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// A plain-text notification body as an HTML paragraph. The body carries text a
// person typed (a failure reason, a target name), so it must be escaped rather
// than interpolated — an `<` in a reason used to swallow the rest of the line in
// an HTML mail client. Newlines become <br> so the layout survives.
//
// With `link` ({label, url}) the first occurrence of the label — the deployment
// id, which every notification body already names — becomes the anchor. The
// label is escaped before it is looked up, so the search happens in the escaped
// body and the anchor is the only markup that survives.
export function bodyToHtml(text, link) {
  let html = escapeHtml(String(text == null ? '' : text));
  const label = link ? escapeHtml(String(link.label || '').trim()) : '';
  if (label && isUsableAppUrl(link.url)) {
    const at = html.indexOf(label);
    if (at >= 0) {
      const href = escapeHtml(String(link.url).trim());
      html = `${html.slice(0, at)}<a href="${href}">${label}</a>${html.slice(at + label.length)}`;
    }
  }
  return `<p>${html.replace(/\n/g, '<br>')}</p>`;
}

// A plain-text body as the `text` of a Teams MessageCard.
//
// MessageCard renders Markdown, where a lone newline collapses into a space.
// That used to be fixed by doubling every newline into a paragraph break, which
// kept the lines apart but also put a blank line between every single one — a
// notification carrying a 15-line changelog rendered at twice the height and
// read as endless in the channel. Two trailing spaces is Markdown's hard line
// break: the lines stay separate with no blank line between them. Runs of blank
// lines the author wrote deliberately still separate paragraphs.
export function bodyToCardText(text) {
  return String(text == null ? '' : text)
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)                                 // deliberate paragraph breaks
    .map((para) => para.split('\n').join('  \n'))    // hard break, no blank line
    .join('\n\n');
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

// Whether the body already carries its own link back to the app, so a channel
// must not append a second one. The UI builds a labelled link into schedule
// notifications ("Open the schedule in RollDesk: <url>"); appending the generic
// link on top of it put two links in the same message.
export function hasAppLink(text, appUrl) {
  if (!isUsableAppUrl(appUrl)) return false;
  return String(text == null ? '' : text).includes(String(appUrl).trim());
}

// URL of one deployment. The app routes `#deployments/<id>` to that row, so a
// notification can point at the schedule it is about instead of at the list.
// Returns '' when there is no usable base URL or no id.
export function deploymentUrl(appUrl, deploymentId) {
  const id = String(deploymentId == null ? '' : deploymentId).trim();
  if (!id || !isUsableAppUrl(appUrl)) return '';
  return `${String(appUrl).trim().replace(/\/+$/, '')}/#deployments/${encodeURIComponent(id)}`;
}

// URL of one release package, the same idea one level earlier in the process: the
// app routes `#packages/<id>` to that row, so „package handed over for deployment"
// opens the package instead of the app's front page and a list to search.
export function packageUrl(appUrl, packageId) {
  const id = String(packageId == null ? '' : packageId).trim();
  if (!id || !isUsableAppUrl(appUrl)) return '';
  return `${String(appUrl).trim().replace(/\/+$/, '')}/#packages/${encodeURIComponent(id)}`;
}

// Turn the first occurrence of `label` in the body into a link, in the target's
// own markup. Every notification body already names its deployment id, so making
// that the link means no separate "open the app" line: the id is the thing the
// reader recognises and the thing they want to click.
//
// Only the first occurrence is linked — the id repeats in the changelog often
// enough that linking every one would read as noise. Both helpers return the
// body unchanged when there is no url or the label isn't in it.
function linkifyFirst(text, label, url, render) {
  const body = String(text == null ? '' : text);
  const needle = String(label == null ? '' : label).trim();
  if (!needle || !isUsableAppUrl(url)) return body;
  const at = body.indexOf(needle);
  if (at < 0) return body;
  return body.slice(0, at) + render(needle, String(url).trim()) + body.slice(at + needle.length);
}

// Slack renders `<url|label>` inline.
export function linkLabelSlack(text, label, url) {
  return linkifyFirst(text, label, url, (l, u) => `<${u}|${l}>`);
}

// A Teams MessageCard renders Markdown, so `[label](url)`. The id is
// alphanumeric with dashes, so it needs no escaping inside the brackets.
export function linkLabelMarkdown(text, label, url) {
  return linkifyFirst(text, label, url, (l, u) => `[${l}](${u})`);
}

// The two bodies of one outgoing e-mail, in the order their parts have to appear:
// the message, then the link back to the app, then the signature.
//
// The order is the whole point of doing this in one place. The message ends by
// asking the reader to open the rollout („…can also be approved in RollDesk:"), so
// the link belongs directly under it — and a signature appended after the link, or
// a link appended after the signature, both read as an unfinished sentence followed
// by a stray URL. The client's approval request is the one mail that carries all
// three parts, and it is also the one nobody sees before it is sent.
//
// `link` ({label, url}) turns the label — the deployment id — into the anchor of
// the HTML part and spells the URL out under the text part, because a text-only
// client cannot carry an anchor. With no link at all, `appUrl` contributes the
// generic „Open RollDesk" line instead; a body that already links back to the app
// gets neither (hasAppLink), which is what stops two links landing in one message.
export function mailBodyParts({ text, footer, link, appUrl } = {}) {
  const body = String(text == null ? '' : text);
  const sign = String(footer == null ? '' : footer).trim();
  const url = link && isUsableAppUrl(link.url) ? String(link.url).trim() : '';
  const ownLink = !!url || hasAppLink(body, appUrl);
  const textLink = url ? `\n\n${url}` : (ownLink ? '' : appLinkText(appUrl));
  const htmlLink = url ? '' : (ownLink ? '' : appLinkHtml(appUrl));
  return {
    text: body + textLink + (sign ? `\n\n${sign}` : ''),
    html: bodyToHtml(body, url ? link : null) + htmlLink + (sign ? bodyToHtml(sign) : ''),
  };
}

// --- Chat-channel headline (Slack / Teams only) -----------------------------
//
// A chat channel renders the subject as a heading *above* the body, so an event
// arrived as two stacked lines — "RollDesk — Prośba o akceptację" over
// "DEP-2026-0054 — WORD" — where the product name is the only thing in bold and
// the deployment, the thing the reader is looking for, sits underneath. Folding
// the event onto the body's own first line gives one headline,
// "DEP-2026-0054 — WORD - Prośba o akceptację", and because it lives in the body
// the id in it can be a link — a subject/heading field cannot carry one.
//
// E-mail keeps the subject as a separate header: there it is a real envelope
// field, not a line rendered next to the body, so nothing is duplicated.

// The product prefix every subject carries. It names the instance, not the
// event, and the channel itself already says which app posted — so it goes when
// the subject is folded into the body.
const SUBJECT_PREFIX = /^\s*RollDesk\s*(?:—|-|–)\s*/;

export function subjectEvent(subject) {
  return String(subject == null ? '' : subject).replace(SUBJECT_PREFIX, '').trim();
}

// Fold the subject's event onto the body's first line and return the new body,
// or null when it does not apply — in which case the channel keeps rendering
// its own title above the body as before.
//
// It applies only when the body's first line opens with the deployment id, which
// is what makes the merged line a headline the id can be linked in. A body with
// no id (or a first line that starts with something else) is left alone rather
// than guessed at.
export function foldSubjectIntoLead(text, subject, deploymentId) {
  const body = String(text == null ? '' : text);
  const id = String(deploymentId == null ? '' : deploymentId).trim();
  const event = subjectEvent(subject);
  if (!id || !event) return null;
  const nl = body.indexOf('\n');
  const lead = nl < 0 ? body : body.slice(0, nl);
  if (!lead.trimStart().startsWith(id)) return null;
  // Nothing to add when the lead already ends with the event — a body built by a
  // future UI that names the event itself must not get it twice.
  if (lead.trimEnd().endsWith(event)) return body;
  const rest = nl < 0 ? '' : body.slice(nl);
  return `${lead.trimEnd()} - ${event}${rest}`;
}
