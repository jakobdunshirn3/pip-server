// Pip Notification Server
// Deploy this on Render.com (free tier)
// Required env vars: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_EMAIL,
//                    SUPABASE_URL, SUPABASE_KEY,
//                    GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, APP_URL

const express = require('express');
const webpush = require('web-push');
const cron = require('node-cron');
const { createClient } = require('@supabase/supabase-js');
const { google } = require('googleapis');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors({ origin: '*' }));

// ── VAPID SETUP ───────────────────────────────────────────────────────────────
webpush.setVapidDetails(
  `mailto:${process.env.VAPID_EMAIL}`,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// ── SUPABASE ──────────────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// In-memory subscription store (backed by Supabase)
let subscriptions = [];

async function loadSubscriptions() {
  const { data } = await supabase.from('settings').select('*').eq('id', 'push_subscriptions');
  if (data && data[0]) subscriptions = data[0].data.subs || [];
}

async function saveSubscriptions() {
  await supabase.from('settings').upsert({ id: 'push_subscriptions', data: { id: 'push_subscriptions', subs: subscriptions } });
}

// ── ROUTES ────────────────────────────────────────────────────────────────────
app.get('/vapid-public-key', (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

app.post('/subscribe', async (req, res) => {
  const { subscription } = req.body;
  // Remove old subscriptions with same endpoint
  subscriptions = subscriptions.filter(s => s.endpoint !== subscription.endpoint);
  subscriptions.push({ ...subscription, createdAt: new Date().toISOString() });
  await saveSubscriptions();
  res.json({ ok: true });
});

app.post('/unsubscribe', async (req, res) => {
  const { endpoint } = req.body;
  subscriptions = subscriptions.filter(s => s.endpoint !== endpoint);
  await saveSubscriptions();
  res.json({ ok: true });
});

// Test notification endpoint
app.post('/test', async (req, res) => {
  await sendToAll({
    title: 'Pip 🐿️',
    body: "Hey! Pip here — notifications are working! 🌰",
    tag: 'pip-test'
  });
  res.json({ ok: true });
});

// ── GOOGLE CALENDAR OAUTH ─────────────────────────────────────────────────────
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  `${process.env.SERVER_URL || 'https://pip-notifications.onrender.com'}/gcal/callback`
);

const gcalTokens = {}; // In production this should be persisted

app.get('/gcal/auth', (req, res) => {
  const returnUrl = req.query.returnUrl || '/';
  const state = Buffer.from(JSON.stringify({ returnUrl })).toString('base64');
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/calendar.readonly'],
    state
  });
  res.redirect(authUrl);
});

app.get('/gcal/callback', async (req, res) => {
  const { code, state } = req.query;
  const { returnUrl } = JSON.parse(Buffer.from(state, 'base64').toString());
  const { tokens } = await oauth2Client.getToken(code);
  // Store token (keyed by a simple session id for demo)
  const tokenId = Math.random().toString(36).slice(2);
  gcalTokens[tokenId] = tokens;
  // Redirect back to app with token id
  const url = new URL(returnUrl);
  url.searchParams.set('gcal_token', tokenId);
  res.redirect(url.toString());
});

app.get('/gcal/events', async (req, res) => {
  const { token } = req.query;
  if (!token || !gcalTokens[token]) return res.json({ events: [] });
  oauth2Client.setCredentials(gcalTokens[token]);
  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
  const now = new Date();
  const weekFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const { data } = await calendar.events.list({
    calendarId: 'primary',
    timeMin: now.toISOString(),
    timeMax: weekFromNow.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 50
  });
  res.json({ events: data.items || [] });
});

// ── PUSH HELPER ───────────────────────────────────────────────────────────────
async function sendToAll(payload) {
  const results = await Promise.allSettled(
    subscriptions.map(sub =>
      webpush.sendNotification(sub, JSON.stringify(payload))
        .catch(err => {
          // Remove expired subscriptions
          if (err.statusCode === 410) {
            subscriptions = subscriptions.filter(s => s.endpoint !== sub.endpoint);
          }
          throw err;
        })
    )
  );
  await saveSubscriptions();
  return results;
}

// ── DATA HELPERS ──────────────────────────────────────────────────────────────
async function fetchTasks() {
  const { data } = await supabase.from('tasks').select('*');
  return (data || []).map(r => r.data);
}

async function fetchEvents() {
  const { data } = await supabase.from('events').select('*');
  return (data || []).map(r => r.data);
}

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const now = new Date(); now.setHours(0,0,0,0);
  return Math.round((new Date(dateStr + 'T00:00:00') - now) / 86400000);
}

function today() { return new Date().toISOString().split('T')[0]; }

function recDates(events) {
  const set = new Set();
  events.forEach(ev => {
    if (!ev.date) return;
    const days = parseInt(ev.recovery || 0);
    for (let i = 1; i <= days; i++) {
      const d = new Date(ev.date + 'T00:00:00');
      d.setDate(d.getDate() + i);
      set.add(d.toISOString().split('T')[0]);
    }
  });
  return set;
}

// ── CRON JOBS ─────────────────────────────────────────────────────────────────

// 🌅 Morning briefing — 8:00am every day
cron.schedule('0 8 * * *', async () => {
  const tasks = await fetchTasks();
  const active = tasks.filter(t => !t.done);
  const overdue = active.filter(t => t.due && daysUntil(t.due) < 0);
  const dueToday = active.filter(t => t.due === today() || t.scheduled === today());
  const acorns = tasks.filter(t => t.done).length;

  let body = `${active.length} tasks open`;
  if (overdue.length) body += `, ${overdue.length} overdue ⚠️`;
  if (dueToday.length) body += `, ${dueToday.length} due today 📌`;
  body += `. Open Pip for your morning briefing 🐿️`;

  await sendToAll({
    title: 'Good morning! Pip is ready 🌅',
    body,
    tag: 'pip-morning',
    url: '/'
  });
});

// 📌 Due today/tomorrow reminder — 9:00am
cron.schedule('0 9 * * *', async () => {
  const tasks = await fetchTasks();
  const dueTomorrow = tasks.filter(t => !t.done && t.due && daysUntil(t.due) === 1);
  if (!dueTomorrow.length) return;
  await sendToAll({
    title: 'Pip 🐿️ Due tomorrow',
    body: `🌰 Don't forget: ${dueTomorrow.slice(0,3).map(t=>t.title).join(', ')}${dueTomorrow.length>3?` + ${dueTomorrow.length-3} more`:''}`,
    tag: 'pip-due-tomorrow',
    url: '/'
  });
});

// 😬 Overdue nudge — 2:00pm
cron.schedule('0 14 * * *', async () => {
  const tasks = await fetchTasks();
  const overdue = tasks.filter(t => !t.done && t.due && daysUntil(t.due) < 0);
  if (!overdue.length) return;
  const dreaded = overdue.find(t => t.mood === 'dreading');
  const body = dreaded
    ? `😬 "${dreaded.title}" is still waiting… Pip believes in you. Just 5 minutes?`
    : `${overdue.length} task${overdue.length>1?'s are':' is'} overdue. Pip is holding them safely 🌰`;
  await sendToAll({
    title: 'Pip 🐿️ gentle nudge',
    body,
    tag: 'pip-overdue',
    url: '/'
  });
});

// 🛁 Recovery day reminder — 8:05am
cron.schedule('5 8 * * *', async () => {
  const events = await fetchEvents();
  const rec = recDates(events);
  if (!rec.has(today())) return;
  await sendToAll({
    title: 'Pip 🐿️ Recovery day 🛁',
    body: "Today is a recovery day. Keep it light, recharge, and be kind to yourself. Pip's orders! 🌿",
    tag: 'pip-recovery',
    url: '/'
  });
});

// 🌙 Evening check-in — 7:00pm
cron.schedule('0 19 * * *', async () => {
  const { data } = await supabase.from('settings').select('*').eq('id', 'last_seen');
  const lastSeen = data?.[0]?.data?.date;
  if (lastSeen === today()) return;
  await sendToAll({
    title: 'Pip 🐿️ Evening check-in',
    body: "Haven't heard from you today! Open Pip to check in — anything to add before the day's done? 🌰",
    tag: 'pip-evening',
    url: '/'
  });
});

// 📋 Friday planning reminder — 4:00pm Friday
cron.schedule('0 16 * * 5', async () => {
  const tasks = await fetchTasks();
  const unscheduled = tasks.filter(t => !t.done && !t.scheduled && !t.due);
  await sendToAll({
    title: 'Pip 🐿️ Friday — time to plan! 📋',
    body: `Open Pip to do your weekly review and plan next week! ${unscheduled.length > 0 ? `${unscheduled.length} tasks still need scheduling 🌰` : 'Let\'s set you up for success 🌿'}`,
    tag: 'pip-friday',
    url: '/'
  });
});

// 📵 Phone down — 11:00pm weekdays
cron.schedule('0 23 * * 1-5', async () => {
  await sendToAll({
    title: 'Pip 🐿️ phone down time!',
    body: "Hey! It's 11pm. Put the phone down, rest your brain. Tomorrow's tasks will still be there 🌿💤",
    tag: 'pip-bedtime',
    url: '/'
  });
});

// Health check
app.get('/', (req, res) => res.json({ status: 'Pip is awake! 🐿️', subscriptions: subscriptions.length }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  await loadSubscriptions();
  console.log(`🐿️ Pip notification server running on port ${PORT}`);
});

// 📌 Due today/tomorrow reminder — 9:00am
cron.schedule('0 9 * * *', async () => {
  const tasks = await fetchTasks();
  const dueTomorrow = tasks.filter(t => !t.done && t.due && daysUntil(t.due) === 1);
  if (!dueTomorrow.length) return;
  await sendToAll({
    title: 'Pip 🐿️ Due tomorrow',
    body: `🌰 Don't forget: ${dueTomorrow.slice(0,3).map(t=>t.title).join(', ')}${dueTomorrow.length>3?` + ${dueTomorrow.length-3} more`:''}`,
    tag: 'pip-due-tomorrow',
    url: '/'
  });
});

// 😬 Overdue nudge — 2:00pm
cron.schedule('0 14 * * *', async () => {
  const tasks = await fetchTasks();
  const overdue = tasks.filter(t => !t.done && t.due && daysUntil(t.due) < 0);
  if (!overdue.length) return;
  const dreaded = overdue.find(t => t.mood === 'dreading');
  const body = dreaded
    ? `😬 "${dreaded.title}" is still waiting… Pip believes in you. Just 5 minutes?`
    : `${overdue.length} task${overdue.length>1?'s are':' is'} overdue. Pip is holding them safely 🌰`;
  await sendToAll({
    title: 'Pip 🐿️ gentle nudge',
    body,
    tag: 'pip-overdue',
    url: '/'
  });
});

// 🛁 Recovery day reminder — 8:05am
cron.schedule('5 8 * * *', async () => {
  const events = await fetchEvents();
  const rec = recDates(events);
  if (!rec.has(today())) return;
  await sendToAll({
    title: 'Pip 🐿️ Recovery day 🛁',
    body: "Today is a recovery day. Keep it light, recharge, and be kind to yourself. Pip's orders! 🌿",
    tag: 'pip-recovery',
    url: '/'
  });
});

// 🌙 Evening check-in — 7:00pm (if not opened today, Pip nudges)
cron.schedule('0 19 * * *', async () => {
  // Check last_seen from settings
  const { data } = await supabase.from('settings').select('*').eq('id', 'last_seen');
  const lastSeen = data?.[0]?.data?.date;
  if (lastSeen === today()) return; // They already opened Pip today
  await sendToAll({
    title: 'Pip 🐿️ Evening check-in',
    body: "Haven't heard from you today! Pip saved your spot 🌰 — anything to add before the day's done?",
    tag: 'pip-evening',
    url: '/'
  });
});

// 📋 Friday planning reminder — 4:00pm Friday
cron.schedule('0 16 * * 5', async () => {
  const tasks = await fetchTasks();
  const unscheduled = tasks.filter(t => !t.done && !t.scheduled && !t.due);
  await sendToAll({
    title: 'Pip 🐿️ Friday planning time!',
    body: `🌰 Time to plan next week! ${unscheduled.length} tasks still need scheduling. Let's set you up for success.`,
    tag: 'pip-friday',
    url: '/?view=week'
  });
});

// 📵 Phone down — 11:00pm weekdays (Mon-Fri)
cron.schedule('0 23 * * 1-5', async () => {
  await sendToAll({
    title: 'Pip 🐿️ phone down time!',
    body: "Hey! It's 11pm. Pip says: put the phone down, rest your brain. Tomorrow's tasks will still be there 🌿💤",
    tag: 'pip-bedtime',
    url: '/'
  });
});

// Health check
app.get('/', (req, res) => res.json({ status: 'Pip is awake! 🐿️', subscriptions: subscriptions.length }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  await loadSubscriptions();
  console.log(`🐿️ Pip notification server running on port ${PORT}`);
});
