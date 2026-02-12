require('dotenv').config();
// 1. IMPORT & CONNECT
const mongoose = require('mongoose');

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => console.error('Could not connect to MongoDB', err));

// 2. DEFINE THE BLUEPRINT (SCHEMA)
const jobSchema = new mongoose.Schema({
  jobId: String,
  title: String,
  company: String,
  link: String,
  status: { type: String, default: 'saved' }, // saved, applied, interviewing
  dateAdded: { type: Date, default: Date.now }
});

// Create the Model (This is the tool we use to talk to the DB)
const Job = mongoose.model('Job', jobSchema);

const express = require('express');
const axios = require('axios');
const { engine } = require('express-handlebars');
const { google } = require('googleapis');
const cookieParser = require('cookie-parser');

const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static('public'));

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
app.set('views', './views');

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
    // "Job.find()" is a Mongoose command to get ALL jobs
    // .lean() makes it plain JSON so Handlebars can read it easily
    const jobs = await Job.find().sort({ dateAdded: -1 }).lean();
    
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
    // Check if job already exists to avoid duplicates
    const exists = await Job.findOne({ jobId: req.body.jobId });
    
    if (!exists) {
      // Create new job in DB
      await Job.create(req.body);
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

// JUST THIS AT THE VERY END:
module.exports = app;
