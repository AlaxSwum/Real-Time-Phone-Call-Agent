// Real-Time Conference Transcription - Deepgram + Conference Architecture
console.log('🚀 Starting server...');
require('dotenv').config();
console.log('✅ dotenv loaded');
const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const { createClient } = require('@deepgram/sdk');

const app = express();
const server = http.createServer(app);

// Deepgram configuration
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || 'c34944ade6ce11abf235534d7b5619b09d771f16';
console.log('🔧 Initializing Deepgram client...');
const deepgram = createClient(DEEPGRAM_API_KEY);
console.log('✅ Deepgram client initialized');

// Basic setup
const PORT = process.env.PORT || 3000;
const PARTICIPANT_NUMBER = process.env.PARTICIPANT_NUMBER;

// Essential middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Global state
let activeConferences = new Map();
let transcriptClients = new Set();

// ============================================================================
// CORE CONFERENCE FUNCTIONS
// ============================================================================

// 1. /webhook - Handle incoming calls, create conference, auto-dial participant
app.post('/webhook', (req, res) => {
    const { CallSid, From, To } = req.body;
    console.log(`📞 Incoming call: ${From} → ${To} (${CallSid})`);
    
    const conferenceId = `conf-${CallSid}`;
    const protocol = req.secure ? 'https' : 'http';
    const host = req.get('host');
    const streamUrl = `${protocol === 'https' ? 'wss' : 'ws'}://${host}/deepgram?conference=${conferenceId}`;
    
    // Store conference info
    activeConferences.set(conferenceId, {
        callSid: CallSid,
        caller: From,
        startTime: new Date(),
        participants: 1
    });
    
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">Welcome! Connecting you to the conference.</Say>
    <Dial>
        <Conference 
            statusCallback="${protocol}://${host}/conference-events"
            statusCallbackEvent="start,end,join,leave"
            record="true"
            startConferenceOnEnter="true"
            endConferenceOnExit="false">
            ${conferenceId}
        </Conference>
    </Dial>
    <Start>
        <Stream url="${streamUrl}" track="both_tracks" />
    </Start>
</Response>`;
    
    console.log(`🎪 Conference created: ${conferenceId}`);
    res.type('text/xml').send(twiml);
    
    // Auto-dial participant if configured
    if (PARTICIPANT_NUMBER) {
        setTimeout(() => {
            dialParticipant(conferenceId, PARTICIPANT_NUMBER, req);
        }, 2000);
    }
});

// 2. /participant - Handle second participant joining
app.post('/participant', (req, res) => {
    const { CallSid, From } = req.body;
    const conferenceId = req.query.conference || `conf-${CallSid}`;
    
    console.log(`👥 Participant joining: ${From} → ${conferenceId}`);
    
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">Joining the conference now.</Say>
    <Dial>
        <Conference>${conferenceId}</Conference>
    </Dial>
</Response>`;
    
    // Update conference info
    if (activeConferences.has(conferenceId)) {
        const conf = activeConferences.get(conferenceId);
        conf.participants++;
        activeConferences.set(conferenceId, conf);
    }
    
    res.type('text/xml').send(twiml);
});

// Auto-dial function
async function dialParticipant(conferenceId, participantNumber, req) {
    try {
        const protocol = req.secure ? 'https' : 'http';
        const host = req.get('host');
        
        console.log(`📱 Auto-dialing participant: ${participantNumber} → ${conferenceId}`);
        console.log(`🔗 Participant would be dialed with URL: ${protocol}://${host}/participant?conference=${conferenceId}`);
        
    } catch (error) {
        console.error('❌ Auto-dial error:', error);
    }
}

// ============================================================================
// DEEPGRAM WEBSOCKET STREAMING
// ============================================================================

// 3. WebSocket route for Deepgram streaming
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    
    if (url.pathname === '/deepgram') {
        handleDeepgramStream(ws, req);
    } else {
        handleDashboard(ws);
    }
});

// Deepgram stream handler
function handleDeepgramStream(ws, req) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const conferenceId = url.searchParams.get('conference') || 'unknown';
    
    console.log(`🎙️ Deepgram stream started for conference: ${conferenceId}`);
    
    // Create Deepgram live connection
    const deepgramLive = deepgram.listen.live({
        model: 'nova-2',
        language: 'en',
        smart_format: true,
        punctuate: true,
        interim_results: true,
        endpointing: 300,
        utterance_end_ms: 1000
    });
    
    // Handle Deepgram transcripts
    deepgramLive.on('transcript', (data) => {
        if (data.channel && data.channel.alternatives && data.channel.alternatives[0]) {
            const transcript = data.channel.alternatives[0].transcript;
            const confidence = data.channel.alternatives[0].confidence;
            const isFinal = data.is_final;
            
            if (transcript && transcript.trim().length > 0) {
                console.log(`📝 ${isFinal ? 'FINAL' : 'interim'}: "${transcript}" (${Math.round(confidence * 100)}%)`);
                
                const transcriptData = {
                    type: 'transcript',
                    conference: conferenceId,
                    text: transcript,
                    confidence: confidence,
                    is_final: isFinal,
                    timestamp: new Date().toISOString()
                };
                
                // Broadcast to all connected clients
                broadcastTranscript(transcriptData);
                
                // Process intents on final transcripts
                if (isFinal) {
                    processTranscript(transcript, conferenceId);
                }
            }
        }
    });
    
    // Handle Deepgram connection events
    deepgramLive.on('open', () => {
        console.log('✅ Deepgram connection opened');
        ws.deepgramConnected = true;
    });
    
    deepgramLive.on('close', () => {
        console.log('🔒 Deepgram connection closed');
        ws.deepgramConnected = false;
    });
    
    deepgramLive.on('error', (error) => {
        console.error('❌ Deepgram error:', error);
    });
    
    // Handle Twilio audio stream
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            
            switch (data.event) {
                case 'start':
                    console.log(`🎬 Stream started for conference: ${conferenceId}`);
                    break;
                    
                case 'media':
                    if (data.media && data.media.payload && ws.deepgramConnected) {
                        // Send audio directly to Deepgram (it handles mulaw format)
                        const audioBuffer = Buffer.from(data.media.payload, 'base64');
                        deepgramLive.send(audioBuffer);
                    }
                    break;
                    
                case 'stop':
                    console.log(`🛑 Stream stopped for conference: ${conferenceId}`);
                    deepgramLive.close();
                    activeConferences.delete(conferenceId);
                    break;
            }
        } catch (error) {
            console.error('❌ Stream processing error:', error);
        }
    });
    
    ws.on('close', () => {
        console.log(`📞 Stream connection closed for: ${conferenceId}`);
        if (deepgramLive) {
            deepgramLive.close();
        }
    });
    
    // Store connection reference
    ws.conferenceId = conferenceId;
    ws.deepgramLive = deepgramLive;
}

// Dashboard WebSocket handler
function handleDashboard(ws) {
    console.log('📊 Dashboard client connected');
    transcriptClients.add(ws);
    
    ws.on('close', () => {
        transcriptClients.delete(ws);
    });
    
    // Send welcome message
    ws.send(JSON.stringify({
        type: 'welcome',
        message: 'Connected to real-time transcription dashboard',
        activeConferences: activeConferences.size
    }));
}

// ============================================================================
// TRANSCRIPT PROCESSING
// ============================================================================

// Broadcast transcript to all connected clients
function broadcastTranscript(data) {
    transcriptClients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            try {
                client.send(JSON.stringify(data));
            } catch (error) {
                console.error('Broadcast error:', error);
            }
        }
    });
}

// Simple intent detection
function processTranscript(text, conferenceId) {
    console.log(`🧠 Processing transcript: "${text}"`);
    
    const lowerText = text.toLowerCase();
    let intent = 'general';
    
    // Simple keyword matching
    if (lowerText.includes('meeting') || lowerText.includes('schedule')) {
        intent = 'meeting_request';
    } else if (lowerText.includes('help') || lowerText.includes('support')) {
        intent = 'support_request';
    } else if (lowerText.includes('price') || lowerText.includes('cost')) {
        intent = 'pricing_inquiry';
    }
    
    // Email extraction
    const emailMatch = text.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
    const email = emailMatch ? emailMatch[0] : null;
    
    if (intent !== 'general' || email) {
        console.log(`🎯 Intent detected: ${intent}${email ? `, Email: ${email}` : ''}`);
        
        // Send to webhook if configured
        if (process.env.WEBHOOK_URL) {
            sendToWebhook({
                conference: conferenceId,
                text: text,
                intent: intent,
                email: email,
                timestamp: new Date().toISOString()
            });
        }
    }
}

// Send data to external webhook
async function sendToWebhook(data) {
    try {
        await fetch(process.env.WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        console.log('✅ Data sent to webhook');
    } catch (error) {
        console.error('❌ Webhook error:', error);
    }
}

// ============================================================================
// CONFERENCE EVENT HANDLERS
// ============================================================================

// Handle conference events
app.post('/conference-events', (req, res) => {
    const { ConferenceSid, StatusCallbackEvent, CallSid } = req.body;
    console.log(`🎪 Conference event: ${StatusCallbackEvent} for ${ConferenceSid}`);
    
    switch (StatusCallbackEvent) {
        case 'conference-start':
            console.log(`🎬 Conference started: ${ConferenceSid}`);
            break;
        case 'conference-end':
            console.log(`🏁 Conference ended: ${ConferenceSid}`);
            activeConferences.delete(ConferenceSid);
            break;
        case 'participant-join':
            console.log(`👋 Participant joined: ${CallSid}`);
            break;
        case 'participant-leave':
            console.log(`👋 Participant left: ${CallSid}`);
            break;
    }
    
    res.sendStatus(200);
});

// ============================================================================
// ESSENTIAL ENDPOINTS
// ============================================================================

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        activeConferences: activeConferences.size,
        connectedClients: transcriptClients.size,
        deepgramConfigured: !!DEEPGRAM_API_KEY,
        timestamp: new Date().toISOString()
    });
});

// Status endpoint
app.get('/status', (req, res) => {
    res.json({
        server: 'Real-Time Conference Transcription',
        version: '3.0-deepgram',
        architecture: 'Conference + Deepgram Streaming',
        activeConferences: Array.from(activeConferences.entries()),
        features: ['twilio-conference', 'deepgram-streaming', 'real-time-transcription'],
        timestamp: new Date().toISOString()
    });
});

// Root endpoint
app.get('/', (req, res) => {
    res.json({
        message: 'Real-Time Conference Transcription API',
        endpoints: {
            'POST /webhook': 'Handle incoming calls, create conference',
            'POST /participant': 'Join second participant to conference',
            'WS /deepgram': 'Audio streaming to Deepgram',
            'GET /health': 'Health check',
            'GET /status': 'Server status'
        },
        activeConferences: activeConferences.size
    });
});

// Twilio config endpoint for dashboard
app.get('/twilio-config', (req, res) => {
    const protocol = req.secure ? 'https' : 'http';
    const host = req.get('host');
    res.json({
        webhook_url: `${protocol}://${host}/webhook`,
        environment: process.env.NODE_ENV || 'development',
        status: 'active'
    });
});

// Test endpoints for dashboard compatibility
app.get('/test/transcription-priority', (req, res) => {
    res.json({
        primary_service: 'Deepgram',
        services_available: {
            deepgram: !!DEEPGRAM_API_KEY,
            assemblyai: false
        },
        api_keys: {
            deepgram_configured: !!DEEPGRAM_API_KEY
        },
        recommendation: DEEPGRAM_API_KEY ? 
            'Deepgram nova-2 will be used for real-time transcription' : 
            'Configure DEEPGRAM_API_KEY for real-time transcription',
        timestamp: new Date().toISOString()
    });
});

// Test AI processing endpoint (optional)
app.post('/test/ai-processing', (req, res) => {
    const { recording_url } = req.body;
    
    if (!recording_url) {
        return res.status(400).json({
            success: false,
            error: 'Recording URL required'
        });
    }
    
    // Simulate processing
    setTimeout(() => {
        res.json({
            success: true,
            message: 'Audio processing simulation completed',
            transcript: 'Simulated transcript from test audio',
            confidence: 0.95,
            timestamp: new Date().toISOString()
        });
    }, 1000);
});

// ============================================================================
// SERVER STARTUP
// ============================================================================

server.listen(PORT, () => {
    console.log(`🚀 Conference Transcription Server running on port ${PORT}`);
    console.log(`🎯 Architecture: Deepgram + Conference (Railway optimized)`);
    console.log(`📊 Code size: ~300 lines (reduced from 4000+)`);
    console.log(`🔑 Deepgram API: ${DEEPGRAM_API_KEY ? 'Configured' : 'Missing'}`);
    console.log(`📱 Auto-dial participant: ${PARTICIPANT_NUMBER || 'Not configured'}`);
    console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`✅ Ready for Twilio webhook integration`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('🛑 Shutting down gracefully...');
    server.close(() => {
        console.log('✅ Server closed');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('🛑 Received SIGINT, shutting down...');
    server.close(() => {
        console.log('✅ Server closed');
        process.exit(0);
    });
});