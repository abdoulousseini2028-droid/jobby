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

// ================= SCHEMAS =================

// User Schema
const userSchema = new mongoose.Schema({
  googleId: { type: String, required: true, unique: true },
  email: String,
  name: String,
  picture: String,
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);

// Job Schema - NOW WITH USER ID
const jobSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
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

// ================= MIDDLEWARE: Check if User is Logged In =================
function requireAuth(req, res, next) {
  const userCookie = req.cookies.user;
  if (!userCookie) {
    return res.redirect('/login');
  }
  try {
    req.user = JSON.parse(userCookie);
    next();
  } catch (err) {
    res.clearCookie('user');
    res.redirect('/login');
  }
}

function addUserToViews(req, res, next) {
  const userCookie = req.cookies.user;
  res.locals.user = userCookie ? JSON.parse(userCookie) : null;
  next();
}

app.use(addUserToViews);

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

// Login Page
app.get('/login', (req, res) => {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/userinfo.profile',
      'https://www.googleapis.com/auth/userinfo.email'
    ]
  });
  res.render('login', { authUrl });
});

// Logout
app.get('/logout', (req, res) => {
  res.clearCookie('user');
  res.redirect('/');
});

// Google OAuth Callback
app.get('/auth/google/callback', async (req, res) => {
  try {
    const { code } = req.query;
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // Get user info from Google
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data } = await oauth2.userinfo.get();

    console.log('Google user data:', data);

    await connectDB();

    // Find or create user in database
    let user = await User.findOne({ googleId: data.id });
    
    if (!user) {
      user = await User.create({
        googleId: data.id,
        email: data.email,
        name: data.name,
        picture: data.picture
      });
      console.log('New user created:', user._id);
    } else {
      console.log('Existing user logged in:', user._id);
    }

    // Store user info in cookie
    res.cookie('user', JSON.stringify({
      id: user._id,
      googleId: user.googleId,
      email: user.email,
      name: user.name,
      picture: user.picture
    }), {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
    });

    res.redirect('/tracker');

  } catch (error) {
    console.error('OAuth callback error:', error);
    res.redirect('/login?error=auth_failed');
  }
});

// Job Search
app.get('/search', async (req, res) => {
  const { q, l, employment_type, remote_jobs_only, job_requirements, date_posted } = req.query;

  if (!q) return res.redirect('/');

  try {
    const searchParams = {
      query: l ? `${q} in ${l}` : q,
      page: '1',
      num_pages: '1'
    };

    if (employment_type) searchParams.employment_types = employment_type;
    if (remote_jobs_only) searchParams.remote_jobs_only = remote_jobs_only;
    if (job_requirements) searchParams.job_requirements = job_requirements;
    if (date_posted) searchParams.date_posted = date_posted;

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

// GET Tracker Page - PROTECTED ROUTE, USER-SPECIFIC
app.get('/tracker', requireAuth, async (req, res) => {
  try {
    await connectDB();
    
    // Only get jobs for THIS user
    const jobs = await Job.find({ userId: req.user.id })
      .sort({ dateAdded: -1 })
      .lean();
    
    console.log(`User ${req.user.email} has ${jobs.length} saved jobs`);
    
    res.render('tracker', { 
      isTracker: true,
      jobs: jobs
    });
  } catch (err) {
    console.error('Tracker error:', err);
    res.status(500).send('Server Error: ' + err.message);
  }
});

// POST - Save a Job - PROTECTED ROUTE, USER-SPECIFIC
app.post('/api/jobs', requireAuth, async (req, res) => {
  try {
    console.log('=== SAVE JOB REQUEST ===');
    console.log('User:', req.user.email);
    console.log('Job:', req.body.title);
    
    await connectDB();
    
    // Check if THIS USER already saved this job
    const exists = await Job.findOne({ 
      userId: req.user.id,
      jobId: req.body.jobId 
    });
    
    if (!exists) {
      const newJob = await Job.create({
        userId: req.user.id, // Link to user!
        jobId: req.body.jobId,
        title: req.body.title,
        company: req.body.company,
        link: req.body.link,
        status: req.body.status || 'saved'
      });
      console.log('Job created for user:', req.user.email);
      res.json({ success: true, message: 'Job saved!' });
    } else {
      console.log('Job already exists for this user');
      res.json({ success: true, message: 'Job already saved' });
    }
    
  } catch (err) {
    console.error('=== SAVE JOB ERROR ===');
    console.error('Error:', err.message);
    res.status(500).json({ 
      error: 'Failed to save job',
      message: err.message 
    });
  }
});

// Check Auth Status (for frontend)
app.get('/api/auth-status', (req, res) => {
  const userCookie = req.cookies.user;
  if (userCookie) {
    try {
      const user = JSON.parse(userCookie);
      res.json({ authenticated: true, user });
    } catch (err) {
      res.json({ authenticated: false });
    }
  } else {
    res.json({ authenticated: false });
  }
});

// Gmail Status
app.get('/api/gmail-status', (req, res) => {
  const tokens = req.cookies.gmail_tokens;
  res.json({ connected: !!tokens });
});

// Manual Email Check
app.get('/api/check-emails', requireAuth, async (req, res) => {
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