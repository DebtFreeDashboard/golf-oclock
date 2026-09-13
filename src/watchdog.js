// Watchdog — answers one question: is the pipeline actually alive?
//
// It exists because of a silent failure on 2026-09-12: one "Fast alert poll"
// run sat in Queued for three hours, never started, and held the shared
// `golf-poll` concurrency lock. Every run behind it was cancelled. Nothing
// errored, nothing went red, no push fired. The only signal was Kevin noticing
// stale times by eye, three hours later.
//
// Two checks, in order:
//   1. Freshness  — has data/teetimes.json been written recently?
//   2. Stuck runs — is a run sitting in `queued` far longer than it should be?
//                   If so, cancel it, which frees the lock and lets the next
//                   scheduled run through.
//
// CRITICAL: this must never join the `golf-poll` concurrency group. A watchdog
// that queues behind the thing it is watching cannot report that it is stuck.

const STALE_MINUTES = Number(process.env.STALE_MINUTES || 45);
const STUCK_MINUTES = Number(process.env.STUCK_MINUTES || 20);
const NTFY_SERVER = process.env.NTFY_SERVER || 'https://ntfy.sh';
const REPO = process.env.GITHUB_REPOSITORY;           // "CartLabs/golf-oclock"
const TOKEN = process.env.GITHUB_TOKEN;
const DRY_RUN = process.argv.includes('--dry-run');

const MIN = 60_000;

/** Minutes between an ISO timestamp and now. */
export function ageMinutes(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return (now - t) / MIN;
}

/** Freshness verdict for a teetimes.json payload. */
export function freshness(data, now = Date.now(), limit = STALE_MINUTES) {
  const age = ageMinutes(data?.updatedAt, now);
  if (age == null) return { ok: false, age: null, reason: 'no readable updatedAt' };
  return { ok: age <= limit, age, reason: `data is ${Math.round(age)} min old` };
}

/** Runs that have been sitting in the queue too long to be normal. */
export function stuckRuns(runs, now = Date.now(), limit = STUCK_MINUTES) {
  return runs
    .filter((r) => r.status === 'queued')
    .map((r) => ({ ...r, waited: ageMinutes(r.created_at, now) }))
    .filter((r) => r.waited != null && r.waited > limit);
}

async function gh(path, init = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${TOKEN}`,
      'x-github-api-version': '2022-11-28',
      ...(init.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`${init.method || 'GET'} ${path} → ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

async function push({ title, body, priority = 'high', tags = 'warning' }) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return console.log('[watchdog] NTFY_TOPIC not set — skipping push.');
  if (DRY_RUN) return console.log(`[watchdog] DRY RUN would push: ${title} — ${body}`);
  try {
    await fetch(`${NTFY_SERVER}/${encodeURIComponent(topic)}`, {
      method: 'POST',
      headers: {
        Title: title,
        Tags: tags,
        Priority: priority,
        Click: `https://github.com/${REPO}/actions`,
      },
      body,
    });
  } catch (err) {
    console.error('[watchdog] push failed:', err.message);
  }
}

async function main() {
  const problems = [];

  // ---- 1. Is the data fresh? -------------------------------------------
  const raw = await import('node:fs/promises')
    .then((fs) => fs.readFile('data/teetimes.json', 'utf8'))
    .catch(() => null);

  if (!raw) {
    problems.push('data/teetimes.json is missing or unreadable.');
  } else {
    const f = freshness(JSON.parse(raw));
    console.log(`[watchdog] ${f.reason} (limit ${STALE_MINUTES} min) — ${f.ok ? 'OK' : 'STALE'}`);
    if (!f.ok) problems.push(`Tee time data is ${Math.round(f.age)} minutes old.`);
  }

  // ---- 2. Is a run wedged in the queue? --------------------------------
  // Done even when the data looks fine: catching a jam early is the whole point.
  let cancelled = [];
  if (TOKEN && REPO) {
    try {
      const { workflow_runs: runs = [] } = await gh(`/repos/${REPO}/actions/runs?per_page=30`);
      const stuck = stuckRuns(runs).filter((r) => r.id !== Number(process.env.GITHUB_RUN_ID));

      for (const r of stuck) {
        console.log(`[watchdog] ${r.name} #${r.run_number} queued ${Math.round(r.waited)} min — cancelling.`);
        if (DRY_RUN) continue;
        try {
          await gh(`/repos/${REPO}/actions/runs/${r.id}/cancel`, { method: 'POST' });
          cancelled.push(`${r.name} #${r.run_number} (queued ${Math.round(r.waited)} min)`);
        } catch (err) {
          console.error(`[watchdog] could not cancel #${r.run_number}:`, err.message);
          problems.push(`A run is stuck in the queue and could not be cancelled: #${r.run_number}.`);
        }
      }
      if (!stuck.length) console.log('[watchdog] no runs stuck in the queue.');
    } catch (err) {
      console.error('[watchdog] could not read workflow runs:', err.message);
    }
  }

  // ---- 3. Say something useful ------------------------------------------
  if (cancelled.length) {
    await push({
      title: '⛳ Poller was jammed — unstuck it',
      body: `Cancelled ${cancelled.join(', ')}.\nPolling should resume within 15 minutes. No action needed unless this repeats.`,
      priority: 'default',
      tags: 'wrench',
    });
  }

  if (problems.length) {
    await push({
      title: '⛳ Tee times have gone stale',
      body: `${problems.join('\n')}\nAlerts are not being checked right now.`,
    });
    console.error('[watchdog] PROBLEMS:\n' + problems.join('\n'));
    process.exit(1);          // red run + GitHub's own failure email, for free
  }

  console.log('[watchdog] healthy.');
}

if (process.argv[1]?.endsWith('watchdog.js')) {
  main().catch((err) => {
    console.error('[watchdog] crashed:', err);
    process.exit(1);
  });
}
