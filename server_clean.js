// CLEAN Real-Time Phone Call Agent - Focused on Core Functionality
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');

// AI Service imports (optional)
const OpenAI = require('openai');
const { AssemblyAI } = require('assemblyai');

const app = express();
const server = http.createServer(app);

// Initialize OpenAI (optional)
let openai = null;
if (process.env.OPENAI_API_KEY) {
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    console.log('🧠 OpenAI initialized');
}

// Initialize AssemblyAI (required)
const assemblyAIApiKey = process.env.ASSEMBLYAI_API_KEY;
if (!assemblyAIApiKey) {
    console.error('❌ ASSEMBLYAI_API_KEY required!');
    process.exit(1);
}

const assemblyai = new AssemblyAI({ apiKey: assemblyAIApiKey });

// Basic setup
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';

// Essential middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Audio file hosting for AssemblyAI
app.use('/audio', express.static('/tmp', {
    maxAge: 300000,
    setHeaders: (res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', 'audio/wav');
    }
}));

// Global variables
let dashboardClients = new Set();
let activeStreams = new Map();

// SIMPLIFIED Intent Detection (replaces 500+ lines of complex analysis)
function detectIntent(text) {
    const lowerText = text.toLowerCase();
    
    // Meeting keywords
    const meetingTerms = ['meeting', 'schedule', 'arrange', 'discuss', 'appointment', 'meet'];
    const hasMeeting = meetingTerms.some(term => lowerText.includes(term));
    
    // Support keywords  
    const supportTerms = ['help', 'support', 'problem', 'issue', 'trouble'];
    const hasSupport = supportTerms.some(term => lowerText.includes(term));
    
    // Info keywords
    const infoTerms = ['information', 'details', 'tell me', 'what is', 'price'];
    const hasInfo = infoTerms.some(term => lowerText.includes(term));
    
    if (hasMeeting) return { intent: 'meeting_discussion', confidence: 0.9 };
    if (hasSupport) return { intent: 'support_request', confidence: 0.8 };
    if (hasInfo) return { intent: 'information_request', confidence: 0.7 };
    return { intent: 'general_inquiry', confidence: 0.5 };
}

// SIMPLIFIED Email Extraction (replaces 200+ lines)
function extractEmail(text) {
    const emailRegex = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
    const match = text.match(emailRegex);
    return match ? match[0] : null;
}

// Broadcast to dashboard clients
function broadcastToClients(message) {
    dashboardClients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            try {
                client.send(JSON.stringify(message));
            } catch (error) {
                console.error('Broadcast error:', error);
            }
        }
    });
}

// CORE: Process transcript and extract insights
async function processTranscript(text, callSid) {
    console.log(`📝 Processing: "${text}"`);
    
    const { intent, confidence } = detectIntent(text);
    const email = extractEmail(text);
    
    console.log(`🎯 Intent: ${intent} (${Math.round(confidence * 100)}%)`);
    if (email) console.log(`📧 Email: ${email}`);
    
    // Broadcast to dashboard
    broadcastToClients({
        type: 'live_transcript',
        message: text,
        data: {
            callSid,
            text,
            intent,
            confidence,
            email,
            timestamp: new Date().toISOString()
        }
    });
    
    // Optional: Send to n8n webhook
    if (process.env.N8N_WEBHOOK_URL) {
        fetch(process.env.N8N_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                type: 'transcript',
                callSid,
                text,
                intent,
                confidence,
                email,
                timestamp: new Date().toISOString()
            })
        }).catch(error => console.error('N8N webhook error:', error));
    }
}

// CORE: HTTP chunked transcription processing
function initializeTranscription(callSid, ws) {
    console.log(`🎙️ Starting transcription for ${callSid}`);
    
    ws.chunkBuffer = Buffer.alloc(0);
    ws.sentenceBuffer = '';
    ws.lastProcessTime = Date.now();
    ws.chunkCount = 0;
    
    // Process audio every 2 seconds
    ws.processor = setInterval(async () => {
        if (ws.chunkBuffer.length >= 16000) { // 1 second of audio at 16kHz
            try {
                console.log(`🔄 Processing chunk ${++ws.chunkCount}`);
                
                // Create WAV file
                const wavHeader = createWavHeader(ws.chunkBuffer.length);
                const wavFile = Buffer.concat([wavHeader, ws.chunkBuffer]);
                
                // Save temporarily
                const fs = require('fs');
                const filename = `audio_${callSid}_${Date.now()}.wav`;
                const filepath = `/tmp/${filename}`;
                fs.writeFileSync(filepath, wavFile);
                
                // Create public URL
                const protocol = process.env.NODE_ENV === 'production' ? 'https' : 'http';
                const host = process.env.RAILWAY_PUBLIC_DOMAIN || 'localhost:3000';
                const audioUrl = `${protocol}://${host}/audio/${filename}`;
                
                // Request transcription
                const response = await fetch('https://api.assemblyai.com/v2/transcript', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${assemblyAIApiKey}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        audio_url: audioUrl,
                        language_code: 'en_us',
                        punctuate: true,
                        format_text: true,
                        word_boost: ['meeting', 'schedule', 'email', 'phone', 'call'],
                        speech_model: 'best'
                    })
                });
                
                if (response.ok) {
                    const result = await response.json();
                    
                    // Poll for completion
                    for (let i = 0; i < 15; i++) {
                        await new Promise(resolve => setTimeout(resolve, 1000));
                        
                        const statusResponse = await fetch(`https://api.assemblyai.com/v2/transcript/${result.id}`, {
                            headers: { 'Authorization': `Bearer ${assemblyAIApiKey}` }
                        });
                        
                        if (statusResponse.ok) {
                            const status = await statusResponse.json();
                            if (status.status === 'completed' && status.text) {
                                console.log(`✅ Transcript: "${status.text}"`);
                                await processTranscript(status.text, callSid);
                                break;
                            }
                        }
                    }
                }
                
                // Cleanup
                fs.unlinkSync(filepath);
                ws.chunkBuffer = Buffer.alloc(0);
                
            } catch (error) {
                console.error('Transcription error:', error);
                ws.chunkBuffer = Buffer.alloc(0);
            }
        }
    }, 2000);
    
    console.log('✅ Transcription initialized');
}

// CORE: WebSocket routing
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
    const urlPath = req.url;
    console.log(`🔗 WebSocket connection: ${urlPath}`);
    
    // Route to appropriate handler
    if (urlPath.includes('callSid=') || req.headers['user-agent']?.includes('TwilioMediaStreams')) {
        handleTwilioStream(ws, req);
    } else {
        handleDashboard(ws);
    }
});

// CORE: Twilio stream handler
function handleTwilioStream(ws, req) {
    const callSid = new URLSearchParams(req.url.split('?')[1])?.get('callSid') || 'unknown';
    console.log(`📞 Twilio stream: ${callSid}`);
    
    initializeTranscription(callSid, ws);
    
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            
            if (data.event === 'media' && data.media.payload) {
                const mulawData = Buffer.from(data.media.payload, 'base64');
                const linear16Data = convertMulawToLinear16(mulawData);
                ws.chunkBuffer = Buffer.concat([ws.chunkBuffer, linear16Data]);
            }
            
            if (data.event === 'stop') {
                console.log(`📞 Call ended: ${callSid}`);
                if (ws.processor) clearInterval(ws.processor);
            }
        } catch (error) {
            console.error('Stream error:', error);
        }
    });
}

// CORE: Dashboard handler
function handleDashboard(ws) {
    console.log('📊 Dashboard connection');
    dashboardClients.add(ws);
    
    ws.on('close', () => {
        dashboardClients.delete(ws);
    });
    
    ws.send(JSON.stringify({
        type: 'welcome',
        message: 'Connected to dashboard'
    }));
}

// CORE: Audio conversion
function convertMulawToLinear16(mulawBuffer) {
    const mulawToLinear = [/* mulaw lookup table - same as original */];
    const linear16Buffer = Buffer.alloc(mulawBuffer.length * 4);
    
    for (let i = 0; i < mulawBuffer.length; i++) {
        const linearValue = mulawToLinear[mulawBuffer[i]];
        linear16Buffer.writeInt16LE(linearValue, i * 4);
        linear16Buffer.writeInt16LE(linearValue, i * 4 + 2);
    }
    
    return linear16Buffer;
}

// CORE: WAV header creation
function createWavHeader(dataLength, sampleRate = 16000) {
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataLength, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(dataLength, 40);
    return header;
}

// CORE: Twilio webhook handler
function handleVoiceWebhook(req, res) {
    const { CallSid, From, To } = req.body;
    console.log(`📞 Call: ${From} → ${To} (${CallSid})`);
    
    const protocol = req.secure ? 'https' : 'http';
    const host = req.get('host');
    const streamUrl = `${protocol === 'https' ? 'wss' : 'ws'}://${host}/?callSid=${CallSid}`;
    
    const bridgeNumber = process.env.BRIDGE_TARGET_NUMBER;
    
    if (bridgeNumber) {
        // Bridge mode
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">Connecting your call, please wait...</Say>
    <Start>
        <Stream url="${streamUrl}" track="both_tracks" />
    </Start>
    <Dial record="record-from-answer" callerId="${From}">
        <Number>${bridgeNumber}</Number>
    </Dial>
</Response>`;
        res.type('text/xml').send(twiml);
    } else {
        // Analysis mode
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Start>
        <Stream url="${streamUrl}" track="inbound_track" />
    </Start>
    <Pause length="30"/>
</Response>`;
        res.type('text/xml').send(twiml);
    }
}

// Essential endpoints
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/health', (req, res) => res.json({ status: 'healthy', timestamp: new Date().toISOString() }));
app.post('/voice', handleVoiceWebhook);
app.post('/webhook/voice', handleVoiceWebhook);

// Start server
server.listen(PORT, () => {
    console.log(`🚀 Clean server running on port ${PORT}`);
    console.log(`🎯 Core features: Twilio bridge + real-time transcription`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('Shutting down...');
    server.close(() => process.exit(0));
}); 