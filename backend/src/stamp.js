// Wall-clock stamps for the human-readable strings the timeline and the audit
// log store (`YYYY-MM-DD` + `HH:MM`).
//
// These are *display* strings captured at write time, not instants: the UI shows
// them verbatim next to entries the browser wrote from its own local clock. A
// container runs in UTC unless told otherwise, so a backend-written entry landed
// two hours behind the ones the UI wrote from the same office — the timeline
// interleaved them in the wrong order. The zone is therefore explicit and comes
// from configuration rather than from whatever the host happens to be set to.
//
// Pure on purpose (takes the date and the zone), so it is testable without
// touching the process environment or the clock.

// Formats `date` as the stored stamp shape in `timeZone`. An empty/undefined
// zone means the runtime's own zone, which is what a bare `npm start` on a
// correctly-configured host wants.
export function formatStamp(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timeZone || undefined,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date);
  const get = (type) => (parts.find((p) => p.type === type) || {}).value || '';
  // `hour12: false` renders midnight as "24" in some ICU versions.
  const hour = get('hour') === '24' ? '00' : get('hour');
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${hour}:${get('minute')}`,
  };
}

// True when `timeZone` is an IANA zone this runtime understands. Used by the
// config module to fall back (with a warning) instead of throwing on every
// request from a typo in the environment.
export function isValidTimeZone(timeZone) {
  if (!timeZone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}
