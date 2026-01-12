require('dotenv').config();

const express = require('express');
const axios = require('axios');
const { engine } = require('express-handlebars');
const { google } = require('googleapis');
const session = require('express-session');
const cron = require('node-cron');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 5000;

// Session middleware
app.use(session({
    secret: 'your-secret-key-change-this-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }
}));

// Regular middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Setup Handlebars - ONLY ONE TIME!
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

// OAuth2 Configuration
const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    'http://localhost:5000/auth/google/callback'
);

// RapidAPI Configuration
const RAPID_KEY = process.env.RAPID_API_KEY;
const RAPID_HOST = process.env.RAPID_API_HOST;

// Keywords for email detection
const POSITIVE_KEYWORDS = [
    'interview', 'next step', 'move forward', 'schedule a call',
    'congratulations', 'pleased to inform', 'offer', 'would like to speak',
    'phone screen', 'interested in speaking', 'next round', 'schedule',
    'excited to', 'looking forward', 'happy to'
];

const NEGATIVE_KEYWORDS = [
    'unfortunately', 'not moving forward', 'other candidates',
    'not selected', 'regret to inform', 'not be proceeding',
    'different direction', 'more qualified', 'position has been filled',
    'decided to move forward with', 'will not be moving', 'have decided'
];

// ==================== ROUTES ====================

// Home Route
app.get('/', (req, res) => {
    res.render('search', { isSearch: true });
});

// Search Results Route
app.get('/search', async (req, res) => {
    const { q, l, employment_type, remote_jobs_only, job_requirements, date_posted, requires_visa } = req.query;
    
    if (!q) {
        return res.redirect('/');
    }
    
    const searchQuery = l ? `${q} in ${l}` : q;
    
    try {
        const params = {
            query: searchQuery,
            page: '1',
            num_pages: '1',
            date_posted: date_posted || 'all'
        };
        
        if (employment_type) params.employment_types = employment_type;
        if (remote_jobs_only === 'true') params.remote_jobs_only = 'true';
        if (job_requirements) params.job_requirements = job_requirements;
        
        const options = {
            method: 'GET',
            url: 'https://jsearch.p.rapidapi.com/search',
            params: params,
            headers: {
                'x-rapidapi-key': RAPID_KEY,
                'x-rapidapi-host': RAPID_HOST
            }
        };
        
        console.log('Search query:', searchQuery);
        console.log('Applied filters:', params);
        
        const response = await axios.request(options);
        
        res.render('results', { 
            jobs: response.data.data || [],
            query: q,
            location: l || 'Anywhere',
            activeFilters: {
                employment_type,
                remote_jobs_only,
                job_requirements,
                date_posted,
                requires_visa
            }
        });
    } catch (err) {
        console.error("Search error:", err.message);
        res.render('results', { 
            jobs: [],
            error: 'Failed to fetch jobs. Please try again.',
            query: q,
            location: l,
            activeFilters: {}
        });
    }
});

// Tracker Route
app.get('/tracker', (req, res) => {
    res.render('tracker', { isTracker: true });
});

// Gmail Routes
app.get('/connect-gmail', (req, res) => {
    const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: ['https://www.googleapis.com/auth/gmail.readonly'],
        prompt: 'select_account'
    });
    res.redirect(authUrl);
});

app.get('/auth/google/callback', async (req, res) => {
    const { code } = req.query;
    
    if (!code) {
        return res.send('Error: No authorization code received');
    }
    
    try {
        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);
        req.session.tokens = tokens;
        req.session.save();
        
        startEmailMonitoring();
        
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="utf-8">
                <title>Gmail Connected</title>
                <style>
                    body {
                        font-family: Inter, -apple-system, sans-serif;
                        text-align: center;
                        padding: 80px 20px;
                        background: #FAFAFA;
                    }
                    .card {
                        max-width: 500px;
                        margin: 0 auto;
                        background: white;
                        padding: 48px;
                        border-radius: 12px;
                        border: 1px solid #E5E7EB;
                    }
                    h2 { color: #111827; margin-bottom: 16px; }
                    p { color: #6B7280; margin-bottom: 32px; }
                    .btn {
                        display: inline-block;
                        padding: 12px 24px;
                        background: #6366F1;
                        color: white;
                        text-decoration: none;
                        border-radius: 8px;
                        font-weight: 500;
                    }
                </style>
            </head>
            <body>
                <div class="card">
                    <h2>✓ Gmail Connected!</h2>
                    <p>Your job responses will be automatically tracked from your email.</p>
                    <a href="/tracker" class="btn">Go to Tracker</a>
                </div>
            </body>
            </html>
        `);
    } catch (error) {
        console.error('OAuth error:', error);
        res.send(`
            <html>
            <body style="font-family: sans-serif; text-align: center; padding: 60px;">
                <h2>Error connecting Gmail</h2>
                <p>${error.message}</p>
                <a href="/tracker">Back to Tracker</a>
            </body>
            </html>
        `);
    }
});

app.get('/api/gmail-status', (req, res) => {
    const isConnected = req.session.tokens ? true : false;
    res.json({ connected: isConnected });
});

app.get('/api/email-updates', (req, res) => {
    try {
        if (!fs.existsSync('email-updates.json')) {
            return res.json({ updates: [] });
        }
        const data = fs.readFileSync('email-updates.json', 'utf8');
        const lines = data.trim().split('\n').filter(line => line);
        const updates = lines.map(line => JSON.parse(line));
        res.json({ updates });
    } catch (error) {
        res.json({ updates: [] });
    }
});

// ==================== EMAIL FUNCTIONS ====================

async function checkJobEmails() {
    try {
        const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
        
        const response = await gmail.users.messages.list({
            userId: 'me',
            q: 'newer_than:1d (subject:application OR subject:interview OR subject:position OR subject:job OR subject:opportunity)',
            maxResults: 20
        });

        const messages = response.data.messages || [];
        
        if (messages.length === 0) {
            console.log('No new job emails found');
            return;
        }
        
        console.log(`Checking ${messages.length} job-related emails...`);
        
        for (const message of messages) {
            try {
                const email = await gmail.users.messages.get({
                    userId: 'me',
                    id: message.id,
                    format: 'full'
                });

                const headers = email.data.payload.headers;
                const subject = headers.find(h => h.name === 'Subject')?.value || '';
                const from = headers.find(h => h.name === 'From')?.value || '';
                
                const emailDomain = from.match(/@([^>]+)/)?.[1] || '';
                const companyMatch = emailDomain.match(/([^.]+)\./);
                const company = companyMatch ? companyMatch[1] : emailDomain;

                let body = '';
                if (email.data.payload.body.data) {
                    body = Buffer.from(email.data.payload.body.data, 'base64').toString();
                } else if (email.data.payload.parts) {
                    const textPart = email.data.payload.parts.find(
                        part => part.mimeType === 'text/plain' || part.mimeType === 'text/html'
                    );
                    if (textPart && textPart.body.data) {
                        body = Buffer.from(textPart.body.data, 'base64').toString();
                    }
                }

                const text = (subject + ' ' + body).toLowerCase();
                let responseType = null;
                let newStatus = null;

                const hasPositive = POSITIVE_KEYWORDS.some(keyword => text.includes(keyword));
                const hasNegative = NEGATIVE_KEYWORDS.some(keyword => text.includes(keyword));

                if (hasPositive && !hasNegative) {
                    responseType = 'positive';
                    if (text.includes('interview') || text.includes('schedule')) {
                        newStatus = 'interviewing';
                    } else if (text.includes('offer')) {
                        newStatus = 'offered';
                    }
                } else if (hasNegative) {
                    responseType = 'negative';
                    newStatus = 'rejected';
                }

                if (responseType) {
                    console.log(`\n📧 ${responseType.toUpperCase()} response detected`);
                    console.log(`   From: ${from}`);
                    console.log(`   Company: ${company}`);
                    console.log(`   Subject: ${subject}`);
                    
                    const update = {
                        company: company.toLowerCase(),
                        responseType: responseType,
                        newStatus: newStatus,
                        timestamp: new Date().toISOString(),
                        subject: subject,
                        from: from
                    };
                    
                    fs.appendFileSync('email-updates.json', JSON.stringify(update) + '\n');
                    console.log(`   ✓ Saved to email-updates.json`);
                }
            } catch (err) {
                console.error('Error processing email:', err.message);
            }
        }
        
        console.log('\nEmail check complete\n');
    } catch (error) {
        console.error('Error checking emails:', error.message);
    }
}

function startEmailMonitoring() {
    console.log('📧 Email monitoring started');
    setTimeout(() => checkJobEmails(), 2000);
    cron.schedule('*/30 * * * *', () => {
        console.log('\n⏰ Scheduled email check starting...');
        checkJobEmails();
    });
}

app.use((req, res, next) => {
    if (req.session.tokens && !oauth2Client.credentials.access_token) {
        oauth2Client.setCredentials(req.session.tokens);
        startEmailMonitoring();
    }
    next();
});

// ==================== START SERVER ====================

app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));