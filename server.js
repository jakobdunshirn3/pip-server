// Pip Notification Server
const express = require('express');
const webpush = require('web-push');
const cron = require('node-cron');
const { createClient } = require('@supabase/supabase-js');
const { google } = require('googleapis');
const cors = require('cors');

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

// GROQ PROXY - routes AI calls through server to avoid browser CORS
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

// Google Calendar OAuth
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
async function fetchTasks() { const { data } = await supabase.from('tasks').select('*'); return (data||[]).map(r=>r.data); }
async function fetchEvents() { const { data } = await supabase.from('events').select('*'); return (data||[]).map(r=>r.data); }
function daysUntil(ds) { if(!ds)return null; const n=new Date();n.setHours(0,0,0,0); return Math.round((new Date(ds+'T00:00:00')-n)/86400000); }
function today() { return new Date().toISOString().split('T')[0]; }
function recDates(events) { const s=new Set(); events.forEach(ev=>{if(!ev.date)return;for(let i=1;i<=parseInt(ev.recovery||0);i++){const d=new Date(ev.date+'T00:00:00');d.setDate(d.getDate()+i);s.add(d.toISOString().split('T')[0]);}}); return s; }

// Cron jobs
cron.schedule('0 8 * * *', async () => {
  const tasks = await fetchTasks(); const active=tasks.filter(t=>!t.done);
  const overdue=active.filter(t=>t.due&&daysUntil(t.due)<0); const dueToday=active.filter(t=>t.due===today()||t.scheduled===today());
  let body=`${active.length} tasks open`; if(overdue.length)body+=`, ${overdue.length} overdue ⚠️`; if(dueToday.length)body+=`, ${dueToday.length} due today 📌`; body+=`. Open Pip for your morning briefing 🐿️`;
  await sendToAll({ title:'Good morning! Pip is ready 🌅', body, tag:'pip-morning', url:'/' });
});

cron.schedule('0 9 * * *', async () => {
  const tasks=await fetchTasks(); const due=tasks.filter(t=>!t.done&&t.due&&daysUntil(t.due)===1); if(!due.length)return;
  await sendToAll({ title:'Pip 🐿️ Due tomorrow', body:`🌰 Don't forget: ${due.slice(0,3).map(t=>t.title).join(', ')}${due.length>3?` + ${due.length-3} more`:''}`, tag:'pip-due-tomorrow', url:'/' });
});

cron.schedule('0 14 * * *', async () => {
  const tasks=await fetchTasks(); const overdue=tasks.filter(t=>!t.done&&t.due&&daysUntil(t.due)<0); if(!overdue.length)return;
  const dreaded=overdue.find(t=>t.mood==='dreading');
  await sendToAll({ title:'Pip 🐿️ gentle nudge', body:dreaded?`😬 "${dreaded.title}" is still waiting… Just 5 minutes?`:`${overdue.length} task${overdue.length>1?'s are':' is'} overdue. Pip is holding them safely 🌰`, tag:'pip-overdue', url:'/' });
});

cron.schedule('5 8 * * *', async () => {
  const events=await fetchEvents(); if(!recDates(events).has(today()))return;
  await sendToAll({ title:'Pip 🐿️ Recovery day 🛁', body:"Today is a recovery day. Keep it light and recharge. Pip's orders! 🌿", tag:'pip-recovery', url:'/' });
});

cron.schedule('0 19 * * *', async () => {
  const { data }=await supabase.from('settings').select('*').eq('id','last_seen');
  if(data?.[0]?.data?.date===today())return;
  await sendToAll({ title:'Pip 🐿️ Evening check-in', body:"Haven't heard from you today! Open Pip to check in 🌰", tag:'pip-evening', url:'/' });
});

cron.schedule('0 16 * * 5', async () => {
  const tasks=await fetchTasks(); const u=tasks.filter(t=>!t.done&&!t.scheduled&&!t.due);
  await sendToAll({ title:'Pip 🐿️ Friday — time to plan! 📋', body:`Open Pip for your weekly review! ${u.length>0?`${u.length} tasks unscheduled 🌰`:"Let's set you up for a great week 🌿"}`, tag:'pip-friday', url:'/' });
});

cron.schedule('0 23 * * 1-5', async () => {
  await sendToAll({ title:'Pip 🐿️ phone down time!', body:"It's 11pm. Put the phone down, rest your brain 🌿💤", tag:'pip-bedtime', url:'/' });
});

app.get('/', (req, res) => res.json({ status:'Pip is awake! 🐿️', subscriptions:subscriptions.length }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => { await loadSubscriptions(); console.log(`🐿️ Pip notification server running on port ${PORT}`); });
