require('dotenv').config();
// In-memory fallback store for serverless compatibility
// (prevents deployment crashes when a DB dependency/URI is unavailable)
const jobStore = [];

const express = require('express');
const axios = require('axios');
const { engine } = require('express-handlebars');
const { google } = require('googleapis');
const cookieParser = require('cookie-parser');
const path = require('path');

const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// ================= VIEW ENGINE =================
app.engine('hbs', engine({
  extname: '.hbs',
  defaultLayout: 'main',
  helpers: {
    stripHtml: (h) => h ? h.replace(/<[^>]*>?/gm, '') : '',
    truncate: (text, length) => {
      if (!text) return '';
      if (text.length <= length) return text;
      return text.substring(0, length) + '...';
    },
    eq: (a, b) => a === b
  }
}));

app.set('view engine', 'hbs');
app.set('views', path.join(__dirname, 'views'));

// ================= OAUTH =================
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  `${process.env.BASE_URL}/auth/google/callback`
);

// ================= KEYWORDS =================
const POSITIVE_KEYWORDS = [
  'interview', 'next step', 'move forward', 'schedule',
  'congratulations', 'offer', 'phone screen'
];

const NEGATIVE_KEYWORDS = [
  'unfortunately', 'not moving forward', 'not selected',
  'regret to inform', 'position has been filled'
];

// ================= ROUTES =================

// Home
app.get('/', (req, res) => {
  res.render('search', { isSearch: true });
});

// Job Search
app.get('/search', async (req, res) => {
  const { q, l } = req.query;

  if (!q) return res.redirect('/');

  try {
    const response = await axios.get(
      'https://jsearch.p.rapidapi.com/search',
      {
        params: {
          query: l ? `${q} in ${l}` : q,
          page: '1',
          num_pages: '1'
        },
        headers: {
          'x-rapidapi-key': process.env.RAPID_API_KEY,
          'x-rapidapi-host': process.env.RAPID_API_HOST
        }
      }
    );

    res.render('results', {
      jobs: response.data.data || [],
      query: q,
      location: l || 'Anywhere'
    });

  } catch (err) {
    res.render('results', {
      jobs: [],
      error: 'Failed to fetch jobs.'
    });
  }
});

// GET Tracker Page (Now fetches from DB!)
app.get('/tracker', async (req, res) => {
  try {
    const jobs = [...jobStore].sort((a, b) => {
      const aTime = new Date(a.dateAdded || 0).getTime();
      const bTime = new Date(b.dateAdded || 0).getTime();
      return bTime - aTime;
    });
    
    res.render('tracker', { 
      isTracker: true,
      jobs: jobs // Pass the data to the view
    });
  } catch (err) {
    res.status(500).send('Server Error');
  }
});

// NEW ROUTE: Save a Job (Frontend calls this)
app.post('/api/jobs', async (req, res) => {
  try {
    const exists = jobStore.find(job => job.jobId === req.body.jobId);
    
    if (!exists) {
      jobStore.push({
        ...req.body,
        status: req.body.status || 'saved',
        dateAdded: req.body.dateAdded || new Date().toISOString()
      });
    }
    
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save job' });
  }
});

// OAuth Callback
app.get('/auth/google/callback', async (req, res) => {
  try {
    const { code } = req.query;
    const { tokens } = await oauth2Client.getToken(code);

    // Store tokens in cookie
    res.cookie('gmail_tokens', JSON.stringify(tokens), {
      httpOnly: true,
      secure: true,
      sameSite: 'lax'
    });

    res.redirect('/tracker');

  } catch (error) {
    res.send('Error connecting Gmail.');
  }
});

// Gmail Status
app.get('/api/gmail-status', (req, res) => {
  const tokens = req.cookies.gmail_tokens;
  res.json({ connected: !!tokens });
});

// Manual Email Check (Serverless safe)
app.get('/api/check-emails', async (req, res) => {
  try {
    const tokenCookie = req.cookies.gmail_tokens;
    if (!tokenCookie) {
      return res.json({ error: 'Not connected' });
    }

    const tokens = JSON.parse(tokenCookie);
    oauth2Client.setCredentials(tokens);

    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    const response = await gmail.users.messages.list({
      userId: 'me',
      q: 'newer_than:3d (subject:interview OR subject:offer OR subject:application)',
      maxResults: 10
    });

    const messages = response.data.messages || [];
    const updates = [];

    for (const message of messages) {
      const email = await gmail.users.messages.get({
        userId: 'me',
        id: message.id,
        format: 'full'
      });

      const headers = email.data.payload.headers;
      const subject = headers.find(h => h.name === 'Subject')?.value || '';
      const from = headers.find(h => h.name === 'From')?.value || '';

      const text = subject.toLowerCase();

      const hasPositive = POSITIVE_KEYWORDS.some(k => text.includes(k));
      const hasNegative = NEGATIVE_KEYWORDS.some(k => text.includes(k));

      if (hasPositive || hasNegative) {
        updates.push({
          company: from,
          type: hasPositive ? 'positive' : 'negative',
          subject
        });
      }
    }
res.json({ updates });

  } catch (err) {
    res.json({ error: 'Failed to check emails' });
  }
});


// Centralized error logging (helps debug Vercel 500s)
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  if (res.headersSent) return next(err);
  return res.status(500).send('Internal Server Error');
});

// JUST THIS AT THE VERY END:
module.exports = app;
