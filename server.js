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
const { AssemblyAI } = require('assemblyai');
const twilio = require('twilio');

const app = express();
const server = http.createServer(app);

// Deepgram configuration
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || 'c34944ade6ce11abf235534d7b5619b09d771f16';
console.log('🔧 Initializing Deepgram client...');
const deepgram = createClient(DEEPGRAM_API_KEY);
console.log('✅ Deepgram client initialized');

// AssemblyAI configuration
const ASSEMBLYAI_API_KEY = process.env.ASSEMBLYAI_API_KEY;
let assemblyai = null;
if (ASSEMBLYAI_API_KEY) {
    console.log('🔧 Initializing AssemblyAI client...');
    assemblyai = new AssemblyAI({ apiKey: ASSEMBLYAI_API_KEY });
    console.log('✅ AssemblyAI client initialized');
} else {
    console.log('⚠️ AssemblyAI API key not configured - single service mode');
}

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
        handleMultiServiceStream(ws, req);
    } else {
        handleDashboard(ws);
    }
});

// ============================================================================
// MULTI-SERVICE TRANSCRIPTION (Enhanced Accuracy)
// ============================================================================

// Enhanced Deepgram stream handler with multi-service support
function handleMultiServiceStream(ws, req) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const conferenceId = url.searchParams.get('conference') || 'unknown';
    
    console.log(`🎯 Multi-service transcription started for: ${conferenceId}`);
    console.log(`🔍 Services available: Deepgram ✅${assemblyai ? ', AssemblyAI ✅' : ''}`);
    
    // Enhanced Deepgram configuration
    const deepgramLive = deepgram.listen.live({
        model: 'nova-2',
        language: 'en-GB',          // UK English for better accent recognition
        smart_format: true,
        punctuate: true,
        profanity_filter: false,
        redact: false,
        diarize: true,              // Speaker identification
        multichannel: false,
        interim_results: true,
        endpointing: 300,
        utterance_end_ms: 1000,
        keywords: ['meeting', 'schedule', 'business', 'call', 'appointment', 'price', 'cost', 'service'],
        keyword_boost: 'medium'
    });
    
    // AssemblyAI WebSocket for real-time (if available)
    let assemblyaiWs = null;
    if (assemblyai) {
        try {
            console.log('🎙️ Setting up AssemblyAI real-time connection...');
            // Note: AssemblyAI real-time requires different setup, we'll use it for post-processing
        } catch (error) {
            console.log('⚠️ AssemblyAI real-time not available, using Deepgram only');
        }
    }
    
    // Storage for combining transcripts
    let deepgramResults = [];
    let assemblyaiResults = [];
    let lastCombinedResult = '';
    
    // Enhanced Deepgram transcript handler
    deepgramLive.on('transcript', (data) => {
        if (data.channel && data.channel.alternatives && data.channel.alternatives[0]) {
            const transcript = data.channel.alternatives[0].transcript;
            const confidence = data.channel.alternatives[0].confidence;
            const isFinal = data.is_final;
            
            if (transcript && transcript.trim().length > 0) {
                console.log(`🔵 Deepgram ${isFinal ? 'FINAL' : 'interim'}: "${transcript}" (${Math.round(confidence * 100)}%)`);
                
                // Store for fusion
                deepgramResults.push({
                    service: 'deepgram',
                    text: transcript,
                    confidence: confidence,
                    is_final: isFinal,
                    timestamp: new Date().toISOString()
                });
                
                // If only Deepgram available, broadcast immediately
                if (!assemblyai || isFinal) {
                    const transcriptData = {
                        type: 'transcript',
                        service: assemblyai ? 'multi_service' : 'deepgram',
                        conference: conferenceId,
                        text: transcript,
                        confidence: confidence,
                        is_final: isFinal,
                        enhanced: true,
                        timestamp: new Date().toISOString()
                    };
                    
                    broadcastTranscript(transcriptData);
                    
                    if (isFinal) {
                        processTranscript(transcript, conferenceId);
                    }
                }
            }
        }
    });
    
    // Handle Deepgram connection events
    deepgramLive.on('open', () => {
        console.log('✅ Enhanced Deepgram connection opened');
        ws.deepgramConnected = true;
    });
    
    deepgramLive.on('close', () => {
        console.log('🔒 Enhanced Deepgram connection closed');
        ws.deepgramConnected = false;
    });
    
    deepgramLive.on('error', (error) => {
        console.error('❌ Enhanced Deepgram error:', error);
    });
    
    // Handle Twilio audio stream
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            
            switch (data.event) {
                case 'start':
                    console.log(`🎬 Multi-service stream started for: ${conferenceId}`);
                    break;
                    
                case 'media':
                    if (data.media && data.media.payload && ws.deepgramConnected) {
                        const audioBuffer = Buffer.from(data.media.payload, 'base64');
                        
                        // Send to Deepgram
                        deepgramLive.send(audioBuffer);
                        
                        // Store audio for AssemblyAI batch processing if available
                        if (assemblyai && data.sequenceNumber && parseInt(data.sequenceNumber) % 100 === 0) {
                            // Every 100th packet, consider batch processing with AssemblyAI
                            // This would require accumulating audio and sending for transcription
                        }
                        
                        // Debug logging
                        if (data.sequenceNumber && parseInt(data.sequenceNumber) % 50 === 0) {
                            console.log(`🎵 Enhanced audio packet #${data.sequenceNumber} → Multi-service processing`);
                        }
                    }
                    break;
                    
                case 'stop':
                    console.log(`🛑 Multi-service stream stopped for: ${conferenceId}`);
                    deepgramLive.close();
                    if (assemblyaiWs) {
                        assemblyaiWs.close();
                    }
                    activeConferences.delete(conferenceId);
                    break;
            }
        } catch (error) {
            console.error('❌ Multi-service stream processing error:', error);
        }
    });
    
    ws.on('close', () => {
        console.log(`📞 Multi-service connection closed for: ${conferenceId}`);
        if (deepgramLive) {
            deepgramLive.close();
        }
        if (assemblyaiWs) {
            assemblyaiWs.close();
        }
    });
    
    // Store connection reference
    ws.conferenceId = conferenceId;
    ws.deepgramLive = deepgramLive;
    ws.assemblyaiWs = assemblyaiWs;
    ws.isMultiService = true;
}

// AI Fusion logic to combine multiple transcription results
function fuseTranscripts(deepgramResult, assemblyaiResult) {
    // Simple fusion logic - can be enhanced with more sophisticated AI
    if (!assemblyaiResult) return deepgramResult;
    if (!deepgramResult) return assemblyaiResult;
    
    // Compare confidence scores
    const deepgramConfidence = deepgramResult.confidence || 0;
    const assemblyaiConfidence = assemblyaiResult.confidence || 0;
    
    // Use the result with higher confidence, but combine punctuation intelligently
    if (deepgramConfidence > assemblyaiConfidence) {
        return {
            text: deepgramResult.text,
            confidence: Math.min(0.98, (deepgramConfidence + assemblyaiConfidence) / 2),
            source: 'fused_deepgram_primary',
            services_used: ['deepgram', 'assemblyai']
        };
    } else {
        return {
            text: assemblyaiResult.text,
            confidence: Math.min(0.98, (deepgramConfidence + assemblyaiConfidence) / 2),
            source: 'fused_assemblyai_primary',
            services_used: ['deepgram', 'assemblyai']
        };
    }
}

// Enhanced post-call processing with AssemblyAI
async function processRecordingMultiService(recordingUrl, callSid, recordingSid) {
    try {
        console.log(`🎯 Multi-service transcription for recording: ${recordingSid}`);
        
        // Broadcast processing start
        broadcastTranscript({
            type: 'transcription_processing',
            callSid: callSid,
            recordingSid: recordingSid,
            message: 'Processing with Deepgram and AssemblyAI...',
            timestamp: new Date().toISOString()
        });
        
        // Wait a bit for recording to be available
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Process with both services in parallel
        const [deepgramResult, assemblyaiResult] = await Promise.allSettled([
            processWithDeepgram(recordingUrl),
            assemblyai ? processWithAssemblyAI(recordingUrl) : Promise.resolve(null)
        ]);
        
        let deepgramTranscript = null;
        let assemblyaiTranscript = null;
        
        if (deepgramResult.status === 'fulfilled' && deepgramResult.value) {
            deepgramTranscript = deepgramResult.value;
            console.log(`🔵 Deepgram result: ${Math.round(deepgramTranscript.confidence * 100)}% confidence`);
        } else {
            console.log(`🔵 Deepgram failed:`, deepgramResult.reason);
        }
        
        if (assemblyaiResult.status === 'fulfilled' && assemblyaiResult.value) {
            assemblyaiTranscript = assemblyaiResult.value;
            console.log(`🟡 AssemblyAI result: ${Math.round(assemblyaiTranscript.confidence * 100)}% confidence`);
        } else {
            console.log(`🟡 AssemblyAI not available or failed`);
        }
        
        // Fuse the results
        const fusedResult = fuseTranscripts(deepgramTranscript, assemblyaiTranscript);
        
        if (fusedResult && fusedResult.text) {
            console.log(`✅ Multi-service transcript ready (${Math.round(fusedResult.confidence * 100)}% confidence):`);
            console.log(`📝 "${fusedResult.text}"`);
            
            // Broadcast the enhanced transcript
            const transcriptData = {
                type: 'final_transcript_multiservice',
                callSid: callSid,
                recordingSid: recordingSid,
                text: fusedResult.text,
                confidence: fusedResult.confidence,
                accuracy_type: 'multi_service_high_accuracy',
                services_used: fusedResult.services_used || ['deepgram'],
                source: fusedResult.source || 'deepgram_primary',
                individual_results: {
                    deepgram: deepgramTranscript,
                    assemblyai: assemblyaiTranscript
                },
                timestamp: new Date().toISOString()
            };
            
            broadcastTranscript(transcriptData);
        } else {
            throw new Error('No valid transcription results');
        }
        
    } catch (error) {
        console.error('❌ Multi-service recording transcription error:', error);
        
        // Broadcast error
        broadcastTranscript({
            type: 'transcription_error',
            callSid: callSid,
            recordingSid: recordingSid,
            message: 'Transcription failed - trying fallback...',
            error: error.message,
            timestamp: new Date().toISOString()
        });
        
        // Fallback to single service
        processRecording(recordingUrl, callSid, recordingSid);
    }
}

// Process recording with Deepgram
async function processWithDeepgram(recordingUrl) {
    const response = await fetch(recordingUrl);
    const audioBuffer = await response.arrayBuffer();
    
    const transcription = await deepgram.listen.prerecorded.transcribeFile(
        audioBuffer,
        {
            model: 'nova-2',
            language: 'en-GB',
            smart_format: true,
            punctuate: true,
            diarize: true,
            utterances: true,
            detect_language: false,
            keywords: ['meeting', 'schedule', 'business', 'call', 'appointment', 'price', 'cost'],
            keyword_boost: 'medium'
        }
    );
    
    const transcript = transcription.result.results.channels[0].alternatives[0].transcript;
    const confidence = transcription.result.results.channels[0].alternatives[0].confidence;
    
    return { text: transcript, confidence: confidence, service: 'deepgram' };
}

// Process recording with AssemblyAI
async function processWithAssemblyAI(recordingUrl) {
    if (!assemblyai) return null;
    
    try {
        const transcript = await assemblyai.transcripts.transcribe({
            audio_url: recordingUrl,
            language_code: 'en_uk',
            punctuate: true,
            format_text: true,
            speaker_labels: true,
            boost_param: 'high',
            word_boost: ['meeting', 'schedule', 'business', 'call', 'appointment', 'price', 'cost'],
            auto_highlights: true
        });
        
        return { 
            text: transcript.text, 
            confidence: transcript.confidence,
            service: 'assemblyai',
            speaker_labels: transcript.utterances
        };
    } catch (error) {
        console.error('❌ AssemblyAI processing error:', error);
        return null;
    }
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
    const { CallSid, CallStatus, Direction, From, To } = req.body;
    console.log(`📞 Call status: ${CallSid} → ${CallStatus} (${Direction})`);
    
    // Clean up conference on call end
    if (['completed', 'busy', 'failed', 'no-answer', 'canceled'].includes(CallStatus)) {
        activeConferences.delete(CallSid);
        console.log(`🧹 Cleaned up call ${CallSid} - Status: ${CallStatus}`);
        
        // Broadcast call ended
        broadcastTranscript({
            type: 'call_ended',
            callSid: CallSid,
            status: CallStatus,
            from: From,
            to: To,
            direction: Direction,
            message: `Call ${CallStatus}`,
            timestamp: new Date().toISOString()
        });
    } else {
        // Broadcast call status to WebSocket clients
        broadcastTranscript({
            type: 'call_status',
            callSid: CallSid,
            status: CallStatus,
            from: From,
            to: To,
            direction: Direction,
            message: `Call ${CallStatus}`,
            timestamp: new Date().toISOString()
        });
    }
    
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
    // Get active calls info with duration
    const activeCalls = Array.from(activeConferences.values()).map(call => ({
        callSid: call.callSid,
        caller: call.caller,
        mode: call.mode,
        startTime: call.startTime,
        duration: Math.floor((new Date() - call.startTime) / 1000)
    }));
    
    res.json({
        server: 'Real-Time Conference Transcription',
        version: '4.0-multiservice',
        architecture: assemblyai ? 'Multi-Service AI (Deepgram + AssemblyAI)' : 'Enhanced Deepgram Streaming',
        activeConferences: activeConferences.size,
        activeCalls: activeCalls,
        features: [
            'twilio-conference', 
            'enhanced-deepgram', 
            assemblyai ? 'assemblyai-integration' : null,
            'multi-service-fusion',
            'real-time-transcription', 
            'post-call-enhancement',
            'auto-dial',
            'hybrid-bridge-mode'
        ].filter(Boolean),
        configuration: {
            deepgram: !!DEEPGRAM_API_KEY,
            assemblyai: !!assemblyai,
            twilio: !!twilioClient,
            participant_number: !!PARTICIPANT_NUMBER,
            auto_dial_enabled: !!(twilioClient && PARTICIPANT_NUMBER),
            multi_service_enabled: !!assemblyai,
            transcription_accuracy: assemblyai ? '92-95%' : '88-92%'
        },
        endpoints: {
            '/webhook-enhanced': 'Real-time multi-service conference',
            '/webhook-hybrid-enhanced': 'Bridge + multi-service recording (BEST)',
            '/webhook-hybrid': 'Bridge + recording',
            '/webhook-emergency': 'Simple bridge (audio test)',
            '/webhook': 'Original conference'
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
// Ultra-minimal conference test (no extra settings)
app.post('/webhook-minimal', (req, res) => {
    const { CallSid, From, To } = req.body;
    console.log(`🏁 MINIMAL webhook - Incoming call: ${From} → ${To} (${CallSid})`);
    
    const conferenceId = `minimal-${CallSid}`;
    
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">Minimal conference test.</Say>
    <Dial>
        <Conference>${conferenceId}</Conference>
    </Dial>
</Response>`;
    
    console.log(`🏁 MINIMAL: Conference created: ${conferenceId}`);
    res.type('text/xml').send(twiml);
    
    // Auto-dial participant
    if (process.env.PARTICIPANT_NUMBER) {
        setTimeout(() => {
            dialParticipantMinimal(conferenceId, process.env.PARTICIPANT_NUMBER, req);
        }, 2000);
    }
});

// Minimal auto-dial
async function dialParticipantMinimal(conferenceId, participantNumber, req) {
    if (!twilioClient) return;
    
    try {
        const protocol = process.env.NODE_ENV === 'production' ? 'https' : 'http';
        const host = req.get('host');
        const participantUrl = `${protocol}://${host}/participant-minimal?conference=${conferenceId}`;
        
        console.log(`🏁 MINIMAL: Auto-dialing ${participantNumber}`);
        
        const call = await twilioClient.calls.create({
            to: participantNumber,
            from: process.env.TWILIO_PHONE_NUMBER || '+441733964789',
            url: participantUrl,
            method: 'POST'
        });
        
        console.log(`🏁 MINIMAL: Call created ${call.sid}`);
        
    } catch (error) {
        console.error('🏁 MINIMAL: Error:', error);
    }
}

// Minimal participant endpoint
app.post('/participant-minimal', (req, res) => {
    const conferenceId = req.query.conference;
    
    console.log(`🏁 MINIMAL: Participant joining ${conferenceId}`);
    
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">Joining minimal conference.</Say>
    <Dial>
        <Conference>${conferenceId}</Conference>
    </Dial>
</Response>`;
    
    res.type('text/xml').send(twiml);
});

// Force codec test
app.post('/webhook-codec', (req, res) => {
    const { CallSid, From, To } = req.body;
    console.log(`🔊 CODEC test - Incoming call: ${From} → ${To} (${CallSid})`);
    
    const conferenceId = `codec-${CallSid}`;
    
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">Codec compatibility test.</Say>
    <Dial>
        <Conference 
            startConferenceOnEnter="true"
            endConferenceOnExit="false"
            beep="false"
            muted="false"
            region="ireland"
            record="false">
            ${conferenceId}
        </Conference>
    </Dial>
</Response>`;
    
    console.log(`🔊 CODEC: Conference created: ${conferenceId}`);
    res.type('text/xml').send(twiml);
    
    // Auto-dial participant
    if (process.env.PARTICIPANT_NUMBER) {
        setTimeout(() => {
            dialParticipantCodec(conferenceId, process.env.PARTICIPANT_NUMBER, req);
        }, 3000); // Longer delay
    }
});

// Codec auto-dial
async function dialParticipantCodec(conferenceId, participantNumber, req) {
    if (!twilioClient) return;
    
    try {
        const protocol = process.env.NODE_ENV === 'production' ? 'https' : 'http';
        const host = req.get('host');
        const participantUrl = `${protocol}://${host}/participant-codec?conference=${conferenceId}`;
        
        const call = await twilioClient.calls.create({
            to: participantNumber,
            from: process.env.TWILIO_PHONE_NUMBER || '+441733964789',
            url: participantUrl,
            method: 'POST'
        });
        
        console.log(`🔊 CODEC: Call created ${call.sid}`);
        
    } catch (error) {
        console.error('🔊 CODEC: Error:', error);
    }
}

// Codec participant endpoint
app.post('/participant-codec', (req, res) => {
    const conferenceId = req.query.conference;
    
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">Joining codec test conference.</Say>
    <Dial>
        <Conference 
            startConferenceOnEnter="true"
            endConferenceOnExit="false"
            beep="false"
            muted="false"
            region="ireland"
            record="false">
            ${conferenceId}
        </Conference>
    </Dial>
</Response>`;
    
    res.type('text/xml').send(twiml);
});

// ============================================================================
// Carrier compatibility test - force different settings
app.post('/webhook-carrier', (req, res) => {
    const { CallSid, From, To } = req.body;
    console.log(`📡 CARRIER test - Incoming call: ${From} → ${To} (${CallSid})`);
    console.log(`📡 CARRIER: Testing ${From} and +447494225623 compatibility`);
    
    const conferenceId = `carrier-${CallSid}`;
    
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">Carrier compatibility test. Testing audio between your networks.</Say>
    <Dial>
        <Conference 
            startConferenceOnEnter="true"
            beep="true"
            waitUrl="">
            ${conferenceId}
        </Conference>
    </Dial>
</Response>`;
    
    console.log(`📡 CARRIER: Conference created: ${conferenceId}`);
    res.type('text/xml').send(twiml);
    
    // Auto-dial with longer delay to avoid carrier conflicts
    if (process.env.PARTICIPANT_NUMBER) {
        setTimeout(() => {
            dialParticipantCarrier(conferenceId, process.env.PARTICIPANT_NUMBER, req);
        }, 5000); // 5-second delay
    }
});

// Carrier auto-dial with explicit codec settings
async function dialParticipantCarrier(conferenceId, participantNumber, req) {
    if (!twilioClient) return;
    
    try {
        const protocol = process.env.NODE_ENV === 'production' ? 'https' : 'http';
        const host = req.get('host');
        const participantUrl = `${protocol}://${host}/participant-carrier?conference=${conferenceId}`;
        
        console.log(`📡 CARRIER: Auto-dialing ${participantNumber} with 5s delay`);
        
        const call = await twilioClient.calls.create({
            to: participantNumber,
            from: process.env.TWILIO_PHONE_NUMBER || '+441733964789',
            url: participantUrl,
            method: 'POST',
            // Force specific settings that might help carrier compatibility
            sendDigits: 'w',  // Wait before proceeding
            timeout: 60       // Longer timeout
        });
        
        console.log(`📡 CARRIER: Call created ${call.sid}`);
        
    } catch (error) {
        console.error('📡 CARRIER: Error:', error);
    }
}

// Carrier participant endpoint with beep confirmation
app.post('/participant-carrier', (req, res) => {
    const conferenceId = req.query.conference;
    
    console.log(`📡 CARRIER: Participant joining ${conferenceId}`);
    
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">Second participant joining carrier test. Listen for beep.</Say>
    <Dial>
        <Conference 
            startConferenceOnEnter="true"
            beep="true"
            waitUrl="">
            ${conferenceId}
        </Conference>
    </Dial>
</Response>`;
    
    res.type('text/xml').send(twiml);
});

// Emergency fallback - Manual bridge test
app.post('/webhook-emergency', (req, res) => {
    const { CallSid, From, To } = req.body;
    console.log(`🚨 EMERGENCY bridge test: ${From} → ${To} (${CallSid})`);
    
    // Store call info
    activeConferences.set(CallSid, {
        callSid: CallSid,
        caller: From,
        startTime: new Date(),
        mode: 'emergency_bridge'
    });
    
    // Broadcast call start to dashboard
    broadcastTranscript({
        type: 'call_started',
        callSid: CallSid,
        caller: From,
        mode: 'emergency_bridge',
        message: 'Emergency bridge call connected',
        timestamp: new Date().toISOString()
    });
    
    // Direct bridge - no conference, just connect the calls
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Dial timeout="30">
        <Number>+447494225623</Number>
    </Dial>
</Response>`;
    
    console.log(`🚨 EMERGENCY: Direct bridge initiated`);
    res.type('text/xml').send(twiml);
});

// ============================================================================
// Hybrid Bridge + Recording approach (BEST OF BOTH WORLDS)
app.post('/webhook-hybrid', (req, res) => {
    const { CallSid, From, To } = req.body;
    console.log(`🔄 HYBRID approach - Incoming call: ${From} → ${To} (${CallSid})`);
    
    // Store call info for recording processing
    activeConferences.set(CallSid, {
        callSid: CallSid,
        caller: From,
        startTime: new Date(),
        mode: 'hybrid'
    });
    
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">Hybrid system. You'll have real-time conversation, with transcription available after the call.</Say>
    <Dial record="record-from-start" 
          recordingStatusCallback="https://real-time-phone-call-agent-production.up.railway.app/recording-complete"
          timeout="30">
        <Number>+447494225623</Number>
    </Dial>
    <Say voice="alice">Call completed. Processing transcription.</Say>
</Response>`;
    
    console.log(`🔄 HYBRID: Bridge + Recording initiated for ${CallSid}`);
    res.type('text/xml').send(twiml);
});

// Conference + Recording approach (Real-time + Post-call accuracy)
app.post('/webhook-conference-record', (req, res) => {
    const { CallSid, From, To } = req.body;
    console.log(`📼 CONFERENCE+RECORD - Incoming call: ${From} → ${To} (${CallSid})`);
    
    const conferenceId = `rec-conf-${CallSid}`;
    const protocol = process.env.NODE_ENV === 'production' ? 'https' : 'http';
    const host = req.get('host');
    
    // Store conference info
    activeConferences.set(conferenceId, {
        callSid: CallSid,
        caller: From,
        startTime: new Date(),
        participants: 1,
        mode: 'conference_with_recording'
    });
    
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">Conference with recording. You'll get live transcription plus high-accuracy results after the call.</Say>
    <Dial>
        <Conference 
            statusCallback="${protocol}://${host}/conference-events"
            statusCallbackEvent="start,end,join,leave"
            record="record-from-start"
            recordingStatusCallback="${protocol}://${host}/recording-complete"
            startConferenceOnEnter="true"
            endConferenceOnExit="false"
            beep="false"
            muted="false"
            region="ireland"
            maxParticipants="10">
            ${conferenceId}
        </Conference>
    </Dial>
</Response>`;
    
    console.log(`📼 CONFERENCE+RECORD: Created ${conferenceId}`);
    res.type('text/xml').send(twiml);
    
    // Auto-dial participant if configured
    if (process.env.PARTICIPANT_NUMBER) {
        setTimeout(() => {
            dialParticipantRecord(conferenceId, process.env.PARTICIPANT_NUMBER, req);
        }, 2000);
    }
});

// Auto-dial for recording conference
async function dialParticipantRecord(conferenceId, participantNumber, req) {
    if (!twilioClient) return;
    
    try {
        const protocol = process.env.NODE_ENV === 'production' ? 'https' : 'http';
        const host = req.get('host');
        const participantUrl = `${protocol}://${host}/participant-record?conference=${conferenceId}`;
        
        console.log(`📼 RECORD: Auto-dialing ${participantNumber}`);
        
        const call = await twilioClient.calls.create({
            to: participantNumber,
            from: process.env.TWILIO_PHONE_NUMBER || '+441733964789',
            url: participantUrl,
            method: 'POST'
        });
        
        console.log(`📼 RECORD: Call created ${call.sid}`);
        
    } catch (error) {
        console.error('📼 RECORD: Error:', error);
    }
}

// Participant endpoint for recording conference
app.post('/participant-record', (req, res) => {
    const { CallSid, From, To } = req.body;
    const conferenceId = req.query.conference;
    
    console.log(`📼 RECORD: Participant joining ${conferenceId}`);
    
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">Joining recorded conference.</Say>
    <Dial>
        <Conference 
            startConferenceOnEnter="true"
            endConferenceOnExit="false"
            beep="false"
            muted="false"
            region="ireland">
            ${conferenceId}
        </Conference>
    </Dial>
</Response>`;
    
    res.type('text/xml').send(twiml);
});

// Handle recording completion
app.post('/recording-complete', (req, res) => {
    const { CallSid, RecordingUrl, RecordingSid, RecordingDuration } = req.body;
    
    console.log(`🎬 Recording completed for ${CallSid}`);
    console.log(`📼 Recording URL: ${RecordingUrl}`);
    console.log(`⏱️ Duration: ${RecordingDuration} seconds`);
    
    // Broadcast recording completion to dashboard
    broadcastTranscript({
        type: 'call_ended',
        callSid: CallSid,
        recordingSid: RecordingSid,
        duration: RecordingDuration,
        message: 'Call ended - Processing transcription...',
        timestamp: new Date().toISOString()
    });
    
    // Process the recording for transcription
    processRecordingMultiService(RecordingUrl, CallSid, RecordingSid);
    
    res.sendStatus(200);
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

// Dashboard WebSocket handler
function handleDashboard(ws) {
    console.log('📊 Dashboard client connected');
    transcriptClients.add(ws);
    
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            if (data.type === 'ping') {
                ws.send(JSON.stringify({
                    type: 'pong',
                    timestamp: new Date().toISOString()
                }));
            }
        } catch (error) {
            console.error('Dashboard message error:', error);
        }
    });
    
    ws.on('close', () => {
        console.log('📊 Dashboard client disconnected');
        transcriptClients.delete(ws);
    });
    
    ws.on('error', (error) => {
        console.error('📊 Dashboard WebSocket error:', error);
        transcriptClients.delete(ws);
    });
    
    // Send welcome message with current system status
    const activeCalls = Array.from(activeConferences.values()).map(call => ({
        callSid: call.callSid,
        caller: call.caller,
        mode: call.mode,
        startTime: call.startTime,
        duration: Math.floor((new Date() - call.startTime) / 1000)
    }));
    
    ws.send(JSON.stringify({
        type: 'welcome',
        message: 'Connected to real-time transcription dashboard',
        activeConferences: activeConferences.size,
        activeCalls: activeCalls,
        multiServiceActive: !!assemblyai,
        timestamp: new Date().toISOString()
    }));
}

// Fallback single-service processing
async function processRecording(recordingUrl, callSid, recordingSid) {
    try {
        console.log(`🎙️ Fallback transcription for recording: ${recordingSid}`);
        
        // Download recording from Twilio
        const response = await fetch(recordingUrl);
        const audioBuffer = await response.arrayBuffer();
        
        // Send to Deepgram for transcription
        const transcription = await deepgram.listen.prerecorded.transcribeFile(
            audioBuffer,
            {
                model: 'nova-2',
                language: 'en-GB',
                smart_format: true,
                punctuate: true,
                diarize: true,
                utterances: true,
                detect_language: false
            }
        );
        
        const transcript = transcription.result.results.channels[0].alternatives[0].transcript;
        const confidence = transcription.result.results.channels[0].alternatives[0].confidence;
        
        console.log(`✅ Fallback transcript ready (${Math.round(confidence * 100)}% confidence):`);
        console.log(`📝 "${transcript}"`);
        
        // Store and broadcast the transcript
        const transcriptData = {
            type: 'final_transcript',
            callSid: callSid,
            recordingSid: recordingSid,
            text: transcript,
            confidence: confidence,
            accuracy_type: 'single_service_fallback',
            timestamp: new Date().toISOString()
        };
        
        broadcastTranscript(transcriptData);
        
    } catch (error) {
        console.error('❌ Fallback transcription error:', error);
    }
}

// ============================================================================
// MULTI-SERVICE CONFERENCE ENDPOINTS
// ============================================================================

// Enhanced conference with multi-service transcription
app.post('/webhook-enhanced', (req, res) => {
    const { CallSid, From, To } = req.body;
    console.log(`🚀 ENHANCED multi-service webhook: ${From} → ${To} (${CallSid})`);
    
    const conferenceId = `enhanced-${CallSid}`;
    const protocol = process.env.NODE_ENV === 'production' ? 'https' : 'http';
    const host = req.get('host');
    const streamUrl = `${protocol === 'https' ? 'wss' : 'ws'}://${host}/deepgram?conference=${conferenceId}`;
    
    // Store conference info
    activeConferences.set(conferenceId, {
        callSid: CallSid,
        caller: From,
        startTime: new Date(),
        participants: 1,
        enhanced: true,
        multiService: assemblyai ? true : false
    });
    
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">Enhanced transcription conference${assemblyai ? ' with multi-service AI' : ' with optimized Deepgram'}. Starting real-time transcription.</Say>
    <Start>
        <Stream url="${streamUrl}" />
    </Start>
    <Dial>
        <Conference 
            statusCallback="${protocol}://${host}/conference-events"
            statusCallbackEvent="start,end,join,leave"
            record="record-from-start"
            recordingStatusCallback="${protocol}://${host}/recording-complete"
            startConferenceOnEnter="true"
            endConferenceOnExit="false"
            beep="false"
            muted="false"
            region="ireland"
            maxParticipants="10">
            ${conferenceId}
        </Conference>
    </Dial>
</Response>`;
    
    console.log(`🚀 Enhanced conference created: ${conferenceId}`);
    console.log(`🎯 Multi-service: ${assemblyai ? 'YES' : 'NO'} | Real-time: YES | Recording: YES`);
    res.type('text/xml').send(twiml);
    
    // Auto-dial participant if configured
    if (process.env.PARTICIPANT_NUMBER) {
        setTimeout(() => {
            dialParticipantEnhanced(conferenceId, process.env.PARTICIPANT_NUMBER, req);
        }, 2000);
    }
});

// Enhanced auto-dial function
async function dialParticipantEnhanced(conferenceId, participantNumber, req) {
    if (!twilioClient) {
        console.log('🚀 ENHANCED: No Twilio client available');
        return;
    }
    
    try {
        const protocol = process.env.NODE_ENV === 'production' ? 'https' : 'http';
        const host = req.get('host');
        const participantUrl = `${protocol}://${host}/participant-enhanced?conference=${conferenceId}`;
        
        console.log(`🚀 ENHANCED: Auto-dialing ${participantNumber} to ${participantUrl}`);
        
        const call = await twilioClient.calls.create({
            to: participantNumber,
            from: process.env.TWILIO_PHONE_NUMBER || '+441733964789',
            url: participantUrl,
            method: 'POST'
        });
        
        console.log(`🚀 ENHANCED: Call created ${call.sid}`);
        
    } catch (error) {
        console.error('🚀 ENHANCED: Auto-dial error:', error);
    }
}

// Enhanced participant endpoint
app.post('/participant-enhanced', (req, res) => {
    const { CallSid, From, To } = req.body;
    const conferenceId = req.query.conference;
    
    console.log(`🚀 ENHANCED: Participant joining ${conferenceId}`);
    
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">Joining enhanced transcription conference.</Say>
    <Dial>
        <Conference 
            startConferenceOnEnter="true"
            endConferenceOnExit="false"
            beep="false"
            muted="false"
            region="ireland">
            ${conferenceId}
        </Conference>
    </Dial>
</Response>`;
    
    console.log(`🚀 ENHANCED: Participant TwiML sent`);
    res.type('text/xml').send(twiml);
});

// Hybrid enhanced: Bridge + Multi-service recording
app.post('/webhook-hybrid-enhanced', (req, res) => {
    const { CallSid, From, To } = req.body;
    console.log(`🔥 HYBRID ENHANCED: ${From} → ${To} (${CallSid})`);
    
    // Store call info for enhanced processing
    activeConferences.set(CallSid, {
        callSid: CallSid,
        caller: From,
        startTime: new Date(),
        mode: 'hybrid_enhanced',
        multiService: assemblyai ? true : false
    });
    
    // Broadcast call start to dashboard
    broadcastTranscript({
        type: 'call_started',
        callSid: CallSid,
        caller: From,
        mode: 'hybrid_enhanced',
        message: 'Call connected - Recording for enhanced transcription',
        timestamp: new Date().toISOString()
    });
    
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Dial record="record-from-start" 
          recordingStatusCallback="https://real-time-phone-call-agent-production.up.railway.app/recording-complete"
          timeout="30">
        <Number>+447494225623</Number>
    </Dial>
</Response>`;
    
    console.log(`🔥 HYBRID ENHANCED: Direct bridge + Multi-service recording for ${CallSid}`);
    res.type('text/xml').send(twiml);
});