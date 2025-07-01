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
const twilio = require('twilio');

const app = express();
const server = http.createServer(app);

// Deepgram configuration
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || 'c34944ade6ce11abf235534d7b5619b09d771f16';
console.log('🔧 Initializing Deepgram client...');
const deepgram = createClient(DEEPGRAM_API_KEY);
console.log('✅ Deepgram client initialized');

// Twilio configuration (optional for auto-dial)
let twilioClient = null;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;

if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
    console.log('🔧 Initializing Twilio client for auto-dial...');
    twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
    console.log('✅ Twilio client initialized');
} else {
    console.log('⚠️ Twilio credentials not configured - auto-dial disabled');
}

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
    // Railway always uses HTTPS, force it for production
    const protocol = process.env.NODE_ENV === 'production' ? 'https' : (req.secure ? 'https' : 'http');
    const host = req.get('host');
    // Temporarily disable streaming to focus on audio-only
    // const streamUrl = `${protocol === 'https' ? 'wss' : 'ws'}://${host}/deepgram?conference=${conferenceId}`;
    
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
            record="false"
            startConferenceOnEnter="true"
            endConferenceOnExit="false"
            waitUrl=""
            beep="false"
            muted="false"
            region="ireland"
            maxParticipants="10">
            ${conferenceId}
        </Conference>
    </Dial>
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
    try {
        const { CallSid, From, To } = req.body;
        const conferenceId = req.query.conference || `conf-${CallSid}`;
        
        console.log(`👥 Participant joining: ${From} → ${conferenceId}`);
        console.log(`🔍 Request details:`, {
            CallSid,
            From,
            To,
            query: req.query,
            conferenceId
        });
        
        // Validate conference exists
        if (!activeConferences.has(conferenceId)) {
            console.log(`⚠️ Conference not found: ${conferenceId}`);
            console.log(`📋 Active conferences:`, Array.from(activeConferences.keys()));
        }
        
        // Railway always uses HTTPS, force it for production  
        const protocol = process.env.NODE_ENV === 'production' ? 'https' : (req.secure ? 'https' : 'http');
        
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">Joining the conference now.</Say>
    <Dial>
        <Conference 
            statusCallback="${protocol}://${req.get('host')}/conference-events"
            statusCallbackEvent="start,end,join,leave"
            startConferenceOnEnter="true"
            endConferenceOnExit="false"
            waitUrl=""
            beep="false"
            muted="false"
            region="ireland"
            maxParticipants="10">
            ${conferenceId}
        </Conference>
    </Dial>
</Response>`;
        
        console.log(`📜 Participant TwiML:`, twiml);
        
        // Update conference info
        if (activeConferences.has(conferenceId)) {
            const conf = activeConferences.get(conferenceId);
            conf.participants++;
            activeConferences.set(conferenceId, conf);
            console.log(`📊 Conference updated: ${conf.participants} participants`);
        }
        
        res.type('text/xml').send(twiml);
        console.log(`✅ Participant TwiML sent successfully`);
        
    } catch (error) {
        console.error(`❌ Participant endpoint error:`, error);
        
        // Send error response TwiML
        const errorTwiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">Sorry, there was an error joining the conference. Please try again.</Say>
    <Hangup/>
</Response>`;
        
        res.type('text/xml').send(errorTwiml);
    }
});

// Auto-dial function
async function dialParticipant(conferenceId, participantNumber, req) {
    if (!twilioClient) {
        console.log('⚠️ Auto-dial skipped: Twilio client not configured');
        return;
    }
    
    try {
        // Railway always uses HTTPS, force it for production
        const protocol = process.env.NODE_ENV === 'production' ? 'https' : (req.secure ? 'https' : 'http');
        const host = req.get('host');
        const participantUrl = `${protocol}://${host}/participant?conference=${conferenceId}`;
        
        console.log(`📱 Auto-dialing participant: ${participantNumber} → ${conferenceId}`);
        console.log(`🔗 Participant URL: ${participantUrl}`);
        
        // Make actual Twilio call
        const call = await twilioClient.calls.create({
            to: participantNumber,
            from: process.env.TWILIO_PHONE_NUMBER || '+441733964789', // Your Twilio number
            url: participantUrl,
            method: 'POST',
            statusCallback: `${protocol}://${host}/call-status`,
            statusCallbackMethod: 'POST'
        });
        
        console.log(`✅ Auto-dial initiated: ${call.sid} → ${participantNumber}`);
        console.log(`🔗 Participant will join conference: ${conferenceId}`);
        
        // Update conference info
        if (activeConferences.has(conferenceId)) {
            const conf = activeConferences.get(conferenceId);
            conf.outboundCallSid = call.sid;
            conf.participantNumber = participantNumber;
            activeConferences.set(conferenceId, conf);
        }
        
    } catch (error) {
        console.error('❌ Auto-dial error:', error.message);
        console.error('🔍 Check: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER');
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
    console.log(`🔍 Stream URL: ${req.url}`);
    console.log(`🔍 Conference ID extracted: ${conferenceId}`);
    
    if (conferenceId === 'unknown') {
        console.log(`⚠️ WARNING: Conference ID not found in stream URL`);
        console.log(`🔍 Full URL breakdown:`, {
            pathname: url.pathname,
            search: url.search,
            searchParams: Object.fromEntries(url.searchParams.entries())
        });
    }
    
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
                        
                        // Debug: Log audio reception every 50 packets
                        if (data.sequenceNumber && parseInt(data.sequenceNumber) % 50 === 0) {
                            console.log(`🎵 Audio packet #${data.sequenceNumber} received (${audioBuffer.length} bytes)`);
                        }
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
    const { ConferenceSid, StatusCallbackEvent, CallSid, Muted, Hold } = req.body;
    console.log(`🎪 Conference event: ${StatusCallbackEvent} for ${ConferenceSid}`);
    console.log(`🔍 Event details:`, { CallSid, Muted, Hold, timestamp: new Date().toISOString() });
    
    switch (StatusCallbackEvent) {
        case 'conference-start':
            console.log(`🎬 Conference started: ${ConferenceSid}`);
            break;
        case 'conference-end':
            console.log(`🏁 Conference ended: ${ConferenceSid}`);
            activeConferences.delete(ConferenceSid);
            break;
        case 'participant-join':
            console.log(`👋 Participant joined: ${CallSid} (Muted: ${Muted}, Hold: ${Hold})`);
            
            // Log conference status
            const confKey = Array.from(activeConferences.keys()).find(key => key.includes(ConferenceSid.replace('CF', 'CA')));
            if (confKey) {
                const conf = activeConferences.get(confKey);
                console.log(`📊 Conference ${confKey} now has ${conf.participants} participants`);
                
                if (conf.participants >= 2) {
                    console.log(`🎯 CONFERENCE READY: Both participants should be able to hear each other!`);
                }
            }
                    break;
        case 'participant-leave':
            console.log(`👋 Participant left: ${CallSid}`);
            break;
    }
    
    res.sendStatus(200);
});

// Handle call status updates
app.post('/call-status', (req, res) => {
    const { CallSid, CallStatus, Direction } = req.body;
    console.log(`📞 Call status: ${CallSid} → ${CallStatus} (${Direction})`);
    
    switch (CallStatus) {
        case 'ringing':
            console.log(`📞 Auto-dial ringing: ${CallSid}`);
                            break;
        case 'answered':
            console.log(`✅ Auto-dial answered: ${CallSid}`);
            break;
        case 'completed':
            console.log(`📞 Auto-dial completed: ${CallSid}`);
            break;
        case 'failed':
        case 'busy':
        case 'no-answer':
            console.log(`❌ Auto-dial failed: ${CallSid} (${CallStatus})`);
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
        features: ['twilio-conference', 'deepgram-streaming', 'real-time-transcription', 'auto-dial'],
        configuration: {
            deepgram: !!DEEPGRAM_API_KEY,
            twilio: !!twilioClient,
            participant_number: !!PARTICIPANT_NUMBER,
            auto_dial_enabled: !!(twilioClient && PARTICIPANT_NUMBER)
        },
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

// Test participant endpoint
app.get('/test/participant', (req, res) => {
    const conferenceId = req.query.conference || 'test-conference-123';
    
    // Railway always uses HTTPS, force it for production
    const protocol = process.env.NODE_ENV === 'production' ? 'https' : (req.secure ? 'https' : 'http');
    
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">This is a test of the participant endpoint. Conference ID is ${conferenceId}.</Say>
    <Dial>
        <Conference 
            statusCallback="${protocol}://${req.get('host')}/conference-events"
            statusCallbackEvent="start,end,join,leave"
            startConferenceOnEnter="true"
            beep="false"
            muted="false"
            region="ireland">
            ${conferenceId}
        </Conference>
    </Dial>
</Response>`;
        
    console.log(`🧪 Test participant endpoint called with conference: ${conferenceId}`);
    res.type('text/xml').send(twiml);
});

// Test conference audio endpoint
app.post('/test/conference-audio', (req, res) => {
    const conferenceId = req.body.conferenceId || 'test-audio-conf';
    
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">Testing audio. You should be able to hear and speak in this conference.</Say>
    <Dial>
        <Conference 
            startConferenceOnEnter="true"
            endConferenceOnExit="false"
            beep="false"
            muted="false"
            region="ireland"
            waitUrl="">
            ${conferenceId}
        </Conference>
    </Dial>
</Response>`;
        
    console.log(`🎵 Audio test for conference: ${conferenceId}`);
    res.type('text/xml').send(twiml);
});

// Simple audio test endpoint
app.get('/test/simple-conference', (req, res) => {
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">You are joining a simple test conference. Speak to test your audio.</Say>
    <Dial>
        <Conference 
            startConferenceOnEnter="true"
            endConferenceOnExit="false"
            beep="false"
            muted="false"
            region="ireland"
            waitUrl="">
            simple-test-conference
        </Conference>
    </Dial>
</Response>`;
        
    console.log(`🧪 Simple conference test accessed`);
    res.type('text/xml').send(twiml);
});

// Debug audio endpoint - creates two separate calls to same conference
app.get('/test/debug-audio/:conferenceId?', (req, res) => {
    const conferenceId = req.params.conferenceId || `debug-${Date.now()}`;
    
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">Debug test. Conference ID is ${conferenceId}. You should hear yourself if you call this twice.</Say>
    <Dial>
        <Conference 
            startConferenceOnEnter="true"
            endConferenceOnExit="false"
            beep="true"
            muted="false"
            region="ireland"
            waitUrl="">
            ${conferenceId}
        </Conference>
    </Dial>
</Response>`;
    
    console.log(`🔧 Audio debug test for conference: ${conferenceId}`);
    res.type('text/xml').send(twiml);
});

// ============================================================================
// BRIDGE-BASED ALTERNATIVE (Direct call connection)
// ============================================================================

// Bridge approach - directly connect calls instead of conference
app.post('/webhook-bridge', (req, res) => {
    const { CallSid, From, To } = req.body;
    console.log(`🌉 Bridge approach - Incoming call: ${From} → ${To} (${CallSid})`);
    
    // Store call info
    activeConferences.set(CallSid, {
        callSid: CallSid,
        caller: From,
        startTime: new Date(),
        mode: 'bridge'
    });
    
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">Connecting you directly to the other participant.</Say>
    <Dial>
        <Number statusCallback="https://real-time-phone-call-agent-production.up.railway.app/call-status">+447494225623</Number>
    </Dial>
</Response>`;
    
    console.log(`🌉 Bridge TwiML sent for: ${CallSid}`);
    res.type('text/xml').send(twiml);
});

// Simple test conference with different settings
app.get('/test/minimal-conference', (req, res) => {
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">Minimal conference test.</Say>
    <Dial>
        <Conference 
            startConferenceOnEnter="true"
            endConferenceOnExit="true"
            beep="false"
            muted="false">
            minimal-test-${Date.now()}
        </Conference>
    </Dial>
</Response>`;
    
    console.log(`🧪 Minimal conference test accessed`);
    res.type('text/xml').send(twiml);
});

// Conference with enhanced debugging
app.post('/webhook-debug', (req, res) => {
    const { CallSid, From, To } = req.body;
    console.log(`🔍 DEBUG webhook - Incoming call: ${From} → ${To} (${CallSid})`);
    console.log(`🔍 Full request body:`, req.body);
    
    const conferenceId = `debug-conf-${CallSid}`;
    const protocol = process.env.NODE_ENV === 'production' ? 'https' : 'http';
    const host = req.get('host');
    
    // Store conference info
    activeConferences.set(conferenceId, {
        callSid: CallSid,
        caller: From,
        startTime: new Date(),
        participants: 1,
        debug: true
    });
    
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">Debug conference. You should hear a beep when someone joins.</Say>
    <Dial>
        <Conference 
            statusCallback="${protocol}://${host}/conference-events"
            statusCallbackEvent="start,end,join,leave"
            startConferenceOnEnter="true"
            endConferenceOnExit="false"
            beep="true"
            muted="false"
            region="ireland">
            ${conferenceId}
        </Conference>
    </Dial>
</Response>`;
    
    console.log(`🔍 Debug conference created: ${conferenceId}`);
    res.type('text/xml').send(twiml);
    
    // Auto-dial with delay
    if (process.env.PARTICIPANT_NUMBER) {
        setTimeout(() => {
            console.log(`🔍 DEBUG: Auto-dialing ${process.env.PARTICIPANT_NUMBER}`);
            dialParticipantDebug(conferenceId, process.env.PARTICIPANT_NUMBER, req);
        }, 3000);
    }
});

// Debug auto-dial function
async function dialParticipantDebug(conferenceId, participantNumber, req) {
    if (!twilioClient) {
        console.log('🔍 DEBUG: No Twilio client available');
        return;
    }
    
    try {
        const protocol = process.env.NODE_ENV === 'production' ? 'https' : 'http';
        const host = req.get('host');
        const participantUrl = `${protocol}://${host}/participant-debug?conference=${conferenceId}`;
        
        console.log(`🔍 DEBUG: Auto-dialing ${participantNumber} to ${participantUrl}`);
        
        const call = await twilioClient.calls.create({
            to: participantNumber,
            from: process.env.TWILIO_PHONE_NUMBER || '+441733964789',
            url: participantUrl,
            method: 'POST'
        });
        
        console.log(`🔍 DEBUG: Call created ${call.sid}`);
        
    } catch (error) {
        console.error('🔍 DEBUG: Auto-dial error:', error);
    }
}

// Debug participant endpoint
app.post('/participant-debug', (req, res) => {
    const { CallSid, From, To } = req.body;
    const conferenceId = req.query.conference;
    
    console.log(`🔍 DEBUG: Participant joining conference ${conferenceId}`);
    console.log(`🔍 DEBUG: From ${From}, To ${To}, CallSid ${CallSid}`);
    
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">Debug participant joining. Listen for beep.</Say>
    <Dial>
        <Conference 
            startConferenceOnEnter="true"
            endConferenceOnExit="false"
            beep="true"
            muted="false"
            region="ireland">
            ${conferenceId}
        </Conference>
    </Dial>
</Response>`;
    
    console.log(`🔍 DEBUG: Participant TwiML sent`);
    res.type('text/xml').send(twiml);
});

// ============================================================================
// ALTERNATIVE CONFERENCE APPROACH
// ============================================================================

// Alternative conference approach with different settings
app.post('/webhook-alt', (req, res) => {
    const { CallSid, From, To } = req.body;
    console.log(`🔄 Alternative conference - Incoming call: ${From} → ${To} (${CallSid})`);
    
    const conferenceId = `alt-conf-${CallSid}`;
    const protocol = process.env.NODE_ENV === 'production' ? 'https' : 'http';
    const host = req.get('host');
    
    // Store conference info
    activeConferences.set(conferenceId, {
        callSid: CallSid,
        caller: From,
        startTime: new Date(),
        participants: 1,
        alternative: true
    });
    
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">Alternative conference setup. Please wait for the other participant.</Say>
    <Dial>
        <Conference 
            statusCallback="${protocol}://${host}/conference-events"
            statusCallbackEvent="start,end,join,leave"
            startConferenceOnEnter="true"
            endConferenceOnExit="true"
            beep="true"
            muted="false"
            hold="false"
            region="dublin"
            record="do-not-record">
            ${conferenceId}
        </Conference>
    </Dial>
</Response>`;
    
    console.log(`🔄 Alternative conference created: ${conferenceId}`);
    res.type('text/xml').send(twiml);
    
    // Auto-dial participant if configured
    if (process.env.PARTICIPANT_NUMBER) {
        setTimeout(() => {
            dialParticipantAlt(conferenceId, process.env.PARTICIPANT_NUMBER, req);
        }, 2000);
    }
});

// Alternative auto-dial function
async function dialParticipantAlt(conferenceId, participantNumber, req) {
    if (!twilioClient) {
        console.log('🔄 ALT: No Twilio client available');
        return;
    }
    
    try {
        const protocol = process.env.NODE_ENV === 'production' ? 'https' : 'http';
        const host = req.get('host');
        const participantUrl = `${protocol}://${host}/participant-alt?conference=${conferenceId}`;
        
        console.log(`🔄 ALT: Auto-dialing ${participantNumber} to ${participantUrl}`);
        
        const call = await twilioClient.calls.create({
            to: participantNumber,
            from: process.env.TWILIO_PHONE_NUMBER || '+441733964789',
            url: participantUrl,
            method: 'POST'
        });
        
        console.log(`🔄 ALT: Call created ${call.sid}`);
        
    } catch (error) {
        console.error('🔄 ALT: Auto-dial error:', error);
    }
}

// Alternative participant endpoint
app.post('/participant-alt', (req, res) => {
    const { CallSid, From, To } = req.body;
    const conferenceId = req.query.conference;
    
    console.log(`🔄 ALT: Participant joining conference ${conferenceId}`);
    
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">Joining alternative conference now.</Say>
    <Dial>
        <Conference 
            startConferenceOnEnter="true"
            endConferenceOnExit="true"
            beep="true"
            muted="false"
            hold="false"
            region="dublin"
            record="do-not-record">
            ${conferenceId}
        </Conference>
    </Dial>
</Response>`;
    
    console.log(`🔄 ALT: Participant TwiML sent`);
    res.type('text/xml').send(twiml);
});

// ============================================================================
// SERVER STARTUP
// ============================================================================

server.listen(PORT, () => {
    console.log(`🚀 Conference Transcription Server running on port ${PORT}`);
    console.log(`🎯 Architecture: Deepgram + Conference (Railway optimized)`);
    console.log(`📊 Code size: ~300 lines (reduced from 4000+)`);
    console.log(`🔑 Deepgram API: ${DEEPGRAM_API_KEY ? 'Configured' : 'Missing'}`);
    console.log(`📞 Twilio Client: ${twilioClient ? 'Configured' : 'Not configured'}`);
    console.log(`📱 Auto-dial participant: ${PARTICIPANT_NUMBER || 'Not configured'}`);
    console.log(`🎯 Auto-dial status: ${(twilioClient && PARTICIPANT_NUMBER) ? 'ENABLED' : 'DISABLED'}`);
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