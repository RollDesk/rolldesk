// Recipients of a client-facing e-mail — pure list handling, no I/O, so it is
// testable without SMTP (the same split as ipAllowlist.js and releasePackage.js).
//
// Every other notification RollDesk sends is addressed to one recipient at a
// time: a webhook, or one mailbox per project. The message that asks a client to
// approve a production rollout is a different document. It goes to several people
// at the client at once, the DXC side is copied on it, and — this is the part no
// other channel needs — the client answers by *replying to the mail*, not by
// opening the app. A reply to the instance's `SMTP_FROM` (a no-reply address)
// reaches nobody, so the copy list is also what `Reply-To` is set to: the service
// mailbox that fields those answers.
//
// Hence two lists per client rather than one, and hence one message rather than
// one per address: a Cc repeated across five separate messages would put five
// copies in the service mailbox and give the client five threads to reply to.

// Deliberately generous, and deliberately not unbounded: the addresses arrive in
// a request body, and the JSONB they are stored in is bounded everywhere else for
// the same reason (see the MAX_* clamps in releasePackage.js).
export const MAX_RECIPIENTS = 50;

// The same shape the rest of the backend accepts (routes/auth.js, notifications.js).
// Deliberately not a full RFC 5322 grammar: the point is to reject a typo and a
// header-injection attempt, not to be the authority on what an address may look
// like — the SMTP server is.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const str = (v) => (v == null ? '' : String(v)).trim();

// Accepts what a browser sends: bare addresses, `{email}`/`{address}` objects, or
// a mix. Names are not carried into the header — they are a label in the client
// editor, and putting operator-typed text into a mail header is how a header gets
// injected.
function addressOf(entry) {
  if (entry == null) return '';
  if (typeof entry === 'string') return str(entry);
  if (typeof entry !== 'object') return '';
  return str(entry.email ?? entry.address);
}

// Clean a recipient list. Returns the deliverable addresses and the entries that
// were rejected, so a caller can report „three sent, one address is a typo"
// rather than silently dropping one — an address quietly missing from a mail the
// client is expected to answer is worse than an error.
//
// Deduplicated case-insensitively (a mailbox is one recipient however it was
// typed) while the first spelling is what gets sent, because that is the one the
// operator entered.
export function normalizeRecipients(raw, max = MAX_RECIPIENTS) {
  const list = Array.isArray(raw) ? raw : (raw == null ? [] : [raw]);
  const seen = new Set();
  const addresses = [];
  const invalid = [];
  for (const entry of list.slice(0, max)) {
    const address = addressOf(entry);
    if (!address) continue;
    if (!EMAIL_RE.test(address)) { invalid.push(address); continue; }
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    addresses.push(address);
  }
  return { addresses, invalid };
}

// The audience of one client-facing message, given the two lists as the browser
// holds them. `replyTo` is the copy list rather than a third setting: an operator
// asked to keep „who is copied" and „where the answer goes" in step by hand is an
// operator who will one day have them disagree, and the answer landing in the
// wrong place is silent — the client believes they replied.
//
// A recipient that appears in both lists is dropped from the copy: a mailbox that
// is asked to decide does not also need to be copied, and some clients collapse
// such a message into one thread and some do not.
export function clientMailAudience({ to, cc } = {}, max = MAX_RECIPIENTS) {
  const toList = normalizeRecipients(to, max);
  const ccList = normalizeRecipients(cc, max);
  const addressed = new Set(toList.addresses.map((a) => a.toLowerCase()));
  const copies = ccList.addresses.filter((a) => !addressed.has(a.toLowerCase()));
  return {
    to: toList.addresses,
    cc: copies,
    // Reply-To only when there is a copy list to send the answer to. With none,
    // omitting the header leaves the reply going to `SMTP_FROM`, which is at
    // least the instance's own address rather than a wrong one.
    replyTo: copies,
    invalid: toList.invalid.concat(ccList.invalid),
  };
}
