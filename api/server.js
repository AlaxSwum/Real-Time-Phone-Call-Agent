// Vercel Serverless Function - Real-Time Phone Call Agent
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');

// AI Service imports
const OpenAI = require('openai');

// Deepgram for real-time transcription
const { createClient } = require('@deepgram/sdk');

const app = express();

// Initialize AI clients
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Initialize Deepgram client for real-time transcription
const deepgramApiKey = process.env.DEEPGRAM_API_KEY || '7fba0511f54adc490a379bd27cf84720b71ae433';
console.log('🔑 Deepgram API Key configured:', deepgramApiKey ? `${deepgramApiKey.substring(0, 10)}...` : 'MISSING');
const deepgram = createClient(deepgramApiKey);

// Environment configuration
const NODE_ENV = process.env.NODE_ENV || 'development';

// Security middleware for production
if (NODE_ENV === 'production') {
    console.log('🔒 Applying production security middleware...');
    app.use(helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                styleSrc: ["'self'", "'unsafe-inline'"],
                scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
                scriptSrcAttr: ["'self'", "'unsafe-inline'"],
                imgSrc: ["'self'", "data:", "https:"],
                connectSrc: ["'self'", "ws:", "wss:", "https://api.openai.com"]
            },
        },
        hsts: {
            maxAge: 31536000,
            includeSubDomains: true,
            preload: true
        }
    }));
    console.log('Production security enabled (relaxed CSP for dashboard)');
} else {
    console.log('Development mode - reduced security');
}

// CORS configuration
const corsOptions = {
    origin: NODE_ENV === 'production' 
        ? process.env.ALLOWED_ORIGINS?.split(',') || ['https://yourdomain.com']
        : ['http://localhost:3000', 'http://localhost:3001', 'http://127.0.0.1:3000'],
    credentials: true,
    optionsSuccessStatus: 200
};

app.use(cors(corsOptions));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Debug middleware to log ALL incoming requests
app.use((req, res, next) => {
    const timestamp = new Date().toISOString();
    console.log(`🌐 [${timestamp}] ${req.method} ${req.url}`);
    console.log(`🌐 IP: ${req.ip}`);
    console.log(`🌐 User-Agent: ${req.headers['user-agent']}`);
    if (req.url.includes('voice') || req.url.includes('webhook')) {
        console.log(`🌐 IMPORTANT: Webhook-related request detected!`);
        console.log(`🌐 Headers:`, JSON.stringify(req.headers, null, 2));
    }
    next();
});

// Serve static files from public directory
app.use(express.static('public'));

// Global variables for real-time functionality (simplified for serverless)
let callAnalytics = new Map();

// Intent detection and processing function
async function detectAndProcessIntent(text, callSid) {
    const lowerText = text.toLowerCase();
    let detectedIntent = null;
    let confidence = 0;
    
    // Extract email and meeting details from transcript
    const extractedEmail = extractEmailFromTranscript(text);
    const meetingDetails = extractMeetingDetails(text);
    
    console.log('📧 Email extraction result:', extractedEmail || 'No email found');
    console.log('📅 Meeting details:', meetingDetails);
    
    // Enhanced meeting intent detection with better keyword matching
    const meetingKeywords = [
        'arrange a meeting',
        'set up a meeting', 
        'schedule a meeting',
        'schedule meeting',
        'have a meeting',
        'going to have a meeting',
        'would like to schedule',
        'want to schedule',
        'like to schedule',
        'arrange a medium',
        'set up a medium',
        'schedule a medium',
        'meeting on',
        'meeting at', 
        'meeting next',
        'a meeting',
        'medium on',
        'medium at',
        'medium next',
        'would like to meet',
        'want to meet',
        'let\'s meet',
        'discuss',
        'catch up',
        'get together',
        'resignation',
        'about my resignation'
    ];
    
    const meetingIndividualKeywords = [
        'arrange',
        'schedule', 
        'meeting',
        'meet',
        'discuss',
        'appointment',
        'consultation'
    ];
    
    console.log('🔍 Checking meeting keywords against transcript:', text);
    console.log('🔍 Lowercase text:', lowerText);
    
    const meetingMatch = meetingKeywords.some(keyword => {
        const found = lowerText.includes(keyword);
        if (found) {
            console.log(`✅ Found meeting phrase: "${keyword}" in text: "${lowerText}"`);
        }
        return found;
    });
    
    const individualMatch = meetingIndividualKeywords.some(keyword => {
        const found = lowerText.includes(keyword);
        if (found) {
            console.log(`✅ Found meeting keyword: "${keyword}" in text: "${lowerText}"`);
        }
        return found;
    });
    
    const finalMeetingMatch = meetingMatch || individualMatch;
    console.log('🔍 Meeting keywords matched:', finalMeetingMatch);
    
    // Support intent detection
    const supportKeywords = ['help', 'support', 'problem', 'issue', 'trouble', 'assistance'];
    const supportMatch = supportKeywords.some(keyword => lowerText.includes(keyword));
    
    // Information intent detection
    const infoKeywords = ['information', 'info', 'details', 'tell me', 'what is', 'how much', 'price'];
    const infoMatch = infoKeywords.some(keyword => lowerText.includes(keyword));
    
    // Determine primary intent with higher confidence for meetings
    if (finalMeetingMatch) {
        detectedIntent = 'meeting_discussion';
        confidence = meetingMatch ? 0.95 : 0.85;
    } else if (supportMatch) {
        detectedIntent = 'support_request';
        confidence = 0.75;
    } else if (infoMatch) {
        detectedIntent = 'information_request';
        confidence = 0.7;
    } else {
        detectedIntent = 'general_inquiry';
        confidence = 0.5;
    }
    
    console.log(`🎯 INTENT DETECTED: ${detectedIntent} (${Math.round(confidence * 100)}% confidence)`);
    
    // Store analytics for this call
    callAnalytics.set(callSid, {
        intent: detectedIntent,
        confidence: confidence,
        transcript: text,
        extractedEmail: extractedEmail,
        meetingDetails: meetingDetails,
        timestamp: new Date().toISOString()
    });
    
    // Send enhanced data to n8n webhook if configured
    if (process.env.N8N_WEBHOOK_URL) {
        console.log(`🔗 Sending enhanced intent data to n8n: ${detectedIntent}`);
        
        const sendToN8N = async () => {
            try {
                const webhookData = {
                    type: 'intent_detection',
                    callSid: callSid,
                    intent: detectedIntent,
                    confidence: confidence,
                    transcript: text,
                    extractedEmail: extractedEmail,
                    fallbackEmail: 'swumpyaealax@gmail.com',
                    emailStatus: extractedEmail ? 'found' : 'not_found',
                    meetingDetails: meetingDetails,
                    timestamp: new Date().toISOString(),
                    keywords_matched: getMatchedKeywords(lowerText, detectedIntent),
                    hasEmail: !!extractedEmail,
                    hasDateTime: meetingDetails.hasDateTime,
                    urgency: confidence > 0.8 ? 'high' : confidence > 0.6 ? 'medium' : 'low'
                };
                
                console.log(`📤 Sending webhook data:`, JSON.stringify(webhookData, null, 2));
                
                const response = await fetch(process.env.N8N_WEBHOOK_URL, {
                    method: 'POST',
                    headers: { 
                        'Content-Type': 'application/json',
                        'Accept': 'application/json'
                    },
                    body: JSON.stringify(webhookData)
                });

                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }
                
                console.log(`✅ Enhanced intent data sent to n8n (${response.status}): ${detectedIntent}`);
                const responseText = await response.text();
                console.log(`📡 N8N Response:`, responseText);
            } catch (error) {
                console.error('❌ Error sending intent to n8n:', error.message);
            }
        };
        
        sendToN8N();
    }
}

// Basic health check endpoint
app.get('/health', (req, res) => {
    const healthCheck = {
        status: 'healthy', 
        timestamp: new Date().toISOString(),
        environment: NODE_ENV,
        services: {
            deepgram: {
                configured: !!(process.env.DEEPGRAM_API_KEY || deepgramApiKey),
                status: 'operational'
            },
            openai: {
                configured: !!process.env.OPENAI_API_KEY,
                status: 'operational'
            }
        },
        server: {
            platform: 'vercel_serverless',
            uptime: process.uptime(),
            memory: process.memoryUsage()
        }
    };
    
    res.json(healthCheck);
});

// Root endpoint - serve dashboard
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../public', 'index.html'));
});

// API info endpoint
app.get('/api', (req, res) => {
    res.json({
        message: 'Real-Time Call Processor API (Serverless)',
        version: '2.0.0-serverless',
        environment: NODE_ENV,
        platform: 'vercel',
        endpoints: {
            health: '/health',
            voice_webhook: '/voice',
            dashboard: '/',
            documentation: 'https://github.com/AlaxSwum/Real-Time-Phone-Call-Agent'
        }
    });
});

// Helper endpoint to get Twilio webhook URL
app.get('/twilio-config', (req, res) => {
    try {
        const protocol = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
        const host = req.headers['x-forwarded-host'] || req.headers['host'] || req.hostname;
        const webhookUrl = `${protocol}://${host}/voice`;
        
        console.log(`📋 Twilio config requested by ${req.ip}`);
        console.log(`🔗 Generated webhook URL: ${webhookUrl}`);
        
        res.json({
            status: 'success',
            webhook_url: webhookUrl,
            current_host: host,
            protocol: protocol,
            instructions: [
                "1. Go to your Twilio Console (https://console.twilio.com/)",
                "2. Navigate to Phone Numbers > Manage > Active numbers",
                "3. Click on your phone number",
                `4. Set the webhook URL to: ${webhookUrl}`,
                "5. Set HTTP method to POST",
                "6. Save the configuration"
            ],
            bridge_mode: {
                enabled: !!process.env.BRIDGE_TARGET_NUMBER,
                target_number: process.env.BRIDGE_TARGET_NUMBER || "Not configured"
            },
            environment: {
                node_env: NODE_ENV,
                platform: 'vercel_serverless',
                twilio_configured: !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN),
                openai_configured: !!process.env.OPENAI_API_KEY,
                deepgram_configured: !!(process.env.DEEPGRAM_API_KEY || deepgramApiKey),
                n8n_configured: !!process.env.N8N_WEBHOOK_URL
            },
            note: "WebSocket streaming not available in serverless mode - using HTTP-only transcription",
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('❌ Error in /twilio-config:', error);
        res.status(500).json({
            error: 'Internal server error',
            message: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Simple debug endpoint
app.get('/debug', (req, res) => {
    res.json({
        status: 'Server is running (Serverless)',
        timestamp: new Date().toISOString(),
        environment: NODE_ENV,
        platform: 'vercel_serverless',
        bridge_configured: !!process.env.BRIDGE_TARGET_NUMBER,
        bridge_target: process.env.BRIDGE_TARGET_NUMBER || 'Not set',
        endpoints_available: [
            '/',
            '/api',
            '/health', 
            '/twilio-config',
            '/debug',
            '/voice',
            '/webhook/voice',
            '/webhook/recording'
        ],
        deployment_version: 'VERCEL-SERVERLESS-V1',
        headers: req.headers,
        url: req.url,
        method: req.method,
        ip: req.ip
    });
});

// Voice webhook endpoints (both supported for compatibility)
app.post('/voice', (req, res) => {
    console.log('✅ /voice endpoint called - CORRECT endpoint!');
    handleVoiceWebhook(req, res);
});

app.post('/webhook/voice', (req, res) => {
    console.log('⚠️ /webhook/voice endpoint called - legacy endpoint, but still working');
    handleVoiceWebhook(req, res);
});

// Webhook for recording completion (bridge mode)
app.post('/webhook/recording', async (req, res) => {
    console.log('🎵 Bridge call recording completed:', req.body);
    
    const { RecordingUrl, CallSid, RecordingDuration, RecordingSid } = req.body;
    
    console.log(`🎵 Recording URL: ${RecordingUrl}`);
    console.log(`⏱️ Duration: ${RecordingDuration} seconds`);
    console.log(`🆔 Recording SID: ${RecordingSid}`);
    
    // Process the bridge call recording with AI
    if (RecordingUrl && RecordingDuration > 2) {
        console.log('🚀 Starting AI analysis of bridge call recording...');
        
        try {
            // For serverless, we'll do simplified analysis
            const analysisResult = {
                transcript: "Recording analysis not yet implemented in serverless mode",
                processed: false,
                timestamp: new Date().toISOString()
            };
            
            console.log('✅ Bridge call analysis completed:', analysisResult);
            
            // Send bridge call analysis to n8n
            if (process.env.N8N_WEBHOOK_URL) {
                const bridgeWebhookData = {
                    type: 'bridge_call_analysis',
                    callSid: CallSid,
                    recordingUrl: RecordingUrl,
                    duration: RecordingDuration,
                    analysis: analysisResult,
                    timestamp: new Date().toISOString()
                };
                
                fetch(process.env.N8N_WEBHOOK_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(bridgeWebhookData)
                }).then(response => {
                    console.log('✅ Bridge call analysis sent to n8n:', response.status);
                }).catch(error => {
                    console.error('❌ Error sending bridge analysis to n8n:', error);
                });
            }
            
        } catch (error) {
            console.error('❌ Bridge call analysis failed:', error);
        }
    }
    
    res.status(200).send('OK');
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('ERROR Unhandled error:', err);
    res.status(500).json({
        error: NODE_ENV === 'production' ? 'Internal server error' : err.message,
        timestamp: new Date().toISOString()
    });
});

// 404 handler (MUST BE LAST)
app.use('*', (req, res) => {
    res.status(404).json({
        error: 'Endpoint not found',
        path: req.originalUrl,
        available_endpoints: [
            '/',
            '/api', 
            '/health',
            '/twilio-config',
            '/debug',
            '/voice',
            '/webhook/voice',
            '/webhook/recording'
        ],
        note: "WebSocket endpoints not available in serverless mode"
    });
});

// Voice webhook handler function
function handleVoiceWebhook(req, res) {
    console.log('🔥 WEBHOOK CALLED:', req.url);
    console.log('🔥 WEBHOOK METHOD:', req.method);
    console.log('🔥 WEBHOOK HEADERS:', JSON.stringify(req.headers, null, 2));
    console.log('🔥 WEBHOOK BODY:', JSON.stringify(req.body, null, 2));
    
    const { CallSid, From, To, CallStatus } = req.body;
    console.log('📞 Incoming call received from Twilio');
    console.log(`📞 Call from ${From} to ${To} (${req.body.Direction})`);
    console.log(`🆔 Call SID: ${CallSid}`);
    
    // Get the current host dynamically
    const protocol = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
    const host = req.headers['x-forwarded-host'] || req.headers['host'] || req.hostname;
    
    console.log(`🔗 Detected host: ${host}`);
    
    // Check if this is a bridge call
    const bridgeNumber = process.env.BRIDGE_TARGET_NUMBER;
    
    if (bridgeNumber) {
        console.log(`🌉 Bridge mode: Connecting ${From} to ${bridgeNumber}`);
        
        // TwiML for bridge mode with recording (no real-time streaming in serverless)
        const bridgeTwiML = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">Connecting your call, please wait...</Say>
    <Dial 
        record="true" 
        recordingStatusCallback="${protocol}://${host}/webhook/recording"
        timeout="30"
        callerId="${From}">
        <Number>${bridgeNumber}</Number>
    </Dial>
    <Say voice="alice">The call could not be connected. Please try again later.</Say>
</Response>`;
        
        console.log('🌉 Bridge TwiML Response:', bridgeTwiML);
        res.type('text/xml');
        res.send(bridgeTwiML);
        
    } else {
        console.log('🎙️ Recording mode (serverless - no real-time streaming)');
        
        // TwiML response for recording-based analysis
        const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">Your call is being recorded for analysis.</Say>
    <Record 
        recordingStatusCallback="${protocol}://${host}/webhook/recording"
        maxLength="300"
        playBeep="false"
        finishOnKey="#"
        action="${protocol}://${host}/webhook/recording"
    />
    <Say voice="alice">Thank you for your call.</Say>
</Response>`;
        
        console.log('📋 TwiML Response:', twimlResponse);
        res.type('text/xml');
        res.send(twimlResponse);
    }
}

// Helper functions for email extraction and meeting details
function extractEmailFromTranscript(transcript) {
    const text = transcript.toLowerCase();
    
    // Try normal email pattern first
    const normalEmailRegex = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
    const normalEmail = text.match(normalEmailRegex);
    if (normalEmail && normalEmail[0]) {
        return validateAndCleanEmail(normalEmail[0]);
    }
    
    // Enhanced spoken email pattern
    let spokenPattern = text
        .replace(/\s+at\s+/gi, '@')
        .replace(/\s+dot\s+/gi, '.')
        .replace(/\s+dash\s+/gi, '-')
        .replace(/\s+underscore\s+/gi, '_')
        .replace(/\s+token\s*/gi, '.com')
        .replace(/\s+talking\s*/gi, '.com')
        .replace(/\s+common\s*/gi, '.com')
        .replace(/\s+calm\s*/gi, '.com')
        .replace(/gmail\s+(token|talking|common|calm)/gi, 'gmail.com')
        .replace(/outlook\s+(token|talking|common|calm)/gi, 'outlook.com')
        .replace(/yahoo\s+(token|talking|common|calm)/gi, 'yahoo.com');
    
    const spokenEmail = spokenPattern.match(normalEmailRegex);
    if (spokenEmail && spokenEmail[0]) {
        return validateAndCleanEmail(spokenEmail[0]);
    }
    
    return null;
}

function validateAndCleanEmail(email) {
    if (!email) return null;
    
    let cleanEmail = email
        .replace(/\s+/g, '')
        .toLowerCase()
        .trim();
    
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    
    if (emailRegex.test(cleanEmail)) {
        return cleanEmail;
    }
    
    return null;
}

function extractMeetingDetails(transcript) {
    const text = transcript.toLowerCase();
    
    const datePatterns = [
        /next\s+(week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)/gi,
        /(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+next\s+week/gi,
        /(tomorrow|today)/gi
    ];
    
    const timePatterns = [
        /(\d{1,2}):?(\d{2})?\s*(am|pm|a\.m\.|p\.m\.)/gi,
        /(\d{1,2})\s+(o'clock|oclock)/gi
    ];
    
    let extractedDate = null;
    let extractedTime = null;
    
    for (const pattern of datePatterns) {
        const match = text.match(pattern);
        if (match) {
            extractedDate = match[0];
            break;
        }
    }
    
    for (const pattern of timePatterns) {
        const match = text.match(pattern);
        if (match) {
            extractedTime = match[0];
            break;
        }
    }
    
    return {
        date: extractedDate,
        time: extractedTime,
        hasDateTime: !!(extractedDate || extractedTime)
    };
}

function getMatchedKeywords(lowerText, intent) {
    const keywordSets = {
        meeting_discussion: [
            'arrange a meeting', 'set up a meeting', 'schedule a meeting', 'schedule meeting',
            'have a meeting', 'going to have a meeting', 'would like to schedule', 'want to schedule',
            'arrange', 'schedule', 'meeting', 'meet', 'appointment', 'consultation'
        ],
        support_request: ['help', 'support', 'problem', 'issue', 'trouble', 'assistance'],
        information_request: ['information', 'info', 'details', 'tell me', 'what is', 'how much', 'price'],
        general_inquiry: []
    };
    
    const keywords = keywordSets[intent] || [];
    return keywords.filter(keyword => lowerText.includes(keyword));
}

// Export for Vercel
module.exports = app; 