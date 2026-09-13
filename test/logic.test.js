// Offline tests for the logic that decides whether your phone buzzes.
// No network. Run with: npm test
import assert from 'node:assert/strict';
import { matchesWatch, findNewMatches, currentKeys, mergeSeen, hotTargets } from '../src/alerts.js';
import { to12h, normalizeTime, utcToLocalParts, addDays, slotKey } from '../src/lib.js';
import { ageMinutes, freshness, stuckRuns } from '../src/watchdog.js';

let passed = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

const slot = (over = {}) => ({
  courseId: 'hickory-hill', courseName: 'Hickory Hill', town: 'Methuen', state: 'MA',
  platform: 'foreUP', date: '2026-09-12', time24: '08:00', timeLabel: '8:00am',
  holes: 18, availableSpots: 4, maxPlayers: 4, greenFee: 56, cartFee: 24,
  backNine: false, bookingUrl: 'x', ...over,
});

console.log('time helpers');
t('to12h converts midday and midnight correctly', () => {
  assert.equal(to12h('12:00'), '12:00pm');
  assert.equal(to12h('00:30'), '12:30am');
  assert.equal(to12h('14:05'), '2:05pm');
});
t('normalizeTime pads and truncates seconds', () => {
  assert.equal(normalizeTime('7:09'), '07:09');
  assert.equal(normalizeTime('08:00:00'), '08:00');
  assert.equal(normalizeTime('nope'), null);
});
t('utcToLocalParts converts UTC to Eastern', () => {
  // 11:10 UTC on Sep 12 is 7:10am EDT.
  const r = utcToLocalParts('2026-09-12T11:10:00.000Z');
  assert.equal(r.date, '2026-09-12');
  assert.equal(r.time24, '07:10');
  assert.equal(r.label, '7:10am');
});
t('utcToLocalParts rolls the date backwards when needed', () => {
  // 01:30 UTC Sep 13 is 9:30pm EDT on Sep 12 — must not report Sep 13.
  const r = utcToLocalParts('2026-09-13T01:30:00.000Z');
  assert.equal(r.date, '2026-09-12');
  assert.equal(r.time24, '21:30');
});
t('addDays crosses a month boundary', () => {
  assert.equal(addDays('2026-09-29', 5), '2026-10-04');
});

console.log('watch matching');
t('matches an open weekend morning foursome', () => {
  const w = { label: 'w', courses: ['any'], daysOfWeek: [0, 6], timeFrom: '06:00', timeTo: '10:30', holes: 18, minSpots: 4 };
  assert.equal(matchesWatch(slot(), w), true); // 2026-09-12 is a Saturday
});
t('rejects a time outside the window', () => {
  const w = { label: 'w', timeFrom: '06:00', timeTo: '07:00' };
  assert.equal(matchesWatch(slot({ time24: '08:00' }), w), false);
});
t('rejects the wrong day of week', () => {
  const w = { label: 'w', daysOfWeek: [1] }; // Monday only
  assert.equal(matchesWatch(slot(), w), false);
});
t('rejects too few open spots', () => {
  const w = { label: 'w', minSpots: 4 };
  assert.equal(matchesWatch(slot({ availableSpots: 2 }), w), false);
});
t('rejects the wrong course', () => {
  const w = { label: 'w', courses: ['tree-house'] };
  assert.equal(matchesWatch(slot(), w), false);
});
t('respects maxGreenFee, including unknown prices', () => {
  assert.equal(matchesWatch(slot({ greenFee: 56 }), { label: 'w', maxGreenFee: 40 }), false);
  assert.equal(matchesWatch(slot({ greenFee: 35 }), { label: 'w', maxGreenFee: 40 }), true);
  assert.equal(matchesWatch(slot({ greenFee: null }), { label: 'w', maxGreenFee: 40 }), false);
});
t('a disabled watch never matches', () => {
  assert.equal(matchesWatch(slot(), { label: 'w', enabled: false }), false);
});
t('holes filter ignores slots with unknown hole count', () => {
  assert.equal(matchesWatch(slot({ holes: null }), { label: 'w', holes: 18 }), true);
  assert.equal(matchesWatch(slot({ holes: 9 }), { label: 'w', holes: 18 }), false);
});

console.log('new-opening detection');
const w4 = { label: 'Weekend 4some', courses: ['any'], timeFrom: '06:00', timeTo: '12:00', minSpots: 4 };
t('a slot already seen does not alert twice', () => {
  const s = slot();
  const seen = currentKeys([s]);
  assert.equal(findNewMatches([s], [w4], seen).length, 0);
});
t('a genuinely new slot alerts once', () => {
  const older = slot();
  const fresh = slot({ time24: '09:00', timeLabel: '9:00am' });
  const seen = currentKeys([older]);
  const hits = findNewMatches([older, fresh], [w4], seen);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].slot.time24, '09:00');
});
t('a slot that closes and reopens alerts again', () => {
  const s = slot();
  let seen = currentKeys([s]);          // open
  seen = currentKeys([]);                // taken — disappears from the sheet
  assert.equal(findNewMatches([s], [w4], seen).length, 1); // reopened
});
t('9 and 18 on the same time are tracked separately', () => {
  const a = slot({ holes: 18 });
  const b = slot({ holes: 9 });
  assert.notEqual(slotKey(a), slotKey(b));
});
t('front and back nine are tracked separately', () => {
  assert.notEqual(slotKey(slot({ backNine: false })), slotKey(slot({ backNine: true })));
});
t('seen keys only retain in-range dates', () => {
  const keys = currentKeys([slot({ date: '2026-09-12' }), slot({ date: '2026-09-13' })]);
  assert.equal(keys.length, 2);
});

console.log('fast poll targeting');
const ALL = ['pine-valley','hickory-hill','billerica'];
const DATES = ['2026-09-12','2026-09-13','2026-09-14','2026-09-15'];  // Sat..Tue

t('a one-off watch targets only its course and date', () => {
  const r = hotTargets([{ enabled:true, courses:['pine-valley'], dates:['2026-09-13'] }], ALL, DATES);
  assert.deepEqual(r.courseIds, ['pine-valley']);
  assert.deepEqual(r.dates, ['2026-09-13']);
});
t('"any course" expands to every course', () => {
  const r = hotTargets([{ enabled:true, courses:['any'], dates:['2026-09-12'] }], ALL, DATES);
  assert.equal(r.courseIds.length, 3);
});
t('a day-of-week watch picks the matching dates only', () => {
  const r = hotTargets([{ enabled:true, courses:['billerica'], daysOfWeek:[0,6] }], ALL, DATES);
  assert.deepEqual(r.dates, ['2026-09-12','2026-09-13']);   // Sat + Sun
});
t('disabled and fully-past watches are skipped', () => {
  assert.deepEqual(hotTargets([{ enabled:false, courses:['pine-valley'], dates:['2026-09-13'] }], ALL, DATES).courseIds, []);
  assert.deepEqual(hotTargets([{ enabled:true, courses:['pine-valley'], dates:['2020-01-01'] }], ALL, DATES).courseIds, []);
});
t('no live watches means nothing to poll', () => {
  const r = hotTargets([], ALL, DATES);
  assert.equal(r.courseIds.length, 0);
  assert.equal(r.dates.length, 0);
});

console.log('partial-poll seen state');
t('a partial poll does not make other courses look new', () => {
  const prev = ['pine-valley|2026-09-12|07:00|18|f', 'billerica|2026-09-12|08:00|18|f'];
  const fresh = ['pine-valley|2026-09-12|09:00|18|f'];
  const merged = mergeSeen(prev, ['pine-valley'], fresh);
  assert.ok(merged.includes('billerica|2026-09-12|08:00|18|f'), 'unpolled course must be preserved');
  assert.ok(merged.includes('pine-valley|2026-09-12|09:00|18|f'));
  assert.ok(!merged.includes('pine-valley|2026-09-12|07:00|18|f'), 'polled course state is replaced');
});
t('merging is idempotent', () => {
  const prev = ['a|d|07:00|18|f'];
  assert.deepEqual(mergeSeen(prev, ['a'], ['a|d|07:00|18|f']), prev);
});

/* ── network resilience (stubbed fetch, no real requests) ────────────── */
import { getJson } from '../src/lib.js';

const realFetch = globalThis.fetch;
function stubFetch(responses) {
  var i = 0;
  const calls = [];
  globalThis.fetch = async function (url, opts) {
    calls.push({ url, headers: opts && opts.headers });
    const r = responses[Math.min(i++, responses.length - 1)];
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: (k) => (r.headers || {})[k.toLowerCase()] || null },
      json: async () => r.body,
      text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body || '')),
    };
  };
  return calls;
}
const at = async (name, fn) => {
  try { await fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

console.log('network resilience');

await at('retries a 429 and then succeeds', async () => {
  const calls = stubFetch([
    { status: 429, body: 'Too Many Requests' },
    { status: 200, body: { ok: true } },
  ]);
  const out = await getJson('https://example.test/a');
  assert.deepEqual(out, { ok: true });
  assert.equal(calls.length, 2);
});

await at('gives up on a 403 without retrying', async () => {
  const calls = stubFetch([{ status: 403, body: 'Attention Required! | Cloudflare' }]);
  await assert.rejects(() => getJson('https://example.test/b'), /HTTP 403/);
  assert.equal(calls.length, 1, 'should not retry a non-retryable status');
});

await at('puts the response body in the error so failures are diagnosable', async () => {
  stubFetch([{ status: 403, body: 'Attention Required! | Cloudflare' }]);
  try { await getJson('https://example.test/c'); assert.fail('should have thrown'); }
  catch (e) { assert.match(e.message, /Cloudflare/); }
});

await at('sends browser-like headers by default', async () => {
  const calls = stubFetch([{ status: 200, body: {} }]);
  await getJson('https://example.test/d');
  assert.match(calls[0].headers['user-agent'], /Chrome/);
  assert.ok(calls[0].headers['accept-language']);
});

await at('lets an adapter add its own headers', async () => {
  const calls = stubFetch([{ status: 200, body: {} }]);
  await getJson('https://example.test/e', { headers: { referer: 'https://teewire.app/x' } });
  assert.equal(calls[0].headers.referer, 'https://teewire.app/x');
});

await at('eventually gives up and surfaces the last error', async () => {
  stubFetch([{ status: 503, body: 'down' }]);
  await assert.rejects(() => getJson('https://example.test/f', { retries: 1 }), /HTTP 503/);
});

/* ── Chronogolf paging + booking-window stop ─────────────────────────── */
import { fetchChronogolf } from '../src/adapters/chronogolf.js';

process.env.CHRONOGOLF_THROTTLE_MS = '0';   // don't make the suite wait

const cgCourse = {
  id: 'test-cg', name: 'Test CC', town: 'X', state: 'MA',
  bookingUrl: 'https://example.test/club',
  chronogolf: { slug: 'test', courseUuids: ['uuid-1'] },
};
const teetime = (t) => ({
  starts_at: `2026-09-12T${t}:00Z`, max_player_size: 4, min_player_size: 1,
  hole: 1, frozen: false, default_price: { green_fee: 40, bookable_holes: 18 },
});

/** Stub that serves `pages` keyed by "date|page". */
function stubPages(map) {
  const seen = [];
  globalThis.fetch = async function (url) {
    const u = new URL(url);
    const key = u.searchParams.get('start_date') + '|' + u.searchParams.get('page');
    seen.push(key);
    return {
      ok: true, status: 200,
      headers: { get: () => null },
      json: async () => ({ teetimes: map[key] || [] }),
      text: async () => '',
    };
  };
  return seen;
}

console.log('chronogolf paging');

await at('follows pagination past the 24-result page cap', async () => {
  const full = Array.from({ length: 24 }, (_, i) => teetime(String(11 + Math.floor(i / 6)).padStart(2, '0')));
  const seen = stubPages({
    '2026-09-12|1': full,
    '2026-09-12|2': [teetime('20')],   // the twilight slots that were being dropped
  });
  const out = await fetchChronogolf(cgCourse, ['2026-09-12']);
  assert.equal(out.length, 25, 'should include page 2');
  assert.ok(seen.includes('2026-09-12|2'), 'should have requested page 2');
});

await at('stops requesting once past the booking window', async () => {
  const dates = ['2026-09-12','2026-09-13','2026-09-14','2026-09-15','2026-09-16','2026-09-17'];
  const seen = stubPages({ '2026-09-12|1': [teetime('11')] });   // only day 1 has times
  await fetchChronogolf(cgCourse, dates);
  var daysHit = new Set(seen.map(k => k.split('|')[0])).size;
  assert.equal(daysHit, 3, `should stop after 2 empty days, hit ${daysHit}`);
});

await at('a single sold-out day does not truncate the rest of the week', async () => {
  const dates = ['2026-09-12','2026-09-13','2026-09-14','2026-09-15'];
  const seen = stubPages({
    '2026-09-12|1': [teetime('11')],
    // 09-13 empty (sold out)
    '2026-09-14|1': [teetime('12')],
    '2026-09-15|1': [teetime('13')],
  });
  const out = await fetchChronogolf(cgCourse, dates);
  assert.equal(new Set(seen.map(k => k.split('|')[0])).size, 4, 'should keep going past one empty day');
  assert.equal(out.length, 3);
});

console.log('watchdog');
const NOW = Date.parse('2026-09-12T21:00:00Z');
t('freshness passes on data written a few minutes ago', () => {
  const f = freshness({ updatedAt: '2026-09-12T20:52:00Z' }, NOW, 45);
  assert.equal(f.ok, true);
  assert.equal(Math.round(f.age), 8);
});
t('freshness fails once the data is past the limit', () => {
  assert.equal(freshness({ updatedAt: '2026-09-12T20:00:00Z' }, NOW, 45).ok, false);
});
t('freshness fails loudly on a missing or garbage timestamp', () => {
  assert.equal(freshness({}, NOW, 45).ok, false);
  assert.equal(freshness({ updatedAt: 'never' }, NOW, 45).ok, false);
});
t('a run queued longer than the limit is called stuck', () => {
  const runs = [
    { id: 1, status: 'queued',      created_at: '2026-09-12T20:25:00Z', run_number: 343, name: 'Fast alert poll' },
    { id: 2, status: 'queued',      created_at: '2026-09-12T20:55:00Z', run_number: 344, name: 'Fast alert poll' },
    { id: 3, status: 'in_progress', created_at: '2026-09-12T19:00:00Z', run_number: 345, name: 'Poll tee times' },
    { id: 4, status: 'completed',   created_at: '2026-09-12T18:00:00Z', run_number: 346, name: 'Poll tee times' },
  ];
  const stuck = stuckRuns(runs, NOW, 20);
  assert.equal(stuck.length, 1, 'only the long-queued run');
  assert.equal(stuck[0].id, 1);
  assert.equal(Math.round(stuck[0].waited), 35);
});
t('a long-running job is never mistaken for a stuck one', () => {
  // in_progress means a runner picked it up. Slow is not the same as wedged.
  const runs = [{ id: 9, status: 'in_progress', created_at: '2026-09-12T19:00:00Z', run_number: 1, name: 'Poll tee times' }];
  assert.equal(stuckRuns(runs, NOW, 20).length, 0);
});
t('ageMinutes returns null rather than NaN on junk', () => {
  assert.equal(ageMinutes('not-a-date', NOW), null);
});

globalThis.fetch = realFetch;

console.log(`\n${passed} checks passed.`);
