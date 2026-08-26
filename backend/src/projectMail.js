// The per-project sign-off of the client-facing e-mail, as it is stored.
//
// The approval request leaves the instance from a no-reply sender, so without a
// footer it ends on a link and reads as machine-generated. The text belongs to the
// project rather than to the instance: which team signs a rollout is a project's
// own answer, and one RollDesk serves several of them.
//
// It lives in the project's `data` JSONB (the hybrid storage the whole app uses:
// nothing filters or sorts by a footer, so it needs no column), and like every
// other value written there it is bounded on purpose — the same reason as the
// MAX_* clamps in releasePackage.js. A footer arrives in a request body, and the
// form that normally writes it is not the only way to reach the endpoint.
//
// Pure, so the bounds are testable without a database (see clientMail.js).

// Four or five lines of a sign-off, matching the maxlength of the editor's
// textarea. Long enough for „regards, team, mailbox, telephone", short enough that
// it cannot become a second changelog pasted into every mail.
export const MAX_MAIL_FOOTER = 2000;

// Normalize a footer for storage: CRLF from a Windows clipboard folded to \n, the
// runs of blank lines a paste brings with it collapsed, control characters dropped
// (a footer is composed into a mail body, and a stray \r there is how a line ends
// up looking like the start of a header), then trimmed and clamped.
//
// Returns '' for anything unusable — an absent, blank or non-string value — which
// is also what „no footer configured" is stored as, so the composer can fall back
// to the default text with a single check.
export function normalizeMailFooter(raw, max = MAX_MAIL_FOOTER) {
  if (typeof raw !== 'string') return '';
  const text = raw
    .replace(/\r\n?/g, '\n')
    // Everything below space except the newline just normalized, and DEL.
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text.length > max ? text.slice(0, max).trim() : text;
}
