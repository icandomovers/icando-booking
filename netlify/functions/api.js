// Icando Operations API — Netlify Function (Phase 1)
// Single-file router, manager-key secured. Bundled with esbuild (pg included) at deploy time.
// Env: DATABASE_URL (Neon), MANAGER_KEY (existing)
//
// Routes (all under /.netlify/functions/api):
//   GET    /api/health
//   GET    /api/jobs?from=YYYY-MM-DD&to=YYYY-MM-DD&status=
//   POST   /api/jobs            {client_name, date, start_time, ...}
//   PATCH  /api/jobs/:id        {status, manual_status, payment_status, ...}
//   GET    /api/clients?q=
//   POST   /api/clients
//   GET    /api/quotes?status=
//   POST   /api/quotes
//   PATCH  /api/quotes/:id
//   GET    /api/jobs/:id/notes
//   POST   /api/jobs/:id/notes  {text}
//   GET    /api/crew
// Auth: header x-manager-key must equal MANAGER_KEY.

const { Pool } = require('pg');
const crypto = require('crypto');

// Password hashing with scrypt (built-in, secure)
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return salt + ':' + hash;
}
function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const verify = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(verify, 'hex'));
}
const webpush = require('web-push');

// Embedded ledger data (served via authenticated /api/ledger)
const LEDGER_DATA = {bookings:[],jobs:[]};
// Embedded quotes data (served via authenticated /api/ledger-quotes)
const QUOTES_DATA = {quotes:[]};


// VAPID public key (public by design; private key lives in the kv table).
const VAPID_PUBLIC = 'BDrIexmy9hICnNn_URMoYAjJrkSGWNpTeiF00fdRGHrov_JA5fz-s__Kj2ZXWLVwdIQSNu2ptz2dbHSwgZQkhF8';
const VAPID_SUBJECT = 'mailto:info@icandomovers.ca';

let pool;
function db() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 2,
    });
  }
  return pool;
}

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

// Push-notification queue helper (best-effort: never breaks the caller).
async function getNotifPrefs(p, ownerType, ownerId, eventType) {
  try {
    const r = await p.query(
      `SELECT channel_push, channel_email, channel_sms FROM notification_prefs
       WHERE owner_type=$1 AND owner_id=$2 AND event_type=$3`,
      [ownerType, ownerId, eventType]);
    if (r.rows.length) {
      return { push: r.rows[0].channel_push, email: r.rows[0].channel_email, sms: r.rows[0].channel_sms };
    }
  } catch (e) {}
  // Defaults: push on, email/sms off.
  return { push: true, email: false, sms: false };
}
async function queueNotif(p, type, title, body, opts) {
  opts = opts || {};
  try {
    await p.query(`INSERT INTO notification_queue (type, title, body) VALUES ($1,$2,$3)`,
      [type, title, body || null]);
    // Trigger instant push: drain the queue right away (fire-and-forget).
    // The 15-min cron remains as a backup for any missed items.
    drainNotifications(p).catch(() => {});
    // TODO: Check owner preferences and send via email/SMS when enabled.
    // Email via Gmail API, SMS via Twilio (pending Ifeanyi's integration).
  } catch (e) { /* notifications must never break the main flow */ }
}
function fmtTimeWpg(iso) {
  try {
    return new Date(iso).toLocaleString('en-CA', { timeZone: 'America/Winnipeg',
      hour: 'numeric', minute: '2-digit' });
  } catch (e) { return ''; }
}

// Drain the notification queue: group queued events by type, send one push
// per type to each subscribed phone (filtered by that phone's prefs).
async function drainNotifications(p) {
  const items = (await p.query(
    `SELECT * FROM notification_queue WHERE sent_at IS NULL ORDER BY id LIMIT 100`)).rows;
  if (!items.length) return { sent: 0 };
  const subs = (await p.query(`SELECT * FROM push_subscriptions`)).rows;
  const ids = items.map(i => i.id);
  const markSent = () => p.query(`UPDATE notification_queue SET sent_at=now() WHERE id = ANY($1)`, [ids]);
  if (!subs.length) { await markSent(); return { sent: 0, dropped: items.length }; }
  const kvRow = (await p.query(`SELECT value FROM kv WHERE key='vapid_private'`)).rows[0];
  if (!kvRow) return { error: 'vapid_private not configured' };
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, kvRow.value);
  const byType = {};
  items.forEach(i => { (byType[i.type] = byType[i.type] || []).push(i); });
  const TITLES = { clock_in: '🟢 Clock-in', clock_out: '🔴 Clock-out', new_lead: '🎯 New lead',
                   job_done: '✅ Job completed', quote_quiet: '⏰ Follow-up due',
                   crew_response: '👷 Crew response', crew_update: '👤 Crew update',
                   job_ended: '🏁 Job ended', job_changed: '📝 Job updated',
                   job_assigned: '📋 New assignment', pay_summary: '💰 Pay summary',
                   clock_reminder: '⏰ Clock reminder', job_started: '▶️ Job started',
                   job_start_reminder: '▶️ Job starting soon' };
  let sent = 0, droppedTypes = [];
  for (const [type, list] of Object.entries(byType)) {
    // Group by target: crew-specific vs manager (null crew_id).
    const byCrew = {};
    list.forEach(i => {
      const key = i.crew_id ? 'crew:' + i.crew_id : 'manager';
      (byCrew[key] = byCrew[key] || []).push(i);
    });
    for (const [target, items] of Object.entries(byCrew)) {
      const crewId = target.startsWith('crew:') ? parseInt(target.slice(5), 10) : null;
      const liveSubs = subs.filter(s =>
        (s.prefs || {})[type] !== false &&
        (crewId ? s.crew_id === crewId : !s.crew_id)
      );
      if (!liveSubs.length) { droppedTypes.push(type + ':' + target); continue; }
      const rawBody = items.map(i => i.body || i.title).filter(Boolean).join('\n');
      // Extract job_id from [job#ID] markers for deep-linking
      const jobMatch = rawBody.match(/\[job#(\d+)\]/);
      const jobId = jobMatch ? jobMatch[1] : null;
      const body = rawBody.replace(/\s*\[job#\d+\]/g, '');
      let targetUrl = crewId ? 'https://booking.icandomovers.ca/staff.html' : 'https://booking.icandomovers.ca/manager.html';
      if (crewId) {
        if (jobId) targetUrl += '#job-' + jobId;
      } else {
        // Manager taps land on the Alerts tab; job id appended so the tab can highlight it.
        targetUrl += jobId ? '#alerts-job-' + jobId : '#alerts';
      }
      // Use the queued title (e.g. "Noble accepted Test booking") if it's more specific than the generic type label.
      const firstTitle = (items[0] && items[0].title) || '';
      const title = firstTitle || TITLES[type] || 'Icando Movers';
      const payload = JSON.stringify({ title, body, tag: 'icando-' + type, url: targetUrl });
      for (const s of liveSubs) {
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
          sent++;
        } catch (e) {
          if (e.statusCode === 410 || e.statusCode === 404)
            await p.query(`DELETE FROM push_subscriptions WHERE id=$1`, [s.id]).catch(() => {});
        }
      }
    }
  }
  await markSent();
  return { sent, types: Object.keys(byType), droppedTypes };
}

// Auto-billing: 2 movers $480/3h then $120/hr; 3+ movers $665/3h then $170/hr.
// Partial hour: >=15 min → full hourly rate; <15 min → half hourly rate.
function calculateBill(hours, movers) {
  const r = (movers >= 3) ? { min: 665, hourly: 170 } : { min: 480, hourly: 120 };
  if (hours <= 3) return r.min;
  const extra = hours - 3;
  const full = Math.floor(extra);
  const rem = extra - full;
  let bill = r.min + full * r.hourly;
  if (rem >= 0.25) bill += r.hourly;
  else if (rem > 0.001) bill += r.hourly / 2;
  return Math.round(bill * 100) / 100;
}
// ---- Crew app API (staff) ----
// Auth: x-crew-token header = crew.login_token (personal link), or the token
// in the body. PIN login via POST /crew-auth {crew_id, pin}.
// Every /crew/* route is crew-scoped: a member only sees their own jobs,
// pay, and profile. The manager key is never involved.
async function crewMember(p, headers, body) {
  const token = headers['x-crew-token'] || headers['X-Crew-Token'] || body.crew_token;
  if (!token) return null;
  const r = await p.query(
    `SELECT id, name, phone, email, address, pay_rate, active FROM crew
     WHERE login_token=$1 AND (active IS NULL OR active = true)`, [String(token)]);
  return r.rows[0] || null;
}
function crewOnJob(p, jobId, crewName) {
  return p.query(
    `SELECT id, client_name, date, start_time, end_time, pickup, dropoff,
            yard_meet, schedule_note, status, price, payment_status,
            ended_at, ended_by, billable_hours, started_at, started_by,
            movers_count, crew
     FROM jobs WHERE id=$1 AND EXISTS
       (SELECT 1 FROM jsonb_array_elements(crew) c WHERE lower(CASE WHEN jsonb_typeof(c)='string' THEN c#>>'{}' ELSE c->>'name' END) = lower($2))`,
    [jobId, crewName]).then(r => r.rows[0] || null);
}
async function crewClock(p, me, body) {
  const { action, job_id, lat, lng, acc } = body;
  if (action !== 'in' && action !== 'out') return json(400, { error: 'action must be in|out' });
  const jid = job_id ? parseInt(job_id, 10) : null;
  let job = null;
  if (jid) {
    job = await crewOnJob(p, jid, me.name);
    if (!job) return json(403, { error: 'not on this job' });
  }
  const when = new Date();
  const glat = lat != null ? Number(lat) : null;
  const glng = lng != null ? Number(lng) : null;
  const gacc = acc != null ? Number(acc) : null;
  if (action === 'in') {
    const open = (await p.query(
      `SELECT id FROM clock_ins WHERE crew_id=$1 AND clock_out IS NULL ORDER BY id DESC LIMIT 1`,
      [me.id])).rows[0];
    if (open) return json(200, { id: open.id, reused: true });
    const r = await p.query(
      `INSERT INTO clock_ins (job_id, crew_id, crew_name, clock_in, source, in_lat, in_lng, in_acc)
       VALUES ($1,$2,$3,$4,'staff_app',$5,$6,$7) RETURNING id`,
      [jid, me.id, me.name, when.toISOString(), glat, glng, gacc]);
    await queueNotif(p, 'clock_in', me.name + ' clocked in',
      fmtTimeWpg(when.toISOString()) + ' 📲' + (job && job.client_name ? ' · ' + job.client_name : ''));
    return json(200, { id: r.rows[0].id });
  }
  const open = (await p.query(
    `SELECT id FROM clock_ins WHERE crew_id=$1 AND clock_out IS NULL ORDER BY id DESC LIMIT 1`,
    [me.id])).rows[0];
  if (!open) return json(400, { error: 'no open clock-in' });
  await p.query(`UPDATE clock_ins SET clock_out=$1, out_lat=$2, out_lng=$3, out_acc=$4 WHERE id=$5`,
    [when.toISOString(), glat, glng, gacc, open.id]);
  const done = (await p.query(`SELECT hours FROM clock_ins WHERE id=$1`, [open.id])).rows[0];
  const hrs = done && done.hours != null ? Number(done.hours) : null;
  await queueNotif(p, 'clock_out', me.name + ' clocked out',
    fmtTimeWpg(when.toISOString()) + (hrs != null ? ' · ' + hrs.toFixed(2) + 'h' : ''));
  return json(200, { id: open.id, hours: hrs });
}
async function crewRoutes(p, path, method, body, headers, q) {
  // Login: personal link token, crew_id + PIN, or username + password.
  if (path === '/crew-auth' && method === 'POST') {
    let crew = null;
    if (body.token) {
      crew = (await p.query(
        `SELECT id, name, phone, email, address, login_token, active FROM crew
         WHERE login_token=$1 AND (active IS NULL OR active = true)`, [String(body.token)])).rows[0];
    } else if (body.crew_id && body.pin) {
      crew = (await p.query(
        `SELECT id, name, phone, email, address, login_token, active FROM crew
         WHERE id=$1 AND pin=$2 AND (active IS NULL OR active = true)`,
        [parseInt(body.crew_id, 10), String(body.pin)])).rows[0];
    } else if (body.username && body.password) {
      const row = (await p.query(
        `SELECT id, name, phone, email, address, login_token, password_hash, active FROM crew
         WHERE lower(username)=lower($1) AND (active IS NULL OR active = true)`,
        [String(body.username).trim()])).rows[0];
      if (row && verifyPassword(String(body.password), row.password_hash)) crew = row;
    }
    if (!crew) return json(401, { error: 'invalid login' });
    // Track last login for manager visibility.
    try { await p.query(`UPDATE crew SET last_login=now() WHERE id=$1`, [crew.id]); } catch (e) {}
    return json(200, { crew: { id: crew.id, name: crew.name, phone: crew.phone,
      email: crew.email, address: crew.address }, token: crew.login_token });
  }
  const me = await crewMember(p, headers, body);
  if (!me) return json(401, { error: 'crew login required' });

  // Heartbeat: crew app pings every 2 min while open — tracks live presence.
  if (path === '/crew/me/ping' && method === 'POST') {
    try { await p.query(`UPDATE crew SET last_seen=now() WHERE id=$1`, [me.id]); } catch (e) {}
    return json(200, { ok: true });
  }

  // Crew notification channel prefs — read own prefs.
  if (path === '/crew/me/notification-prefs' && method === 'GET') {
    const r = await p.query(
      `SELECT event_type, channel_push, channel_email, channel_sms
       FROM notification_prefs WHERE owner_type='crew' AND owner_id=$1`,
      [String(me.id)]);
    const prefs = {};
    r.rows.forEach(row => {
      prefs[row.event_type] = {
        push: row.channel_push, email: row.channel_email, sms: row.channel_sms
      };
    });
    return json(200, prefs);
  }
  // Crew notification channel prefs — update own prefs.
  if (path === '/crew/me/notification-prefs' && method === 'PUT') {
    const eventType = body.event_type;
    if (!eventType) return json(400, { error: 'event_type required' });
    // Crew cannot disable all channels for critical events.
    const critical = ['job_assigned', 'job_changed'];
    if (critical.includes(eventType) &&
        !body.channel_push && !body.channel_email && !body.channel_sms) {
      return json(400, { error: 'At least one channel must stay on for job alerts' });
    }
    await p.query(
      `INSERT INTO notification_prefs (owner_type, owner_id, event_type, channel_push, channel_email, channel_sms)
       VALUES ('crew', $1, $2, $3, $4, $5)
       ON CONFLICT (owner_type, owner_id, event_type)
       DO UPDATE SET channel_push=EXCLUDED.channel_push, channel_email=EXCLUDED.channel_email,
                     channel_sms=EXCLUDED.channel_sms, updated_at=now()`,
      [String(me.id), eventType,
       !!body.channel_push, !!body.channel_email, !!body.channel_sms]);
    return json(200, { ok: true });
  }

  // Change password (crew-authenticated)
  if (path === '/crew/me/password' && method === 'POST') {
    const cp = body && body.current_password, np = body && body.new_password;
    if (!np || String(np).length < 4)
      return json(400, { error: 'New password must be at least 4 characters' });
    const row = (await p.query(`SELECT password_hash FROM crew WHERE id=$1`, [me.id])).rows[0];
    if (row && row.password_hash) {
      if (!cp || !verifyPassword(String(cp), row.password_hash))
        return json(401, { error: 'Current password is incorrect' });
    }
    await p.query(`UPDATE crew SET password_hash=$1 WHERE id=$2`, [hashPassword(String(np)), me.id]);
    return json(200, { ok: true });
  }

  if (path === '/crew/me' && method === 'GET')
    return json(200, { id: me.id, name: me.name, phone: me.phone, email: me.email,
      address: me.address, pay_rate: me.pay_rate });

  if (path === '/crew/me' && method === 'PATCH') {
    const allowed = ['phone', 'email', 'address'];
    const cols = allowed.filter(k => body[k] !== undefined);
    if (!cols.length) return json(400, { error: 'nothing to update' });
    await p.query(`UPDATE crew SET ${cols.map((k, i) => `${k}=$${i + 1}`).join(',')} WHERE id=$${cols.length + 1}`,
      [...cols.map(k => body[k]), me.id]);
    await queueNotif(p, 'crew_update', me.name + ' updated their info',
      cols.map(k => k + ': ' + body[k]).join(', '));
    return json(200, { ok: true });
  }

  // My jobs: upcoming + recent, with my accept/reject state.
  if (path === '/crew/me/jobs' && method === 'GET') {
    const r = await p.query(
      `SELECT j.id, j.client_name, j.date, j.start_time, j.end_time, j.pickup, j.dropoff,
              j.yard_meet, j.schedule_note, j.status,
              j.ended_at, j.ended_by, j.billable_hours, j.started_at, j.started_by,
              j.job_type, j.truck, j.equipment, j.access_notes, j.client_phone,
              j.estimated_hours, j.special_instructions, j.movers_count,
              (SELECT json_agg(json_build_object('name', c2->>'name'))
               FROM jsonb_array_elements(j.crew) c2) AS crew_list
       FROM jobs j
       WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(j.crew) c WHERE lower(CASE WHEN jsonb_typeof(c)='string' THEN c#>>'{}' ELSE c->>'name' END) = lower($1))
         AND j.date >= CURRENT_DATE - INTERVAL '14 days'
       ORDER BY j.date LIMIT 60`, [me.name]);
    const ids = r.rows.map(x => x.id);
    let resp = {};
    if (ids.length) {
      const rr = await p.query(`SELECT job_id, response, reason FROM job_responses
                                WHERE crew_id=$1 AND job_id = ANY($2)`, [me.id, ids]);
      rr.rows.forEach(x => { resp[x.job_id] = { response: x.response, reason: x.reason }; });
    }
    return json(200, r.rows.map(j => Object.assign({}, j, { my_response: resp[j.id] || null })));
  }

  // Accept / reject a job.
  let m = path.match(/^\/crew\/me\/jobs\/(\d+)\/respond$/);
  if (m && method === 'POST') {
    const jid = parseInt(m[1], 10);
    const job = await crewOnJob(p, jid, me.name);
    if (!job) return json(403, { error: 'not on this job' });
    if (body.response !== 'accept' && body.response !== 'reject')
      return json(400, { error: "response must be 'accept' or 'reject'" });
    await p.query(
      `INSERT INTO job_responses (job_id, crew_id, response, reason)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (job_id, crew_id) DO UPDATE
         SET response=EXCLUDED.response, reason=EXCLUDED.reason, created_at=now()`,
      [jid, me.id, body.response, body.reason || null]);
    await queueNotif(p, 'crew_response',
      `${me.name} ${body.response === 'accept' ? 'accepted' : 'rejected'} ${job.client_name || 'a job'}`,
      `${job.date ? String(job.date).slice(0, 10) : ''}${body.reason ? ' · ' + body.reason : ''} [job#${jid}]`.trim());
    return json(200, { ok: true });
  }

  // Request reschedule or release a job (with reason). Queues a notification for the manager.
  m = path.match(/^\/crew\/me\/jobs\/(\d+)\/request-change$/);
  if (m && method === 'POST') {
    const jid = parseInt(m[1], 10);
    const job = await crewOnJob(p, jid, me.name);
    if (!job) return json(403, { error: 'not on this job' });
    const kind = body.kind;
    if (kind !== 'reschedule' && kind !== 'release')
      return json(400, { error: "kind must be 'reschedule' or 'release'" });
    const reason = String(body.reason || '').trim();
    if (!reason) return json(400, { error: 'reason is required' });
    // Release requests are blocked within 24 hours of the job start — crew must call the manager.
    if (kind === 'release' && job.start_time) {
      const startMs = new Date(job.start_time).getTime();
      const hoursUntil = (startMs - Date.now()) / (1000 * 60 * 60);
      if (hoursUntil < 24) {
        return json(400, { error: 'Cannot release within 24 hours of the job — please call Ifeanyi directly.' });
      }
    }
    const jobDate = job.date ? String(job.date).slice(0, 10) : '';
    const label = kind === 'reschedule' ? '🔄 reschedule request' : '🚪 release request';
    await queueNotif(p, 'crew_change_request',
      `${label}: ${me.name} — ${job.client_name || 'job'}`,
      `${jobDate}${kind === 'reschedule' && body.new_date ? ' → wants ' + String(body.new_date).slice(0, 10) : ''} · ${reason} [job#${jid}]`);
    return json(200, { ok: true });
  }

  // Start job: marks when work actually begins (distinct from clock-in).
  m = path.match(/^\/crew\/me\/jobs\/(\d+)\/start$/);
  if (m && method === 'POST') {
    const jid = parseInt(m[1], 10);
    const job = await crewOnJob(p, jid, me.name);
    if (!job) return json(403, { error: 'not on this job' });
    if (job.started_at) return json(200, { ok: true, already: true });
    const now = new Date();
    await p.query(`UPDATE jobs SET started_at=$1, started_by=$2, updated_at=now() WHERE id=$3`,
      [now.toISOString(), me.name, jid]);
    await queueNotif(p, 'job_started', `▶️ ${me.name} started ${job.client_name || 'job'}`,
      fmtTimeWpg(now.toISOString()) + ' 📍' + ` [job#${jid}]`);
    return json(200, { ok: true, started_at: now.toISOString() });
  }

  // End job: stops billable hours, auto-calculates the bill, alerts the manager.
  m = path.match(/^\/crew\/me\/jobs\/(\d+)\/end$/);
  if (m && method === 'POST') {
    const jid = parseInt(m[1], 10);
    const job = await crewOnJob(p, jid, me.name);
    if (!job) return json(403, { error: 'not on this job' });
    if (job.ended_at) return json(200, { ok: true, already: true, billable_hours: job.billable_hours });
    // Billable time = job start (tap) → job end (tap). Falls back to first clock-in.
    let startRef = job.started_at ? new Date(job.started_at) : null;
    if (!startRef) {
      const first = (await p.query(`SELECT MIN(clock_in) AS m FROM clock_ins WHERE job_id=$1`, [jid])).rows[0];
      startRef = first && first.m ? new Date(first.m) : (job.start_time ? new Date(job.start_time) : null);
    }
    const now = new Date();
    const billable = startRef ? Math.max(0, (now - startRef) / 36e5) : null;
    const billableRounded = billable != null ? Math.round(billable * 100) / 100 : null;
    // Auto-bill: movers_count decides the rate tier.
    const movers = job.movers_count || (job.crew ? job.crew.length : 2) || 2;
    const autoBill = billable != null ? calculateBill(billable, movers) : null;
    const glat = body.lat != null ? Number(body.lat) : null;
    const glng = body.lng != null ? Number(body.lng) : null;
    await p.query(`UPDATE jobs SET ended_at=$1, ended_by=$2, billable_hours=$3, price=$4, updated_at=now() WHERE id=$5`,
      [now.toISOString(), me.name, billableRounded, autoBill, jid]);
    await queueNotif(p, 'job_done', `🏁 ${me.name} ended ${job.client_name || 'job'}`,
      (billableRounded != null ? billableRounded.toFixed(2) + 'h' : 'job ended') +
      (autoBill != null ? ` → $${autoBill.toFixed(2)} auto-billed` : '') +
      (glat != null ? ' 📍' : '') + ` [job#${jid}]`);
    return json(200, { ok: true, billable_hours: billableRounded, amount: autoBill });
  }

  // Clock in / out with GPS.
  if (path === '/crew/me/clock' && method === 'POST')
    return await crewClock(p, me, body);

  // Crew can correct their own clock in/out times (for missed punches).
  m = path.match(/^\/crew\/me\/clock\/(\d+)$/);
  if (m && method === 'PATCH') {
    const id = m[1];
    const allowed = ['clock_in', 'clock_out'];
    const cols = allowed.filter(k => body[k] !== undefined);
    if (!cols.length) return json(400, { error: 'nothing to update' });
    const check = await p.query('SELECT id FROM clock_ins WHERE id=$1 AND crew_id=$2', [id, me.id]);
    if (!check.rows[0]) return json(404, { error: 'not found' });
    const r = await p.query(
      `UPDATE clock_ins SET ${cols.map((k,i)=>`${k}=$${i+1}`).join(',')} WHERE id=$${cols.length+1} RETURNING *`,
      [...cols.map(k => body[k]), id]
    );
    return json(200, r.rows[0]);
  }

  // My pay: daily rows + totals for a bi-weekly period (Mon–Sun x2).
  if (path === '/crew/me/pay' && method === 'GET') {
    const anchor = new Date(2026, 8, 21);
    let ref = q.period ? new Date(q.period + 'T12:00:00') : new Date();
    if (isNaN(ref.getTime())) ref = new Date();
    const idx = Math.floor(Math.floor((ref - anchor) / 864e5) / 14);
    const s = new Date(anchor); s.setDate(s.getDate() + idx * 14);
    const e = new Date(s); e.setDate(e.getDate() + 14);
    const rows = (await p.query(
      `SELECT id, clock_in, clock_out, hours, source FROM clock_ins
       WHERE crew_id=$1 AND clock_in >= $2 AND clock_in < $3 ORDER BY clock_in`,
      [me.id, s.toISOString(), e.toISOString()])).rows;
    const total = rows.reduce((a, x) => a + (Number(x.hours) || 0), 0);
    const rate = me.pay_rate != null ? Number(me.pay_rate) : null;
    return json(200, {
      period_start: s.toISOString().slice(0, 10), period_end: new Date(e - 864e5).toISOString().slice(0, 10),
      rows, total_hours: Math.round(total * 100) / 100,
      pay_rate: rate, estimated_pay: rate != null ? Math.round(total * rate * 100) / 100 : null,
    });
  }

  // Collect payment on site: generate the Helcim link for the manager-set amount.
  if (path === '/crew/me/collect' && method === 'POST') {
    // Crew payment collection is disabled until the manager enables it
    // after the first successful payment. See system review 2026-10-02.
    return json(403, { error: 'payment collection is not enabled for crew yet' });
    const jid = parseInt(body.job_id, 10);
    if (!jid) return json(400, { error: 'job_id required' });
    const job = await crewOnJob(p, jid, me.name);
    if (!job) return json(403, { error: 'not on this job' });
    if (!job.price || Number(job.price) <= 0)
      return json(400, { error: 'no amount yet — end the job first to auto-calculate the bill' });
    if (job.payment_status === 'paid') return json(400, { error: 'already paid' });
    // Create the invoice through the helcim-pay function (server to server).
    const base = (process.env.URL || 'https://booking.icandomovers.ca').replace(/\/$/, '');
    let inv;
    try {
      const hr = await fetch(base + '/.netlify/functions/helcim-pay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-manager-key': process.env.MANAGER_KEY || '' },
        body: JSON.stringify({ job_id: jid, amount: Number(job.price),
          client_name: job.client_name, description: `Move on ${String(job.date).slice(0, 10)}` }),
      });
      inv = await hr.json();
      if (!hr.ok || !inv.payment_url) throw new Error(inv.error || 'helcim failed');
    } catch (e) {
      return json(502, { error: 'payment service unavailable — tell your manager' });
    }
    await p.query(
      `INSERT INTO payment_attempts (job_id, crew_id, amount, helcim_invoice_id, payment_url, status)
       VALUES ($1,$2,$3,$4,$5,'link_sent')`,
      [jid, me.id, Number(job.price), inv.invoice_id || null, inv.payment_url]);
    await queueNotif(p, 'job_done', `💳 Payment link sent for ${job.client_name || 'job'}`,
      `$${Number(job.price).toFixed(2)} · initiated by ${me.name} on site`);
    return json(200, { ok: true, payment_url: inv.payment_url, amount: Number(job.price) });
  }

  // Crew push subscription (their own phone).
  if (path === '/crew/me/push-subscriptions' && method === 'POST') {
    const { endpoint, p256dh, auth, prefs } = body;
    if (!endpoint || !p256dh || !auth) return json(400, { error: 'endpoint, p256dh, auth required' });
    await p.query(
      `INSERT INTO push_subscriptions (endpoint, p256dh, auth, prefs, crew_id)
       VALUES ($1,$2,$3,COALESCE($4::jsonb, '{"job_assigned":true,"job_changed":true,"pay_summary":true,"clock_reminder":true,"job_start_reminder":true}'::jsonb),$5)
       ON CONFLICT (endpoint) DO UPDATE SET p256dh=EXCLUDED.p256dh, auth=EXCLUDED.auth,
         crew_id=EXCLUDED.crew_id,
         prefs=COALESCE(EXCLUDED.prefs, push_subscriptions.prefs)`,
      [endpoint, p256dh, auth, prefs ? JSON.stringify(prefs) : null, me.id]);
    return json(200, { ok: true });
  }

  return json(404, { error: 'not found' });
}

// Crew clock-in POST — intentionally open (crew phones carry no manager key).
// Constrained server-side: the job must exist, the name must match the job's
// crew, timestamps must be near the job date. Ifeanyi reviews hours in the
// payroll tab before paying, so bad data is visible, not silent.
async function clockInPost(p, body) {
  const { job_id, crew_name, action, ts, clock_in } = body;
  const jid = parseInt(job_id, 10);
  if (!jid || !crew_name || (action !== 'in' && action !== 'out'))
    return json(400, { error: 'job_id, crew_name and action (in|out) are required.' });
  const job = (await p.query('SELECT id, date, crew, client_name FROM jobs WHERE id=$1', [jid])).rows[0];
  if (!job) return json(404, { error: 'job not found.' });
  const crewNames = (job.crew || []).map(c => (c.name || c || '').toLowerCase());
  if (!crewNames.includes(String(crew_name).toLowerCase()))
    return json(403, { error: 'name does not match this job\u2019s crew.' });
  const when = ts ? new Date(ts) : new Date();
  if (isNaN(when.getTime())) return json(400, { error: 'bad timestamp.' });
  const jobDay = new Date(job.date);
  if (Math.abs(when - jobDay) > 7 * 864e5)
    return json(400, { error: 'timestamp is too far from the job date.' });
  const crewRow = (await p.query('SELECT id FROM crew WHERE lower(name)=lower($1) LIMIT 1', [crew_name])).rows[0];
  const crewId = crewRow ? crewRow.id : null;
  if (action === 'in') {
    const open = (await p.query(
      `SELECT * FROM clock_ins WHERE job_id=$1 AND lower(crew_name)=lower($2) AND clock_out IS NULL ORDER BY id DESC LIMIT 1`,
      [jid, crew_name])).rows[0];
    if (open) return json(200, { id: open.id, reused: true });
    const r = await p.query(
      `INSERT INTO clock_ins (job_id, crew_id, crew_name, clock_in) VALUES ($1,$2,$3,$4) RETURNING id`,
      [jid, crewId, crew_name, when.toISOString()]);
    await p.query(`INSERT INTO audit_log (actor, action, entity, entity_id, detail)
                   VALUES ('crew','clock_in','job',$1,$2::jsonb)`, [jid, JSON.stringify({ crew: crew_name })]);
    await queueNotif(p, 'clock_in', crew_name + ' clocked in',
      fmtTimeWpg(when.toISOString()) + ' 🔗' + (job.client_name ? ' · ' + job.client_name : ''));
    return json(200, { id: r.rows[0].id });
  }
  // action === 'out' (hours is a GENERATED column — read it back, never write it)
  const open = (await p.query(
    `SELECT * FROM clock_ins WHERE job_id=$1 AND lower(crew_name)=lower($2) AND clock_out IS NULL ORDER BY id DESC LIMIT 1`,
    [jid, crew_name])).rows[0];
  const closeSession = async (rowId) => {
    await p.query(`UPDATE clock_ins SET clock_out=$1 WHERE id=$2`, [when.toISOString(), rowId]);
    const done = (await p.query(`SELECT hours FROM clock_ins WHERE id=$1`, [rowId])).rows[0];
    return done ? Number(done.hours) : null;
  };
  if (open) {
    const hrs = await closeSession(open.id);
    await p.query(`INSERT INTO audit_log (actor, action, entity, entity_id, detail)
                   VALUES ('crew','clock_out','job',$1,$2::jsonb)`, [jid, JSON.stringify({ crew: crew_name, hours: hrs })]);
    await queueNotif(p, 'clock_out', crew_name + ' clocked out',
      fmtTimeWpg(when.toISOString()) + (hrs != null ? ' · ' + Number(hrs).toFixed(2) + 'h' : '') + (job.client_name ? ' · ' + job.client_name : ''));
    return json(200, { id: open.id, hours: hrs });
  }
  // No open session: accept an explicit clock-in time (the page asks for it).
  if (!clock_in) return json(400, { error: 'no open clock-in for this crew member.' });
  const cin = new Date(clock_in);
  if (isNaN(cin.getTime()) || cin > when) return json(400, { error: 'bad clock-in time.' });
  const r = await p.query(
    `INSERT INTO clock_ins (job_id, crew_id, crew_name, clock_in, clock_out)
     VALUES ($1,$2,$3,$4,$5) RETURNING id, hours`,
    [jid, crewId, crew_name, cin.toISOString(), when.toISOString()]);
  await p.query(`INSERT INTO audit_log (actor, action, entity, entity_id, detail)
                 VALUES ('crew','clock_out','job',$1,$2::jsonb)`, [jid, JSON.stringify({ crew: crew_name, hours: Number(r.rows[0].hours), manual_in: true })]);
  await queueNotif(p, 'clock_out', crew_name + ' clocked out',
    fmtTimeWpg(when.toISOString()) + ' · ' + Number(r.rows[0].hours).toFixed(2) + 'h' + (job.client_name ? ' · ' + job.client_name : ''));
  return json(200, { id: r.rows[0].id, hours: Number(r.rows[0].hours) });
}

exports.handler = async (event) => {
  const _path = (event.path || '').replace(/^\/\.netlify\/functions\/api/, '') || '/';
  const _method = event.httpMethod;
  let _body = {};
  try { _body = event.body ? JSON.parse(event.body) : {}; } catch (e) { /* ignore */ }
  // Open route: crew clock-ins (no manager key on crew phones).
  if (_path === '/clock-ins' && _method === 'POST') {
    try { return await clockInPost(db(), _body); }
    catch (e) { return json(500, { error: 'clock-in failed' }); }
  }
  // Crew app routes: authenticated by x-crew-token (personal login link / PIN).
  // Only /crew-auth and /crew/me/* — the manager's /crew/:id stays manager-key secured.
  if (_path === '/crew-auth' || _path.startsWith('/crew/me')) {
    try { return await crewRoutes(db(), _path, _method, _body, event.headers || {}, event.queryStringParameters || {}); }
    catch (e) { console.error('crew route error', e); return json(500, { error: 'server error' }); }
  }
  if (event.headers['x-manager-key'] !== process.env.MANAGER_KEY) {
    return json(401, { error: 'unauthorized' });
  }
  const path = (event.path || '').replace(/^\/\.netlify\/functions\/api/, '') || '/';
  const method = event.httpMethod;
  const q = event.queryStringParameters || {};
  let body = {};
  try { body = event.body ? JSON.parse(event.body) : {}; } catch (e) { /* ignore */ }

  try {
    const p = db();

    // ---- health ----
    if (path === '/health' && method === 'GET') {
      await p.query('SELECT 1');
      return json(200, { ok: true });
    }

    // ---- ledger endpoints removed (client data must stay in Postgres, never in code) ----

    // ---- jobs ----
    if (path === '/jobs' && method === 'GET') {
      const conds = [];
      const vals = [];
      if (q.from) { vals.push(q.from); conds.push(`date >= $${vals.length}`); }
      if (q.to) { vals.push(q.to); conds.push(`date <= $${vals.length}`); }
      if (q.status) { vals.push(q.status); conds.push(`status = $${vals.length}`); }
      const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
      const r = await p.query(`SELECT * FROM jobs ${where} ORDER BY date DESC, start_time DESC LIMIT 500`, vals);
      return json(200, r.rows);
    }
    let m = path.match(/^\/jobs\/(\d+)$/);
    if (m && method === 'GET') {
      const r = await p.query(`SELECT * FROM jobs WHERE id=$1`, [m[1]]);
      if (!r.rows[0]) return json(404, { error: 'not found' });
      return json(200, r.rows[0]);
    }
    if (path === '/jobs' && method === 'POST') {
      const f = ['client_id','client_name','date','start_time','end_time','crew','pickup','dropoff','yard_meet','status','price','source','connecteam_ref','quote_no'];
      const cols = f.filter(k => body[k] !== undefined);
      const r = await p.query(
        `INSERT INTO jobs (${cols.join(',')}) VALUES (${cols.map((_,i)=>`$${i+1}`).join(',')}) RETURNING *`,
        cols.map(k => body[k] === null ? null : (typeof body[k] === 'object' ? JSON.stringify(body[k]) : body[k]))
      );
      await p.query(`INSERT INTO audit_log (actor, action, entity, entity_id) VALUES ('manager','create','job',$1)`, [r.rows[0].id]);
      return json(201, r.rows[0]);
    }
    m = path.match(/^\/jobs\/(\d+)$/);
    if (m && method === 'PATCH') {
      const id = m[1];
      const allowed = ['client_name','date','start_time','end_time','started_at','ended_at','billable_hours','amount','crew','movers_count','actual_hours','pickup','dropoff','yard_meet','status','manual_status','price','payment_status','payment_link','payment_method','source','job_type','truck','equipment','access_notes','client_phone','estimated_hours','special_instructions'];
      const cols = allowed.filter(k => body[k] !== undefined);
      if (!cols.length) return json(400, { error: 'nothing to update' });
      // manual_status is never clobbered by sync: connecteam-sync omits it
      const r = await p.query(
        `UPDATE jobs SET ${cols.map((k,i)=>`${k}=$${i+1}`).join(',')}, updated_at=now() WHERE id=$${cols.length+1} RETURNING *`,
        [...cols.map(k => body[k] === null ? null : (typeof body[k] === 'object' ? JSON.stringify(body[k]) : body[k])), id]
      );
      await p.query(`INSERT INTO audit_log (actor, action, entity, entity_id, detail) VALUES ('manager','update','job',$1,$2)`, [id, JSON.stringify(cols)]);
      const updated = r.rows[0] || {};
      // Notify assigned crew of the change (time, addresses, crew, etc.).
      const changedFields = cols.filter(c => !['updated_at'].includes(c));
      if (updated.crew && changedFields.length) {
        const crewNames = (Array.isArray(updated.crew) ? updated.crew : []).map(c => c.name || c).filter(Boolean);
        if (crewNames.length) {
          const what = changedFields.map(c => {
            if (c === 'start_time' || c === 'end_time') return 'time';
            if (c === 'date') return 'date';
            if (c === 'pickup' || c === 'dropoff') return 'address';
            if (c === 'crew') return 'crew';
            return c;
          }).filter((v, i, a) => a.indexOf(v) === i).join(', ');
          await queueNotif(p, 'job_changed', `📝 ${updated.client_name || 'Job'} updated`,
            `${what} changed${updated.date ? ' · ' + String(updated.date).slice(0, 10) : ''} [job#${id}]`);
        }
      }
      return json(200, updated);
    }
    if (m && method === 'DELETE') {
      const id = m[1];
      // Delete related records first (foreign key constraints).
      await p.query('DELETE FROM job_responses WHERE job_id=$1', [id]);
      await p.query('DELETE FROM notes WHERE job_id=$1', [id]);
      await p.query('DELETE FROM clock_ins WHERE job_id=$1', [id]);
      await p.query('DELETE FROM payment_attempts WHERE job_id=$1', [id]).catch(()=>{});
      await p.query('DELETE FROM notification_queue WHERE body LIKE $1', [`%job#${id}%`]);
      await p.query(`INSERT INTO audit_log (actor, action, entity, entity_id) VALUES ('manager','delete','job',$1)`, [id]);
      await p.query('DELETE FROM jobs WHERE id=$1', [id]);
      return json(200, { ok: true, deleted: id });
    }

    // ---- sync-jobs: Connecteam sync upsert (manager-key secured).
    // Body: { jobs: [{sync_key, client_name, date, start_time, end_time, crew:[{name}],
    //          pickup, dropoff, schedule_note, status, connecteam_ref}], seen_keys: [...] }
    // Merge rules: never clobber manual_status or payment fields; status only
    // transitions booked->completed / booked->cancelled when untouched by hand.
    if (path === '/sync-jobs' && method === 'POST') {
      const list = body.jobs || [];
      const seen = new Set(body.seen_keys || []);
      let added = 0, updated = 0;
      for (const j of list) {
        if (!j.sync_key) continue;
        let row = (await p.query('SELECT * FROM jobs WHERE sync_key=$1', [j.sync_key])).rows[0];
        if (!row && j.client_name && j.date) {
          // Fallback: app-created booking for the same client+date gets linked.
          const fb = await p.query(
            `SELECT * FROM jobs WHERE sync_key IS NULL AND lower(client_name)=lower($1) AND date=$2::date ORDER BY id LIMIT 1`,
            [j.client_name, j.date]);
          if (fb.rows[0]) {
            row = fb.rows[0];
            await p.query('UPDATE jobs SET sync_key=$1, connecteam_ref=$2, source=$3, updated_at=now() WHERE id=$4',
              [j.sync_key, j.connecteam_ref || null, 'connecteam', row.id]);
            row = (await p.query('SELECT * FROM jobs WHERE id=$1', [row.id])).rows[0];
          }
        }
        const crewJson = JSON.stringify(j.crew || []);
        if (!row) {
          const ins = await p.query(
            `INSERT INTO jobs (client_name, date, start_time, end_time, crew, pickup, dropoff, schedule_note, status, source, sync_key, connecteam_ref)
             VALUES ($1,$2::date,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
            [j.client_name, j.date, j.start_time || null, j.end_time || null, crewJson,
             j.pickup || null, j.dropoff || null, j.schedule_note || null,
             j.status || 'booked', 'connecteam', j.sync_key, j.connecteam_ref || null]);
          const newId = ins.rows[0] ? ins.rows[0].id : null;
          added++;
          if (j.status === 'completed')
            await queueNotif(p, 'job_done', 'Job completed', (j.client_name || 'Job') + ' · ' + j.date + (newId ? ` [job#${newId}]` : ''));
        } else {
          const res = await p.query(
            `UPDATE jobs SET client_name=$1, date=$2::date, start_time=$3, end_time=$4, crew=$5,
                 pickup=$6, dropoff=$7, schedule_note=$8, connecteam_ref=$9, updated_at=now()
             WHERE id=$10`,
            [j.client_name, j.date, j.start_time || null, j.end_time || null, crewJson,
             j.pickup || null, j.dropoff || null, j.schedule_note || null, j.connecteam_ref || null, row.id]);
          if (res.rowCount) updated++;
          // Status transitions only when never touched by hand.
          const proposed = j.status;
          const cur = row.status;
          const manual = row.manual_status;
          if (!manual && cur === 'booked' && (proposed === 'completed' || proposed === 'cancelled')) {
            await p.query(`UPDATE jobs SET status=$1, updated_at=now() WHERE id=$2`, [proposed, row.id]);
            if (proposed === 'completed')
              await queueNotif(p, 'job_done', 'Job completed',
                (row.client_name || j.client_name || 'Job') + ' · ' + (row.date ? String(row.date).slice(0, 10) : j.date) + ` [job#${row.id}]`);
          }
        }
      }
      // Vanished shifts -> cancelled (future/present, untouched only).
      const van = await p.query(
        `UPDATE jobs SET status='cancelled', updated_at=now()
         WHERE source='connecteam' AND status='booked' AND manual_status IS NULL AND date >= CURRENT_DATE
           AND NOT (sync_key = ANY($1)) RETURNING id`,
        [Array.from(seen)]);
      return json(200, { added, updated, cancelled: van.rowCount });
    }

    // ---- clock-ins: read + corrections (manager-key secured) ----
    if (path === '/clock-ins/import' && method === 'POST') {
      // Connecteam timesheet import (called by connecteam-sync.py).
      // Idempotent on external_ref: re-imports update edited timesheets.
      const entries = body.entries || [];
      let added = 0, updated = 0;
      for (const e of entries) {
        if (!e.external_ref || !e.clock_in) continue;
        let crewId = null, crewName = e.crew_name || null;
        if (e.crew_connecteam_id != null) {
          const cr = (await p.query('SELECT id, name FROM crew WHERE connecteam_id=$1 LIMIT 1',
            [String(e.crew_connecteam_id)])).rows[0];
          if (cr) { crewId = cr.id; if (!crewName) crewName = cr.name; }
        }
        const prev = (await p.query(`SELECT clock_out FROM clock_ins WHERE external_ref=$1`, [e.external_ref])).rows[0];
        const r = await p.query(
          `INSERT INTO clock_ins (crew_id, crew_name, job_id, clock_in, clock_out, source, external_ref)
           VALUES ($1,$2,$3,$4::timestamptz,$5::timestamptz,'connecteam',$6)
           ON CONFLICT (external_ref) DO UPDATE
             SET clock_in=EXCLUDED.clock_in, clock_out=EXCLUDED.clock_out,
                 crew_name=COALESCE(EXCLUDED.crew_name, clock_ins.crew_name)
           RETURNING (xmax = 0) AS inserted`,
          [crewId, crewName, e.job_id || null, e.clock_in, e.clock_out || null, e.external_ref]);
        const label = (crewName || 'Crew') + ' · ' + fmtTimeWpg(e.clock_in) + ' 📱';
        if (r.rows[0] && r.rows[0].inserted) {
          added++;
          if (e.clock_out) await queueNotif(p, 'clock_out', (crewName || 'Crew') + ' clocked out', label);
          else await queueNotif(p, 'clock_in', (crewName || 'Crew') + ' clocked in', label);
        } else {
          updated++;
          // Only notify when a clock-out newly lands (not on every re-import).
          if (e.clock_out && prev && !prev.clock_out)
            await queueNotif(p, 'clock_out', (crewName || 'Crew') + ' clocked out', label);
        }
      }
      return json(200, { added, updated });
    }
    if (path === '/clock-ins' && method === 'GET') {
      const jid = parseInt(q.job_id, 10);
      const rows = jid
        ? (await p.query(`SELECT c.*, j.client_name, j.date FROM clock_ins c LEFT JOIN jobs j ON j.id=c.job_id WHERE c.job_id=$1 ORDER BY c.clock_in`, [jid])).rows
        : (await p.query(`SELECT c.*, j.client_name, j.date FROM clock_ins c LEFT JOIN jobs j ON j.id=c.job_id ORDER BY c.clock_in DESC LIMIT 200`)).rows;
      return json(200, rows);
    }
    m = path.match(/^\/clock-ins\/(\d+)$/);
    if (m && method === 'DELETE') {
      await p.query('DELETE FROM clock_ins WHERE id=$1', [m[1]]);
      await p.query(`INSERT INTO audit_log (actor, action, entity, entity_id, detail)
                     VALUES ('manager','clock_in_deleted','clock_in',$1,'{"note":"correction"}')`, [m[1]]);
      return json(200, { ok: true });
    }
    if (m && method === 'PATCH') {
      const id = m[1];
      const allowed = ['clock_in', 'clock_out'];
      const cols = allowed.filter(k => body[k] !== undefined);
      if (!cols.length) return json(400, { error: 'nothing to update' });
      const check = await p.query('SELECT id FROM clock_ins WHERE id=$1', [id]);
      if (!check.rows[0]) return json(404, { error: 'not found' });
      const r = await p.query(
        `UPDATE clock_ins SET ${cols.map((k,i)=>`${k}=$${i+1}`).join(',')} WHERE id=$${cols.length+1} RETURNING *`,
        [...cols.map(k => body[k]), id]
      );
      await p.query(`INSERT INTO audit_log (actor, action, entity, entity_id, detail)
                     VALUES ('manager','clock_in_corrected','clock_in',$1,$2)`,
        [id, JSON.stringify(cols)]);
      return json(200, r.rows[0]);
    }

    // ---- job notes ----
    m = path.match(/^\/jobs\/(\d+)\/notes$/);    if (m && method === 'GET') {
      const r = await p.query('SELECT * FROM notes WHERE job_id=$1 ORDER BY created_at', [m[1]]);
      return json(200, r.rows);
    }
    if (m && method === 'POST') {
      if (!body.text) return json(400, { error: 'text required' });
      const r = await p.query('INSERT INTO notes (job_id, text) VALUES ($1,$2) RETURNING *', [m[1], body.text]);
      return json(201, r.rows[0]);
    }
    m = path.match(/^\/jobs\/(\d+)\/responses$/);
    if (m && method === 'GET') {
      const r = await p.query(
        `SELECT jr.job_id, jr.response, jr.reason, jr.created_at, c.id AS crew_id, c.name AS crew_name
         FROM job_responses jr JOIN crew c ON c.id=jr.crew_id
         WHERE jr.job_id=$1 ORDER BY jr.created_at`, [m[1]]);
      return json(200, r.rows);
    }

    // ---- clients ----
    if (path === '/clients' && method === 'GET') {
      let r;
      if (q.q) {
        r = await p.query(`SELECT * FROM clients WHERE name ILIKE $1 OR phone ILIKE $1 OR email ILIKE $1 ORDER BY updated_at DESC LIMIT 50`, [`%${q.q}%`]);
      } else {
        r = await p.query('SELECT * FROM clients ORDER BY updated_at DESC LIMIT 100');
      }
      return json(200, r.rows);
    }
    if (path === '/clients' && method === 'POST') {
      const f = ['name','first_name','phone','email','addresses','source','notes'];
      const cols = f.filter(k => body[k] !== undefined);
      const r = await p.query(
        `INSERT INTO clients (${cols.join(',')}) VALUES (${cols.map((_,i)=>`$${i+1}`).join(',')}) RETURNING *`,
        cols.map(k => body[k] === null ? null : (typeof body[k] === 'object' ? JSON.stringify(body[k]) : body[k]))
      );
      return json(201, r.rows[0]);
    }

    // ---- quotes ----
    if (path === '/quotes' && method === 'GET') {
      const r = q.status
        ? await p.query('SELECT * FROM quotes WHERE status=$1 ORDER BY sent_date DESC', [q.status])
        : await p.query('SELECT * FROM quotes ORDER BY sent_date DESC LIMIT 200');
      return json(200, r.rows);
    }
    if (path === '/quotes' && method === 'POST') {
      const f = ['quote_no','client_id','client_name','email','phone','move_date','move_desc','amount','sent_date','status','followups','notes'];
      const cols = f.filter(k => body[k] !== undefined);
      const r = await p.query(
        `INSERT INTO quotes (${cols.join(',')}) VALUES (${cols.map((_,i)=>`$${i+1}`).join(',')})
         ON CONFLICT (quote_no) DO UPDATE SET ${cols.filter(c=>c!=='quote_no').map((k,i)=>`${k}=$${i+1}`).join(',')}
         RETURNING *`,
        cols.map(k => body[k] === null ? null : (typeof body[k] === 'object' ? JSON.stringify(body[k]) : body[k]))
      );
      return json(201, r.rows[0]);
    }
    m = path.match(/^\/quotes\/(\d+)$/);
    if (m && method === 'PATCH') {
      const allowed = ['status','followups','notes','amount','client_name','email','phone','move_date'];
      const cols = allowed.filter(k => body[k] !== undefined);
      const r = await p.query(
        `UPDATE quotes SET ${cols.map((k,i)=>`${k}=$${i+1}`).join(',')} WHERE id=$${cols.length+1} RETURNING *`,
        [...cols.map(k => body[k] === null ? null : (typeof body[k] === 'object' ? JSON.stringify(body[k]) : body[k])), m[1]]
      );
      return json(200, r.rows[0] || {});
    }

    // ---- crew ----
    if (path === '/crew' && method === 'GET') {
      try {
        const r = await p.query('SELECT id, name, connecteam_id, pay_rate, role, active, phone, email, address, notes, username, login_token, last_login, last_seen FROM crew ORDER BY name');
        return json(200, r.rows);
      } catch (e) {
        console.error('GET /crew failed:', e.message);
        return json(500, { error: 'server error', detail: e.message });
      }
    }
    if (path === '/crew' && method === 'POST') {
      if (!body.name) return json(400, { error: 'name required' });
      const r = await p.query(
        `INSERT INTO crew (name, phone, email, address, notes, role, connecteam_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (connecteam_id) DO UPDATE SET name=EXCLUDED.name
         RETURNING id, name, connecteam_id, pay_rate, role, active, phone, email, address, notes`,
        [body.name, body.phone || null, body.email || null, body.address || null, body.notes || null,
         body.role || 'mover', body.connecteam_id || null]);
      return json(200, r.rows[0]);
    }
    m = path.match(/^\/crew\/(\d+)$/);
    if (m && method === 'PATCH') {
      const allowed = ['pay_rate','name','role','active','phone','email','address','notes','login_token','pin','username'];
      const cols = allowed.filter(k => body[k] !== undefined);
      const vals = cols.map(k => body[k]);
      // Special: password (plaintext from manager) -> hashed before storing
      if (body.password !== undefined && String(body.password).length >= 4) {
        cols.push('password_hash'); vals.push(hashPassword(String(body.password)));
      }
      if (!cols.length) return json(400, { error: 'nothing to update' });
      const r = await p.query(
        `UPDATE crew SET ${cols.map((k,i)=>`${k}=$${i+1}`).join(',')} WHERE id=$${cols.length+1} RETURNING id, name, connecteam_id, pay_rate, role, active, phone, email, address, notes, username`,
        [...vals, m[1]]
      );
      return json(200, r.rows[0] || {});
    }
    if (m && method === 'DELETE') {
      try {
        await p.query('DELETE FROM crew WHERE id=$1', [m[1]]);
      } catch (e) {
        // Referenced by clock-ins: deactivate instead of hard delete.
        await p.query(`UPDATE crew SET active=false WHERE id=$1`, [m[1]]);
        return json(200, { ok: true, deactivated: true });
      }
      return json(200, { ok: true });
    }

    // ---- push subscriptions (manager's own phones; key-secured so strangers
    //      can't subscribe and siphon business notifications) ----
    if (path === '/push-subscriptions' && method === 'GET') {
      const r = await p.query(`SELECT id, endpoint, prefs, created_at FROM push_subscriptions ORDER BY id`);
      return json(200, r.rows.map(s => ({ id: s.id, endpoint: s.endpoint.slice(0, 60) + '…',
        prefs: s.prefs, created_at: s.created_at })));
    }
    if (path === '/push-subscriptions' && method === 'POST') {
      const { endpoint, p256dh, auth, prefs } = body;
      if (!endpoint || !p256dh || !auth) return json(400, { error: 'endpoint, p256dh, auth required' });
      const r = await p.query(
        `INSERT INTO push_subscriptions (endpoint, p256dh, auth, prefs)
         VALUES ($1,$2,$3,COALESCE($4::jsonb, '{"clock_in":true,"clock_out":true,"new_lead":true,"job_done":true,"quote_quiet":true}'::jsonb))
         ON CONFLICT (endpoint) DO UPDATE SET p256dh=EXCLUDED.p256dh, auth=EXCLUDED.auth,
           prefs=COALESCE(EXCLUDED.prefs, push_subscriptions.prefs)
         RETURNING id`,
        [endpoint, p256dh, auth, prefs ? JSON.stringify(prefs) : null]);
      return json(200, { ok: true, id: r.rows[0].id });
    }
    if (path === '/push-subscriptions' && method === 'PATCH') {
      const { endpoint, prefs } = body;
      if (!endpoint || !prefs) return json(400, { error: 'endpoint and prefs required' });
      await p.query(`UPDATE push_subscriptions SET prefs=$2 WHERE endpoint=$1`, [endpoint, JSON.stringify(prefs)]);
      return json(200, { ok: true });
    }
    if (path === '/push-subscriptions' && method === 'DELETE') {
      if (!body.endpoint) return json(400, { error: 'endpoint required' });
      await p.query(`DELETE FROM push_subscriptions WHERE endpoint=$1`, [body.endpoint]);
      return json(200, { ok: true });
    }

    // ---- notification queue ----
    if (path === '/notifications/queue' && method === 'POST') {
      if (!body.type || !body.title) return json(400, { error: 'type and title required' });
      await queueNotif(p, body.type, body.title, body.body);
      return json(200, { ok: true });
    }
    if (path === '/notifications/drain' && method === 'POST') {
      return json(200, await drainNotifications(p));
    }
    if (path === '/notifications/pending' && method === 'GET') {
      const r = await p.query(`SELECT count(*)::int AS n FROM notification_queue WHERE sent_at IS NULL`);
      return json(200, { pending: r.rows[0].n });
    }
    // Notifications panel: list all notifications (newest first).
    if (path === '/notifications' && method === 'GET') {
      const limit = Math.min(parseInt(q.limit || '100', 10), 500);
      const r = await p.query(
        `SELECT id, type, title, body, crew_id, created_at, sent_at FROM notification_queue
         ORDER BY id DESC LIMIT $1`, [limit]);
      return json(200, r.rows);
    }
    // Trash a notification from the panel.
    m = path.match(/^\/notifications\/(\d+)$/);
    if (m && method === 'DELETE') {
      await p.query(`DELETE FROM notification_queue WHERE id=$1`, [parseInt(m[1], 10)]);
      return json(200, { ok: true });
    }
    // Notification preferences: get all for an owner.
    if (path === '/notification-prefs' && method === 'GET') {
      const ownerType = q.owner_type || 'manager';
      const ownerId = q.owner_id || 'manager';
      const r = await p.query(
        `SELECT event_type, channel_push, channel_email, channel_sms
         FROM notification_prefs WHERE owner_type=$1 AND owner_id=$2`,
        [ownerType, ownerId]);
      const prefs = {};
      r.rows.forEach(row => {
        prefs[row.event_type] = {
          push: row.channel_push, email: row.channel_email, sms: row.channel_sms
        };
      });
      return json(200, prefs);
    }
    // Notification preferences: set (upsert) for an owner.
    if (path === '/notification-prefs' && method === 'PUT') {
      const ownerType = body.owner_type || 'manager';
      const ownerId = body.owner_id || 'manager';
      const eventType = body.event_type;
      if (!eventType) return json(400, { error: 'event_type required' });
      // Crew cannot disable all channels for critical events.
      const critical = ['job_assigned', 'job_changed'];
      if (ownerType === 'crew' && critical.includes(eventType) &&
          !body.channel_push && !body.channel_email && !body.channel_sms) {
        return json(400, { error: 'At least one channel required for job notifications' });
      }
      await p.query(
        `INSERT INTO notification_prefs (owner_type, owner_id, event_type, channel_push, channel_email, channel_sms, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,now())
         ON CONFLICT (owner_type, owner_id, event_type)
         DO UPDATE SET channel_push=$4, channel_email=$5, channel_sms=$6, updated_at=now()`,
        [ownerType, ownerId, eventType,
         !!body.channel_push, !!body.channel_email, !!body.channel_sms]);
      return json(200, { ok: true });
    }
    // Crew acceptance status for jobs (for the manager to verify).
    if (path === '/job-responses' && method === 'GET') {
      const r = await p.query(
        `SELECT jr.job_id, jr.crew_id, c.name AS crew_name, jr.response, jr.reason, jr.created_at,
                j.client_name, j.date
         FROM job_responses jr
         JOIN crew c ON c.id = jr.crew_id
         JOIN jobs j ON j.id = jr.job_id
         ORDER BY j.date, jr.job_id`);
      return json(200, r.rows);
    }

    // ---- tiny kv store (vapid keys, poller watermarks) ----
    if (path === '/kv' && method === 'POST') {
      if (!body.key || body.value === undefined) return json(400, { error: 'key and value required' });
      await p.query(`INSERT INTO kv (key, value) VALUES ($1,$2)
                     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [body.key, String(body.value)]);
      return json(200, { ok: true });
    }
    m = path.match(/^\/kv\/(.+)$/);
    if (m && method === 'GET') {
      const r = await p.query(`SELECT value FROM kv WHERE key=$1`, [decodeURIComponent(m[1])]);
      if (!r.rows[0]) return json(404, { error: 'not found' });
      return json(200, { key: m[1], value: r.rows[0].value });
    }

    // ---- notify-crew: queue a push for a specific crew member (manager-key secured, used by cron).
    if (path === '/notify-crew' && method === 'POST') {
      const { type, title, body, crew_name, job_id } = _body;
      if (!type || !title || !crew_name) return json(400, { error: 'type, title, crew_name required' });
      const crew = (await p.query(`SELECT id FROM crew WHERE lower(name)=lower($1)`, [crew_name])).rows[0];
      if (!crew) return json(404, { error: 'crew not found' });
      // Dedupe: don't queue the same type for the same job+crew within 2 hours.
      if (job_id) {
        const dup = (await p.query(
          `SELECT id FROM notification_queue WHERE type=$1 AND crew_id=$2 AND body LIKE $3
           AND created_at > now() - INTERVAL '2 hours' LIMIT 1`,
          [type, crew.id, `%job#${job_id}%`])).rows[0];
        if (dup) return json(200, { ok: true, deduped: true });
      }
      await p.query(
        `INSERT INTO notification_queue (type, title, body, crew_id) VALUES ($1,$2,$3,$4)`,
        [type, title, (body || '') + (job_id ? ` [job#${job_id}]` : ''), crew.id]);
      // Instant push for crew notifications: await the drain so the push is
      // sent before the function returns (serverless may freeze background work).
      try { await drainNotifications(p); } catch (e) { /* push must not break the API */ }
      return json(200, { ok: true });
    }

    return json(404, { error: 'not found' });
  } catch (e) {
    console.error('api error', e);
    return json(500, { error: 'server error', detail: e.message, stack: e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : 'none' });
  }
};
