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
  if (isConnected && mongoose.connection.readyState === 1) {
    console.log('✓ Using existing database connection');
    return;
  }

  if (!process.env.MONGO_URI) {
    throw new Error('MONGO_URI environment variable is not set');
  }

  try {
    console.log('→ Connecting to MongoDB...');
    
    await mongoose.connect(process.env.MONGO_URI, {
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 45000,
      maxPoolSize: 10,
      minPoolSize: 2,
    });
    
    isConnected = true;
    console.log('✓ MongoDB Connected Successfully');
  } catch (err) {
    console.error('✗ MongoDB Connection Error:', err.message);
    isConnected = false;
    throw err;
  }
}

// Handle MongoDB connection events
mongoose.connection.on('disconnected', () => {
  console.log('MongoDB disconnected');
  isConnected = false;
});

mongoose.connection.on('error', (err) => {
  console.error('MongoDB error:', err);
  isConnected = false;
});

// ================= DEFINE THE SCHEMA & MODEL =================
const jobSchema = new mongoose.Schema({
  jobId: { type: String, required: true, unique: true },
  title: { type: String, required: true },
  company: { type: String, required: true },
  link: { type: String, required: true },
  status: { type: String, default: 'saved', enum: ['saved', 'applied', 'interviewing', 'rejected', 'offer'] },
  dateAdded: { type: Date, default: Date.now },
  lastUpdated: { type: Date, default: Date.now }
});

// Use existing model if it exists (prevents OverwriteModelError in serverless)
const Job = mongoose.models.Job || mongoose.model('Job', jobSchema);

// ================= EXPRESS APP =================
const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// Trust proxy for Vercel
app.set('trust proxy', 1);

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

// ================= OAUTH HELPER =================
const getOAuthClient = () => {
  // Determine the correct base URL for Vercel or local
  let baseUrl = process.env.BASE_URL;
  
  if (!baseUrl) {
    if (process.env.VERCEL_URL) {
      baseUrl = `https://${process.env.VERCEL_URL}`;
    } else {
      baseUrl = 'http://localhost:3000';
    }
  }
  
  console.log('OAuth callback URL:', `${baseUrl}/auth/google/callback`);
  
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${baseUrl}/auth/google/callback`
  );
};

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
    console.error('Job search error:', err.response?.data || err.message);
    res.render('results', {
      jobs: [],
      error: 'Failed to fetch jobs. Please try again.',
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
    
    // Validate required fields
    if (!req.body.jobId || !req.body.title || !req.body.company || !req.body.link) {
      return res.status(400).json({ 
        success: false,
        error: 'Missing required fields',
        message: 'jobId, title, company, and link are required' 
      });
    }
    
    // Check if MONGO_URI exists
    if (!process.env.MONGO_URI) {
      console.error('MONGO_URI is not set!');
      return res.status(500).json({ 
        success: false,
        error: 'Database not configured',
        message: 'MONGO_URI environment variable is missing'
      });
    }
    
    await connectDB();
    console.log('Database connected');
    
    // Check if job already exists
    const existingJob = await Job.findOne({ jobId: req.body.jobId });
    
    if (existingJob) {
      console.log('Job already exists, updating status');
      // Update the status if different
      if (existingJob.status !== req.body.status) {
        existingJob.status = req.body.status;
        existingJob.lastUpdated = new Date();
        await existingJob.save();
        console.log('Job status updated to:', req.body.status);
      }
      return res.json({ success: true, message: 'Job updated', job: existingJob });
    } else {
      // Create new job
      const newJob = await Job.create({
        jobId: req.body.jobId,
        title: req.body.title,
        company: req.body.company,
        link: req.body.link,
        status: req.body.status || 'saved',
        dateAdded: new Date(),
        lastUpdated: new Date()
      });
      console.log('Job created:', newJob._id);
      return res.json({ success: true, message: 'Job saved', job: newJob });
    }
    
  } catch (err) {
    console.error('=== SAVE JOB ERROR ===');
    console.error('Error message:', err.message);
    console.error('Error stack:', err.stack);
    res.status(500).json({ 
      success: false,
      error: 'Failed to save job',
      message: err.message 
    });
  }
});

// DELETE - Remove a job from tracker
app.delete('/api/jobs/:id', async (req, res) => {
  try {
    await connectDB();
    
    const job = await Job.findByIdAndDelete(req.params.id);
    
    if (!job) {
      return res.status(404).json({ 
        success: false,
        error: 'Job not found' 
      });
    }
    
    res.json({ success: true, message: 'Job deleted' });
  } catch (err) {
    console.error('Delete job error:', err);
    res.status(500).json({ 
      success: false,
      error: 'Failed to delete job',
      message: err.message 
    });
  }
});

// UPDATE - Update job status
app.patch('/api/jobs/:id', async (req, res) => {
  try {
    await connectDB();
    
    const job = await Job.findByIdAndUpdate(
      req.params.id,
      { 
        status: req.body.status,
        lastUpdated: new Date()
      },
      { new: true }
    );
    
    if (!job) {
      return res.status(404).json({ 
        success: false,
        error: 'Job not found' 
      });
    }
    
    res.json({ success: true, job });
  } catch (err) {
    console.error('Update job error:', err);
    res.status(500).json({ 
      success: false,
      error: 'Failed to update job',
      message: err.message 
    });
  }
});

// Initiate Gmail OAuth
app.get('/auth/google', (req, res) => {
  const oauth2Client = getOAuthClient();
  
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/gmail.readonly'],
    prompt: 'consent'
  });
  
  console.log('Redirecting to Google OAuth:', authUrl);
  res.redirect(authUrl);
});

// OAuth Callback
app.get('/auth/google/callback', async (req, res) => {
  try {
    const { code, error } = req.query;
    
    if (error) {
      console.error('OAuth error:', error);
      return res.redirect('/tracker?error=oauth_failed');
    }
    
    if (!code) {
      console.error('No code received from Google');
      return res.redirect('/tracker?error=no_code');
    }
    
    const oauth2Client = getOAuthClient();
    const { tokens } = await oauth2Client.getToken(code);
    
    console.log('OAuth tokens received successfully');

    res.cookie('gmail_tokens', JSON.stringify(tokens), {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
    });

    res.redirect('/tracker?success=gmail_connected');

  } catch (error) {
    console.error('OAuth callback error:', error);
    res.redirect('/tracker?error=connection_failed');
  }
});

// Disconnect Gmail
app.get('/auth/google/disconnect', (req, res) => {
  res.clearCookie('gmail_tokens');
  res.redirect('/tracker?success=gmail_disconnected');
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
      return res.json({ error: 'Not connected', connected: false });
    }

    const tokens = JSON.parse(tokenCookie);
    const oauth2Client = getOAuthClient();
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

    res.json({ updates, connected: true });

  } catch (err) {
    console.error('Email check error:', err);
    
    // Check if token is expired
    if (err.code === 401 || err.message?.includes('invalid_grant')) {
      res.clearCookie('gmail_tokens');
      return res.json({ error: 'Token expired', connected: false });
    }
    
    res.json({ error: 'Failed to check emails', message: err.message, connected: false });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    mongodb: isConnected ? 'connected' : 'disconnected'
  });
});

// Export the Express app for Vercel serverless
module.exports = app;
