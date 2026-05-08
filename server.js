// Pip Notification Server — gentle, weekday-only, stress-free
const express = require('express');
const webpush = require('web-push');
const cron = require('node-cron');
const { createClient } = require('@supabase/supabase-js');
const { google } = require('googleapis');
const cors = require('cors');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });

const app = express();
app.use(express.json());
app.use(cors({ origin: '*' }));

webpush.setVapidDetails(
  `mailto:${process.env.VAPID_EMAIL}`,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
let subscriptions = [];

async function loadSubscriptions() {
  const { data } = await supabase.from('settings').select('*').eq('id', 'push_subscriptions');
  if (data && data[0]) subscriptions = data[0].data.subs || [];
}
async function saveSubscriptions() {
  await supabase.from('settings').upsert({ id: 'push_subscriptions', data: { id: 'push_subscriptions', subs: subscriptions } });
}

// ── ROUTES ────────────────────────────────────────────────────────────────────
app.get('/vapid-public-key', (req, res) => res.json({ publicKey: process.env.VAPID_PUBLIC_KEY }));

app.post('/subscribe', async (req, res) => {
  const { subscription } = req.body;
  subscriptions = subscriptions.filter(s => s.endpoint !== subscription.endpoint);
  subscriptions.push({ ...subscription, createdAt: new Date().toISOString() });
  await saveSubscriptions();
  res.json({ ok: true });
});

app.post('/test', async (req, res) => {
  await sendToAll({ title: 'Pip 🐿️', body: 'Notifications are working! 🌰', tag: 'pip-test' });
  res.json({ ok: true });
});

// Whisper transcription
app.post('/transcribe', upload.single('file'), async (req, res) => {
  try {
    const form = new FormData();
    const blob = new Blob([req.file.buffer], { type: req.file.mimetype });
    form.append('file', blob, req.file.originalname || 'audio.webm');
    form.append('model', 'whisper-large-v3');
    const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
      body: form,
    });
    const data = await response.json();
    res.json({ text: data.text || '' });
  } catch (e) { res.status(500).json({ error: e.message, text: '' }); }
});

// Groq proxy
app.post('/claude', async (req, res) => {
  try {
    const body = req.body;
    const groqBody = {
      model: 'llama-3.3-70b-versatile',
      max_tokens: body.max_tokens || 1000,
      messages: body.system
        ? [{ role: 'system', content: body.system }, ...body.messages]
        : body.messages,
    };
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify(groqBody),
    });
    const data = await response.json();
    const text = data.choices?.[0]?.message?.content || 'Sorry, something went wrong!';
    res.json({ content: [{ type: 'text', text }] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Patterns endpoint
app.get('/patterns', async (req, res) => {
  const { data } = await supabase.from('settings').select('*').like('id', 'daily_log_%');
  const logs = (data||[]).map(r=>r.data).filter(d=>d&&d.date).sort((a,b)=>b.date.localeCompare(a.date)).slice(0,14);
  const completions = logs.map(l=>l.completed||0);
  const avg = completions.length ? (completions.reduce((a,b)=>a+b,0)/completions.length).toFixed(1) : 0;
  res.json({ avgCompletionsPerDay: avg, recentLogs: logs.slice(0,7) });
});

// Window notification
app.post('/notify-window', async (req, res) => {
  const { windowText, taskCount } = req.body;
  await sendToAll({
    title: 'Pip 🐿️ your work window is now!',
    body: `${windowText} — Pip has your plan ready 🌰`,
    tag: 'pip-window', url: '/'
  });
  res.json({ ok: true });
});

// Sync habits
app.post('/sync-habits', async (req, res) => {
  const { routines, habits } = req.body;
  if (routines) await supabase.from('settings').upsert({ id: 'routines_data', data: { id: 'routines_data', items: routines } });
  if (habits) await supabase.from('settings').upsert({ id: 'habits_data', data: { id: 'habits_data', items: habits } });
  res.json({ ok: true });
});

// Weekly insight push (called by app)
app.post('/weekly-insight', async (req, res) => {
  const { insight } = req.body;
  if (!insight) return res.json({ ok: false });
  await sendToAll({
    title: 'Pip 🐿️ noticed something',
    body: insight.length > 100 ? insight.slice(0, 97) + '…' : insight,
    tag: 'pip-insight', url: '/'
  });
  res.json({ ok: true });
});

// Push helper
async function sendToAll(payload) {
  await Promise.allSettled(subscriptions.map(sub =>
    webpush.sendNotification(sub, JSON.stringify(payload)).catch(err => {
      if (err.statusCode === 410) subscriptions = subscriptions.filter(s => s.endpoint !== sub.endpoint);
    })
  ));
  await saveSubscriptions();
}

// Data helpers
async function fetchTasks() {
  const { data } = await supabase.from('tasks').select('*');
  return (data||[]).map(r=>r.data);
}
function daysUntil(ds) {
  if (!ds) return null;
  const n = new Date(); n.setHours(0,0,0,0);
  return Math.round((new Date(ds.length===10?ds+'T00:00:00':ds)-n)/86400000);
}
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function isWeekend() {
  const d = new Date().getDay();
  return d === 0 || d === 6;
}
function recDates(events) {
  const s = new Set();
  events.forEach(ev => {
    if (!ev.date) return;
    for (let i = 1; i <= parseInt(ev.recovery||0); i++) {
      const d = new Date(ev.date+'T00:00:00'); d.setDate(d.getDate()+i);
      s.add(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`);
    }
  });
  return s;
}

// Log daily stats
async function logDailyStats() {
  const tasks = await fetchTasks();
  const t = today();
  const completed = tasks.filter(x => x.done && x.completedAt && x.completedAt.startsWith(t));
  await supabase.from('settings').upsert({
    id: `daily_log_${t}`,
    data: { id: `daily_log_${t}`, date: t, completed: completed.length, total: tasks.filter(x=>!x.done).length }
  });
}

// ── CRON SCHEDULE (Vienna/CET = UTC+2 in summer) ──────────────────────────────
// All times in UTC. Weekdays only (1-5). No weekends. No task counts. No stress.

// 🌅 8am Vienna (6am UTC) — gentle morning opener, weekdays only
cron.schedule('0 6 * * 1-5', async () => {
  await sendToAll({
    title: 'Good morning! 🌅',
    body: 'Pip is ready when you are 🐿️',
    tag: 'pip-morning', url: '/'
  });
  await logDailyStats();
});

// 🛁 Recovery day — 8:05am Vienna (6:05am UTC)
cron.schedule('5 6 * * 1-5', async () => {
  const { data } = await supabase.from('events').select('*');
  const events = (data||[]).map(r=>r.data);
  if (!recDates(events).has(today())) return;
  await sendToAll({
    title: 'Recovery day 🛁',
    body: "Keep it light today. Pip has your back 🌿",
    tag: 'pip-recovery', url: '/'
  });
});

// 🌙 7pm Vienna (5pm UTC) — gentle evening check-in, weekdays only
cron.schedule('0 17 * * 1-5', async () => {
  const { data } = await supabase.from('settings').select('*').eq('id', 'last_seen');
  if (data?.[0]?.data?.date === today()) return; // skip if they used Pip today
  await sendToAll({
    title: 'Evening check-in 🌙',
    body: "How did today go? Open Pip for a quick review 🌰",
    tag: 'pip-evening', url: '/'
  });
});

// 📋 4pm Friday Vienna (2pm UTC) — weekly planning
cron.schedule('0 14 * * 5', async () => {
  await sendToAll({
    title: 'Friday — time to reflect 📋',
    body: "Open Pip for your weekly review 🐿️",
    tag: 'pip-friday', url: '/'
  });
});

// 📵 11pm Vienna (9pm UTC) — phone down, weekdays only
cron.schedule('0 21 * * 1-5', async () => {
  await sendToAll({
    title: 'Phone down time 📵',
    body: "Rest your brain. You did enough today 🌿",
    tag: 'pip-bedtime', url: '/'
  });
});

// 🌱 Habit reminder — 8pm Vienna (6pm UTC), weekdays only
cron.schedule('0 18 * * 1-5', async () => {
  const { data } = await supabase.from('settings').select('*');
  const habitsRow = data?.find(r => r.id === 'habits_data');
  const habits = habitsRow?.data?.items || [];
  const t = today();
  const missed = habits.filter(h => !h.log?.includes(t));
  if (!missed.length) return;
  await sendToAll({
    title: 'Habits check 🌱',
    body: `Don't forget your habits before bed 🌰`,
    tag: 'pip-habits', url: '/'
  });
});

// 🌻 Sunday evening summary — 7pm Sunday Vienna (5pm UTC)
cron.schedule('0 17 * * 0', async () => {
  const tasks = await fetchTasks();
  const { data: logs } = await supabase.from('settings').select('*').like('id', 'daily_log_%');
  const weekLogs = (logs||[]).map(r=>r.data).filter(d=>d&&d.date).sort((a,b)=>b.date.localeCompare(a.date)).slice(0,7);
  const totalDone = weekLogs.reduce((sum,l)=>sum+(l.completed||0),0);
  await sendToAll({
    title: 'Pip\'s weekly summary 🌻',
    body: `This week you completed ${totalDone} task${totalDone!==1?'s':''} 🌰 New week starts tomorrow — you've got this!`,
    tag: 'pip-weekly', url: '/'
  });
});

// Log stats end of day — 10pm Vienna (8pm UTC)
cron.schedule('0 20 * * *', async () => { await logDailyStats(); });

app.get('/', (req, res) => res.json({ status: 'Pip is awake! 🐿️', subscriptions: subscriptions.length }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  await loadSubscriptions();
  console.log(`🐿️ Pip server running on port ${PORT}`);
});
