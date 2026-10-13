/**
 * LogLens Rule Engine
 * R1: Failure Burst → Success (≥ N failures within W minutes before a success)
 * R2: After-Hours Success (success outside lab open–close)
 */

function parseTs(s) {
  const d = new Date(String(s).replace(' ', 'T'));
  return isNaN(d.getTime()) ? null : d;
}

function formatTs(d) {
  if (!d) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function isOutsideHours(date, openStr, closeStr) {
  const [oh, om] = openStr.split(':').map(Number);
  const [ch, cm] = closeStr.split(':').map(Number);
  const mins = date.getHours() * 60 + date.getMinutes();
  const openMins = oh * 60 + om;
  const closeMins = ch * 60 + cm;
  return mins < openMins || mins >= closeMins;
}

/**
 * @param {Array} events - array of {event_id, timestamp, account, computer, event, department_case}
 * @param {object} opts - { N, W, openTime, closeTime }
 */
function detect(events, opts = {}) {
  const N = Math.max(1, parseInt(opts.N, 10) || 3);
  const W = Math.max(1, parseInt(opts.W, 10) || 5);
  const openTime = opts.openTime || '08:30';
  const closeTime = opts.closeTime || '17:30';

  // Normalize & sort
  const normalized = events
    .map((e) => ({
      event_id: String(e.event_id || e.id || ''),
      timestamp: typeof e.timestamp === 'string' ? parseTs(e.timestamp) : e.timestamp,
      account: String(e.account || '').trim(),
      computer: String(e.computer || '').trim(),
      event: String(e.event || '').trim() === 'Failure' ? 'Failure' : 'Success',
      department_case: String(e.department_case || e.department || ''),
    }))
    .filter((e) => e.timestamp && e.account && e.computer)
    .sort((a, b) => a.timestamp - b.timestamp);

  const groups = new Map();
  for (const e of normalized) {
    const key = `${e.account}||${e.computer}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }

  const results = [];

  for (const [key, evts] of groups) {
    const [account, computer] = key.split('||');
    const failures = [];
    let r1 = false;
    let r2 = false;
    let r1Detail = null;
    let r2Detail = null;
    const matchedIds = new Set();

    for (const e of evts) {
      if (e.event === 'Failure') {
        failures.push(e);
        continue;
      }

      // R1 look-back
      const windowStart = new Date(e.timestamp.getTime() - W * 60000);
      const recentFails = failures.filter(
        (f) => f.timestamp >= windowStart && f.timestamp < e.timestamp
      );

      if (recentFails.length >= N) {
        r1 = true;
        r1Detail = {
          failCount: recentFails.length,
          windowMin: W,
          from: formatTs(recentFails[0].timestamp),
          to: formatTs(e.timestamp),
          eventIds: [...recentFails.map((f) => f.event_id), e.event_id],
        };
        recentFails.forEach((f) => matchedIds.add(f.event_id));
        matchedIds.add(e.event_id);
      }

      // R2
      if (isOutsideHours(e.timestamp, openTime, closeTime)) {
        r2 = true;
        r2Detail = {
          at: formatTs(e.timestamp),
          eventId: e.event_id,
        };
        matchedIds.add(e.event_id);
      }
    }

    let priority, reason, humanCheck;

    if (r1 && r2) {
      priority = 'PRIORITY';
      reason = `${r1Detail.failCount} failures → success within ${W} min AND after-hours login`;
      humanCheck =
        'Was this after-hours login allowed? Verify whether the account holder or an authorized person was expected.';
    } else if (r1) {
      priority = 'REVIEW';
      reason = `${r1Detail.failCount} failures → success within ${W} min window`;
      humanCheck = 'Was this a scheduled guest / shared session or legitimate password retry?';
    } else if (r2) {
      priority = 'REVIEW';
      reason = `Successful login outside lab hours (${openTime}–${closeTime})`;
      humanCheck = 'Was after-hours access pre-approved for this account / machine?';
    } else {
      priority = 'ROUTINE';
      const totalFails = failures.length;
      if (totalFails === 0) reason = 'No failures observed';
      else if (totalFails < N) reason = `${totalFails} failure(s) — below threshold N=${N}`;
      else
        reason = `${totalFails} failure(s) spread outside window W=${W} min (no burst before success)`;
      humanCheck = null;
    }

    results.push({
      case_key: key,
      account,
      computer,
      department: evts[0]?.department_case || '',
      priority,
      r1: r1 ? 1 : 0,
      r2: r2 ? 1 : 0,
      reason,
      human_check: humanCheck,
      event_count: evts.length,
      matched_event_ids: JSON.stringify([...matchedIds]),
      r1_detail: r1Detail ? JSON.stringify(r1Detail) : null,
      r2_detail: r2Detail ? JSON.stringify(r2Detail) : null,
      events: evts.map((e) => ({
        event_id: e.event_id,
        timestamp: formatTs(e.timestamp),
        event: e.event,
      })),
    });
  }

  const order = { PRIORITY: 0, REVIEW: 1, ROUTINE: 2 };
  results.sort(
    (a, b) => order[a.priority] - order[b.priority] || a.account.localeCompare(b.account)
  );
  return results;
}

module.exports = { detect, parseTs, formatTs };
