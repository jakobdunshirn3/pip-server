// Pip Notification Server — with smart pattern-aware notifications
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

// WHISPER TRANSCRIPTION
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
  } catch (e) {
    res.status(500).json({ error: e.message, text: '' });
  }
});

// GROQ PROXY
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
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PATTERN TRACKING ──────────────────────────────────────────────────────────
// Log daily stats to Supabase for Pip to analyse
async function logDailyStats() {
  const tasks = await fetchTasks();
  const t = today();
  const completed = tasks.filter(x => x.done && x.completedAt && x.completedAt.startsWith(t));
  const overdue = tasks.filter(x => !x.done && x.due && daysUntil(x.due) < 0);
  const dreaded = tasks.filter(x => !x.done && x.mood === 'dreading');
  
  const entry = {
    date: t,
    completed: completed.length,
    overdue: overdue.length,
    dreaded: dreaded.length,
    totalOpen: tasks.filter(x => !x.done).length,
  };
  
  await supabase.from('settings').upsert({
    id: `daily_log_${t}`,
    data: { id: `daily_log_${t}`, ...entry }
  });
}

// Get last N days of logs
async function getRecentLogs(days = 14) {
  const { data } = await supabase.from('settings').select('*').like('id', 'daily_log_%');
  if (!data) return [];
  return data
    .map(r => r.data)
    .filter(d => d && d.date)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, days);
}

// Smart notification budget — max 2 extra per day
async function getSmartNotifCount() {
  const { data } = await supabase.from('settings').select('*').eq('id', `smart_notif_${today()}`);
  return data?.[0]?.data?.count || 0;
}
async function incrementSmartNotifCount() {
  const count = await getSmartNotifCount() + 1;
  await supabase.from('settings').upsert({ id: `smart_notif_${today()}`, data: { id: `smart_notif_${today()}`, count } });
  return count;
}

// Google Calendar
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET,
  `${process.env.SERVER_URL || 'https://pip-server.onrender.com'}/gcal/callback`
);
const gcalTokens = {};

app.get('/gcal/auth', (req, res) => {
  const state = Buffer.from(JSON.stringify({ returnUrl: req.query.returnUrl || '/' })).toString('base64');
  res.redirect(oauth2Client.generateAuthUrl({ access_type: 'offline', scope: ['https://www.googleapis.com/auth/calendar.readonly'], state }));
});

app.get('/gcal/callback', async (req, res) => {
  const { code, state } = req.query;
  const { returnUrl } = JSON.parse(Buffer.from(state, 'base64').toString());
  const { tokens } = await oauth2Client.getToken(code);
  const tokenId = Math.random().toString(36).slice(2);
  gcalTokens[tokenId] = tokens;
  const url = new URL(returnUrl);
  url.searchParams.set('gcal_token', tokenId);
  res.redirect(url.toString());
});

// Expose pattern data to the app
app.get('/patterns', async (req, res) => {
  const logs = await getRecentLogs(14);
  const tasks = await fetchTasks();
  
  // Find tasks that have been postponed (scheduled date in the past, still open)
  const avoided = tasks.filter(t => !t.done && t.scheduled && daysUntil(t.scheduled) < -2);
  const longDreaded = tasks.filter(t => !t.done && t.mood === 'dreading' && t.createdAt && daysUntil(t.createdAt) < -3);
  
  // Completion trend
  const completionsPerDay = logs.map(l => l.completed || 0);
  const avgCompletion = completionsPerDay.length
    ? (completionsPerDay.reduce((a, b) => a + b, 0) / completionsPerDay.length).toFixed(1)
    : 0;
  
  // Best day of week
  const byDow = {};
  logs.forEach(l => {
    const dow = new Date(l.date + 'T12:00:00').getDay();
    byDow[dow] = (byDow[dow] || []);
    byDow[dow].push(l.completed || 0);
  });
  const dowNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  let bestDow = null, bestAvg = 0;
  Object.entries(byDow).forEach(([dow, vals]) => {
    const avg = vals.reduce((a,b)=>a+b,0)/vals.length;
    if (avg > bestAvg) { bestAvg = avg; bestDow = dowNames[+dow]; }
  });

  res.json({
    avgCompletionsPerDay: avgCompletion,
    bestDay: bestDow,
    recentLogs: logs.slice(0, 7),
    avoidedTasks: avoided.slice(0, 5).map(t => ({ title: t.title, daysBehind: Math.abs(daysUntil(t.scheduled)) })),
    longDreadedTasks: longDreaded.slice(0, 3).map(t => ({ title: t.title, daysOld: Math.abs(daysUntil(t.createdAt)) })),
    overdueStreak: logs.filter(l => (l.overdue || 0) >= 3).length,
  });
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

// Smart send — respects daily budget of 2 extra notifs
async function sendSmart(payload) {
  const count = await getSmartNotifCount();
  if (count >= 2) return false;
  await sendToAll(payload);
  await incrementSmartNotifCount();
  return true;
}

// Data helpers
async function fetchTasks() {
  const { data } = await supabase.from('tasks').select('*');
  return (data||[]).map(r=>r.data);
}
async function fetchEvents() {
  const { data } = await supabase.from('events').select('*');
  return (data||[]).map(r=>r.data);
}
function daysUntil(ds) {
  if(!ds)return null;
  const n=new Date(); n.setHours(0,0,0,0);
  return Math.round((new Date(ds.length===10?ds+'T00:00:00':ds)-n)/86400000);
}
function today() {
  const d=new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function recDates(events) {
  const s=new Set();
  events.forEach(ev=>{
    if(!ev.date)return;
    for(let i=1;i<=parseInt(ev.recovery||0);i++){
      const d=new Date(ev.date+'T00:00:00'); d.setDate(d.getDate()+i);
      s.add(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`);
    }
  });
  return s;
}

// ── CRON JOBS ─────────────────────────────────────────────────────────────────

// 🌅 Morning briefing — 8am Vienna (6am UTC)
cron.schedule('0 6 * * *', async () => {
  const tasks = await fetchTasks();
  const active = tasks.filter(t=>!t.done);
  const overdue = active.filter(t=>t.due&&daysUntil(t.due)<0);
  const dueToday = active.filter(t=>t.due===today()||t.scheduled===today());
  let body = `${active.length} tasks open`;
  if(overdue.length) body += `, ${overdue.length} overdue ⚠️`;
  if(dueToday.length) body += `, ${dueToday.length} due today 📌`;
  body += `. Open Pip for your morning briefing 🐿️`;
  await sendToAll({ title:'Good morning! Pip is ready 🌅', body, tag:'pip-morning', url:'/' });
  // Log daily stats at the start of each day
  await logDailyStats();
});

// 📌 Due tomorrow — 7am Vienna (5am UTC... but morning briefing covers it, so 9am = 7am UTC)
cron.schedule('0 7 * * *', async () => {
  const tasks = await fetchTasks();
  const due = tasks.filter(t=>!t.done&&t.due&&daysUntil(t.due)===1);
  if(!due.length) return;
  await sendToAll({
    title:'Pip 🐿️ Due tomorrow',
    body:`🌰 Don't forget: ${due.slice(0,3).map(t=>t.title).join(', ')}${due.length>3?` + ${due.length-3} more`:''}`,
    tag:'pip-due-tomorrow', url:'/'
  });
});

// 😬 Overdue nudge — 12pm Vienna (10am UTC)
cron.schedule('0 10 * * *', async () => {
  const tasks = await fetchTasks();
  const overdue = tasks.filter(t=>!t.done&&t.due&&daysUntil(t.due)<0);
  if(!overdue.length) return;
  const dreaded = overdue.find(t=>t.mood==='dreading');
  await sendToAll({
    title:'Pip 🐿️ gentle nudge',
    body: dreaded
      ? `😬 "${dreaded.title}" is still waiting… Just 5 minutes?`
      : `${overdue.length} task${overdue.length>1?'s are':' is'} overdue. Pip is holding them safely 🌰`,
    tag:'pip-overdue', url:'/'
  });
});

// 🛁 Recovery day — 8:05am Vienna (6:05am UTC)
cron.schedule('5 6 * * *', async () => {
  const events = await fetchEvents();
  if(!recDates(events).has(today())) return;
  await sendToAll({ title:'Pip 🐿️ Recovery day 🛁', body:"Today is a recovery day. Keep it light and recharge. Pip's orders! 🌿", tag:'pip-recovery', url:'/' });
});

// 🌙 Evening check-in — 7pm Vienna (5pm UTC)
cron.schedule('0 17 * * *', async () => {
  const { data } = await supabase.from('settings').select('*').eq('id','last_seen');
  if(data?.[0]?.data?.date===today()) return;
  await sendToAll({ title:'Pip 🐿️ Evening check-in', body:"Haven't heard from you today! Open Pip to check in 🌰", tag:'pip-evening', url:'/' });
});

// 📋 Friday planning — 4pm Vienna (2pm UTC)
cron.schedule('0 14 * * 5', async () => {
  const tasks = await fetchTasks();
  const u = tasks.filter(t=>!t.done&&!t.scheduled&&!t.due);
  await sendToAll({
    title:'Pip 🐿️ Friday — time to plan! 📋',
    body:`Open Pip for your weekly review! ${u.length>0?`${u.length} tasks unscheduled 🌰`:"Let's set you up for a great week 🌿"}`,
    tag:'pip-friday', url:'/'
  });
});

// 📵 Phone down — 11pm Vienna (9pm UTC)
cron.schedule('0 21 * * 1-5', async () => {
  await sendToAll({ title:'Pip 🐿️ phone down time!', body:"It's 11pm. Put the phone down, rest your brain 🌿💤", tag:'pip-bedtime', url:'/' });
});

// ── SMART NOTIFICATIONS ───────────────────────────────────────────────────────

// 😬 Dreaded task sitting too long — check 11am Vienna (9am UTC)
cron.schedule('0 9 * * *', async () => {
  const tasks = await fetchTasks();
  // Find dreaded tasks created 3+ days ago that are still open
  const staleDreaded = tasks.filter(t => {
    if(t.done || t.mood !== 'dreading') return false;
    if(!t.createdAt) return false;
    return daysUntil(t.createdAt) <= -3;
  });
  if(!staleDreaded.length) return;
  const worst = staleDreaded.sort((a,b) => daysUntil(a.createdAt)-daysUntil(b.createdAt))[0];
  const days = Math.abs(daysUntil(worst.createdAt));
  await sendSmart({
    title:'Pip 🐿️ that task though…',
    body:`"${worst.title}" has been sitting there ${days} days. Pip notices. Even just looking at it counts 🌰`,
    tag:'pip-dreaded-stale', url:'/'
  });
});

// 📉 Low completion day — check 2pm Vienna (12pm UTC), nudge if nothing done
cron.schedule('0 12 * * *', async () => {
  const tasks = await fetchTasks();
  // Check if anything completed today
  const completedToday = tasks.filter(t => t.done && t.completedAt && t.completedAt.startsWith(today()));
  if(completedToday.length > 0) return; // already doing well
  const active = tasks.filter(t => !t.done);
  if(!active.length) return; // nothing to do anyway
  await sendSmart({
    title:'Pip 🐿️ hey, still here 🌰',
    body:`Nothing ticked off yet today. Pick the smallest thing and just start — Pip believes in you.`,
    tag:'pip-low-day', url:'/'
  });
});

// 🔄 Task avoided 3+ days — check 10am Vienna (8am UTC)  
cron.schedule('0 8 * * *', async () => {
  const tasks = await fetchTasks();
  // Tasks scheduled in the past but still open (postponed)
  const avoided = tasks.filter(t => {
    if(t.done || !t.scheduled) return false;
    return daysUntil(t.scheduled) <= -3;
  });
  if(!avoided.length) return;
  const task = avoided[0];
  const days = Math.abs(daysUntil(task.scheduled));
  await sendSmart({
    title:'Pip 🐿️ this one keeps moving…',
    body:`"${task.title}" was meant to happen ${days} days ago. Want to reschedule or break it down?`,
    tag:'pip-avoided', url:'/'
  });
});

// 📊 Overdue streak — check 3pm Vienna (1pm UTC), only if 5+ overdue for 3+ days running  
cron.schedule('0 13 * * *', async () => {
  const logs = await getRecentLogs(5);
  const streak = logs.filter(l => (l.overdue || 0) >= 5).length;
  if(streak < 3) return;
  const tasks = await fetchTasks();
  const overdue = tasks.filter(t=>!t.done&&t.due&&daysUntil(t.due)<0);
  await sendSmart({
    title:'Pip 🐿️ we need to talk 🌰',
    body:`You've had ${overdue.length} overdue tasks for ${streak}+ days. Open Pip — let's reset together.`,
    tag:'pip-streak', url:'/'
  });
});

// Log stats at end of day too — 10pm Vienna (8pm UTC)
cron.schedule('0 20 * * *', async () => {
  await logDailyStats();
});

// Log stats at end of day too — 10pm Vienna (8pm UTC)
cron.schedule('0 20 * * *', async () => {
  await logDailyStats();
});

// ── HABIT & ROUTINE REMINDERS — 8pm Vienna (6pm UTC) ─────────────────────────
cron.schedule('0 18 * * *', async () => {
  const { data: settingsData } = await supabase.from('settings').select('*');
  const routinesRow = settingsData?.find(r => r.id === 'routines_data');
  const habitsRow = settingsData?.find(r => r.id === 'habits_data');
  const t = today();

  // Check routines due today not done
  const routines = routinesRow?.data?.items || [];
  const dueRoutines = routines.filter(r => {
    if (r.lastDone === t) return false; // already done today
    const days = { daily: 1, weekly: 7, biweekly: 14, monthly: 30 }[r.freq] || 7;
    if (!r.lastDone) return true;
    const daysSince = Math.round((new Date(t+'T00:00:00') - new Date(r.lastDone+'T00:00:00')) / 86400000);
    return daysSince >= days;
  });

  // Check habits not logged today
  const habits = habitsRow?.data?.items || [];
  const missedHabits = habits.filter(h => !h.log?.includes(t));

  const items = [...dueRoutines.map(r => r.name), ...missedHabits.map(h => h.name)];
  if (!items.length) return;

  await sendToAll({
    title: 'Pip 🐿️ evening check-in',
    body: `Still pending: ${items.slice(0, 3).join(', ')}${items.length > 3 ? ` + ${items.length - 3} more` : ''}. Quick wins before bed! 🌰`,
    tag: 'pip-habits', url: '/'
  });
});

// ── TIME WINDOW NOTIFICATION ENDPOINT ─────────────────────────────────────────
// Called by the app when a scheduled window starts (cron can't know user's windows)
app.post('/notify-window', async (req, res) => {
  const { windowText, taskCount } = req.body;
  await sendToAll({
    title: 'Pip 🐿️ your work window is now!',
    body: `${windowText} — you planned this time for ${taskCount ? taskCount + ' tasks' : 'focused work'}. Pip has your plan ready 🌰`,
    tag: 'pip-window', url: '/'
  });
  res.json({ ok: true });
});

// Store habits/routines for server-side reminder checking
app.post('/sync-habits', async (req, res) => {
  const { routines, habits } = req.body;
  if (routines) await supabase.from('settings').upsert({ id: 'routines_data', data: { id: 'routines_data', items: routines } });
  if (habits) await supabase.from('settings').upsert({ id: 'habits_data', data: { id: 'habits_data', items: habits } });
  res.json({ ok: true });
});

app.get('/', (req, res) => res.json({ status:'Pip is awake! 🐿️', subscriptions:subscriptions.length }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  await loadSubscriptions();
  console.log(`🐿️ Pip notification server running on port ${PORT}`);
});
