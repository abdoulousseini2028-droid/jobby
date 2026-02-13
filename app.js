require('dotenv').config();
const mongoose = require('mongoose');
const express = require('express');
const axios = require('axios');
const { engine } = require('express-handlebars');
const { google } = require('googleapis');
const cookieParser = require('cookie-parser');
const path = require('path');

// ================= SERVERLESS-FRIENDLY MongoDB CONNECTION =================
let isConnected = false;

async function connectDB() {
  if (isConnected) {
    console.log('Using existing database connection');
    return;
  }

  try {
    console.log('Attempting MongoDB connection...');
    console.log('MONGO_URI exists:', !!process.env.MONGO_URI);
    
    await mongoose.connect(process.env.MONGO_URI, {
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    });
    isConnected = true;
    console.log('MongoDB Connected Successfully');
  } catch (err) {
    console.error('MongoDB Connection Error:', err);
    throw err;
  }
}

// ================= DEFINE THE SCHEMA & MODEL =================
const jobSchema = new mongoose.Schema({
  jobId: String,
  title: String,
  company: String,
  link: String,
  status: { type: String, default: 'saved' },
  dateAdded: { type: Date, default: Date.now }
});

const Job = mongoose.model('Job', jobSchema);

// ================= EXPRESS APP =================
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
  layoutsDir: path.join(__dirname, 'views', 'layouts'),
  partialsDir: path.join(__dirname, 'views', 'partials'),
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
  const { q, l, employment_type, remote_jobs_only, job_requirements, date_posted } = req.query;

  if (!q) return res.redirect('/');

  try {
    // Build search params with filters
    const searchParams = {
      query: l ? `${q} in ${l}` : q,
      page: '1',
      num_pages: '1'
    };

    // Add filters if present
    if (employment_type) searchParams.employment_types = employment_type;
    if (remote_jobs_only) searchParams.remote_jobs_only = remote_jobs_only;
    if (job_requirements) searchParams.job_requirements = job_requirements;
    if (date_posted) searchParams.date_posted = date_posted;

    console.log('Search params:', searchParams);

    const response = await axios.get(
      'https://jsearch.p.rapidapi.com/search',
      {
        params: searchParams,
        headers: {
          'x-rapidapi-key': process.env.RAPID_API_KEY,
          'x-rapidapi-host': process.env.RAPID_API_HOST
        }
      }
    );

    res.render('results', {
      jobs: response.data.data || [],
      query: q,
      location: l || 'Anywhere',
      activeFilters: {
        employment_type,
        remote_jobs_only,
        job_requirements,
        date_posted
      }
    });

  } catch (err) {
    console.error('Job search error:', err);
    res.render('results', {
      jobs: [],
      error: 'Failed to fetch jobs.',
      query: q,
      location: l || 'Anywhere'
    });
  }
});

// GET Tracker Page (Fetches from MongoDB)
app.get('/tracker', async (req, res) => {
  try {
    console.log('Tracker route called');
    await connectDB();
    
    const jobs = await Job.find().sort({ dateAdded: -1 }).lean();
    console.log('Found jobs:', jobs.length);
    
    res.render('tracker', { 
      isTracker: true,
      jobs: jobs
    });
  } catch (err) {
    console.error('Tracker error:', err);
    console.error('Error stack:', err.stack);
    res.status(500).send('Server Error: ' + err.message);
  }
});

// POST - Save a Job to MongoDB
app.post('/api/jobs', async (req, res) => {
  try {
    console.log('=== SAVE JOB REQUEST ===');
    console.log('Request body:', req.body);
    
    // Check if MONGO_URI exists
    if (!process.env.MONGO_URI) {
      console.error('MONGO_URI is not set!');
      return res.status(500).json({ error: 'Database not configured' });
    }
    
    await connectDB();
    console.log('Database connected');
    
    // Check if job already exists
    const exists = await Job.findOne({ jobId: req.body.jobId });
    console.log('Job exists:', !!exists);
    
    if (!exists) {
      const newJob = await Job.create(req.body);
      console.log('Job created:', newJob._id);
    } else {
      console.log('Job already exists, skipping');
    }
    
    res.json({ success: true });
  } catch (err) {
    console.error('=== SAVE JOB ERROR ===');
    console.error('Error message:', err.message);
    console.error('Error stack:', err.stack);
    res.status(500).json({ 
      error: 'Failed to save job',
      message: err.message 
    });
  }
});

// OAuth Callback
app.get('/auth/google/callback', async (req, res) => {
  try {
    const { code } = req.query;
    const { tokens } = await oauth2Client.getToken(code);

    res.cookie('gmail_tokens', JSON.stringify(tokens), {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    res.redirect('/tracker');

  } catch (error) {
    console.error('OAuth callback error:', error);
    res.send('Error connecting Gmail.');
  }
});

// Gmail Status
app.get('/api/gmail-status', (req, res) => {
  const tokens = req.cookies.gmail_tokens;
  res.json({ connected: !!tokens });
});

// Manual Email Check
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
    console.error('Email check error:', err);
    res.json({ error: 'Failed to check emails' });
  }
});

module.exports = app;
