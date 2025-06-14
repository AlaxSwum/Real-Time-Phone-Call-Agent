require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');

// AI Service imports
const OpenAI = require('openai');
const { AssemblyAI } = require('assemblyai');

const app = express();
const server = http.createServer(app);

// Initialize AI clients
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const assemblyAI = new AssemblyAI({ apiKey: process.env.ASSEMBLYAI_API_KEY });

// Environment configuration
const PORT = process.env.PORT || 3000;
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
                connectSrc: ["'self'", "ws:", "wss:", "https:"],
                fontSrc: ["'self'", "data:", "https:"]
            },
        },
        hsts: {
            maxAge: 31536000,
            includeSubDomains: true,
            preload: true
        }
    }));
    console.log('✅ Production security enabled (relaxed CSP for dashboard)');
} else {
    console.log('⚠️ Development mode - reduced security');
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

// Serve static files from public directory
app.use(express.static('public'));

// Global variables for real-time functionality
let dashboardClients = new Set();
let activeStreams = new Map();

// Mulaw to PCM conversion function for AssemblyAI compatibility
function convertMulawToPcm(mulawBuffer) {
    // Mulaw decompression table (256 values)
    const mulawToPcm = [
        -32124, -31100, -30076, -29052, -28028, -27004, -25980, -24956,
        -23932, -22908, -21884, -20860, -19836, -18812, -17788, -16764,
        -15996, -15484, -14972, -14460, -13948, -13436, -12924, -12412,
        -11900, -11388, -10876, -10364, -9852, -9340, -8828, -8316,
        -7932, -7676, -7420, -7164, -6908, -6652, -6396, -6140,
        -5884, -5628, -5372, -5116, -4860, -4604, -4348, -4092,
        -3900, -3772, -3644, -3516, -3388, -3260, -3132, -3004,
        -2876, -2748, -2620, -2492, -2364, -2236, -2108, -1980,
        -1884, -1820, -1756, -1692, -1628, -1564, -1500, -1436,
        -1372, -1308, -1244, -1180, -1116, -1052, -988, -924,
        -876, -844, -812, -780, -748, -716, -684, -652,
        -620, -588, -556, -524, -492, -460, -428, -396,
        -372, -356, -340, -324, -308, -292, -276, -260,
        -244, -228, -212, -196, -180, -164, -148, -132,
        -120, -112, -104, -96, -88, -80, -72, -64,
        -56, -48, -40, -32, -24, -16, -8, 0,
        32124, 31100, 30076, 29052, 28028, 27004, 25980, 24956,
        23932, 22908, 21884, 20860, 19836, 18812, 17788, 16764,
        15996, 15484, 14972, 14460, 13948, 13436, 12924, 12412,
        11900, 11388, 10876, 10364, 9852, 9340, 8828, 8316,
        7932, 7676, 7420, 7164, 6908, 6652, 6396, 6140,
        5884, 5628, 5372, 5116, 4860, 4604, 4348, 4092,
        3900, 3772, 3644, 3516, 3388, 3260, 3132, 3004,
        2876, 2748, 2620, 2492, 2364, 2236, 2108, 1980,
        1884, 1820, 1756, 1692, 1628, 1564, 1500, 1436,
        1372, 1308, 1244, 1180, 1116, 1052, 988, 924,
        876, 844, 812, 780, 748, 716, 684, 652,
        620, 588, 556, 524, 492, 460, 428, 396,
        372, 356, 340, 324, 308, 292, 276, 260,
        244, 228, 212, 196, 180, 164, 148, 132,
        120, 112, 104, 96, 88, 80, 72, 64,
        56, 48, 40, 32, 24, 16, 8, 0
    ];
    
    // Convert mulaw bytes to 16-bit PCM samples
    const pcmBuffer = Buffer.alloc(mulawBuffer.length * 2); // 16-bit = 2 bytes per sample
    
    for (let i = 0; i < mulawBuffer.length; i++) {
        const mulawValue = mulawBuffer[i];
        const pcmValue = mulawToPcm[mulawValue];
        
        // Write 16-bit PCM value in little-endian format
        pcmBuffer.writeInt16LE(pcmValue, i * 2);
    }
    
    return pcmBuffer;
}

// Intent detection and processing function
async function detectAndProcessIntent(text, callSid) {
    const lowerText = text.toLowerCase();
    let detectedIntent = null;
    let confidence = 0;
    
    // Meeting intent detection
    const meetingKeywords = [
        'arrange a meeting',
        'set up a meeting',
        'schedule a meeting',
        'meeting on',
        'meeting at',
        'meeting next',
        'would like to meet',
        'want to meet',
        'let\'s meet',
        'discuss',
        'catch up',
        'get together'
    ];
    const meetingMatch = meetingKeywords.some(keyword => lowerText.includes(keyword));
    
    // Support intent detection
    const supportKeywords = ['help', 'support', 'problem', 'issue', 'trouble', 'assistance'];
    const supportMatch = supportKeywords.some(keyword => lowerText.includes(keyword));
    
    // Information intent detection
    const infoKeywords = ['information', 'info', 'details', 'tell me', 'what is', 'how much', 'price'];
    const infoMatch = infoKeywords.some(keyword => lowerText.includes(keyword));
    
    // Determine primary intent with higher confidence for meetings
    if (meetingMatch) {
        detectedIntent = 'meeting_discussion';
        // Higher confidence for explicit meeting mentions
        confidence = lowerText.includes('arrange a meeting') || 
                    lowerText.includes('schedule a meeting') ? 
                    0.95 : 0.85;
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
    console.log(`📋 Intent analysis: "${text}"`);
    
    // Broadcast intent to dashboard
    broadcastToClients({
        type: 'intent_detected',
        message: `Intent: ${detectedIntent} (${Math.round(confidence * 100)}% confidence)`,
        data: {
            callSid: callSid,
            intent: detectedIntent,
            confidence: confidence,
            transcript: text,
            timestamp: new Date().toISOString()
        }
    });
    
    // Send to n8n webhook if configured
    if (process.env.N8N_WEBHOOK_URL) {
        console.log(`🔗 Sending intent to n8n: ${detectedIntent}`);
        console.log(`🔗 N8N Webhook URL: ${process.env.N8N_WEBHOOK_URL}`);
        
        try {
            const response = await fetch(process.env.N8N_WEBHOOK_URL, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                body: JSON.stringify({
                    type: 'intent_detection',
                    callSid: callSid,
                    intent: detectedIntent,
                    confidence: confidence,
                    transcript: text,
                    timestamp: new Date().toISOString(),
                    keywords_matched: getMatchedKeywords(lowerText, detectedIntent)
                })
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            console.log(`✅ Intent sent to n8n (${response.status}): ${detectedIntent}`);
            const responseText = await response.text();
            console.log(`📡 N8N Response:`, responseText);
        } catch (error) {
            console.error('❌ Error sending intent to n8n:', error.message);
            console.error('🔍 Full error:', error);
            console.error('🔗 Webhook URL:', process.env.N8N_WEBHOOK_URL);
        }
    } else {
        console.log('⚠️ No N8N webhook URL configured - skipping webhook');
    }
}

// Helper function to get matched keywords for intent
function getMatchedKeywords(lowerText, intent) {
    const keywordSets = {
        'meeting_discussion': [
            'arrange a meeting',
            'set up a meeting',
            'schedule a meeting',
            'meeting on',
            'meeting at',
            'meeting next',
            'would like to meet',
            'want to meet',
            'let\'s meet',
            'discuss',
            'catch up',
            'get together'
        ],
        'support_request': ['help', 'support', 'problem', 'issue', 'trouble', 'assistance'],
        'information_request': ['information', 'info', 'details', 'tell me', 'what is', 'how much', 'price'],
        'general_inquiry': []
    };
    
    const keywords = keywordSets[intent] || [];
    return keywords.filter(keyword => lowerText.includes(keyword));
}

// Basic health check endpoint
app.get('/health', (req, res) => {
    const healthCheck = {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        environment: NODE_ENV,
        services: {
            assemblyai: {
                configured: !!process.env.ASSEMBLYAI_API_KEY,
                status: 'operational'
            },
            openai: {
                configured: !!process.env.OPENAI_API_KEY,
                status: 'operational'
            }
        },
        server: {
            uptime: process.uptime(),
            memory: process.memoryUsage(),
            activeConnections: activeConnections,
            activeStreams: activeStreams.size
        }
    };
    
    res.json(healthCheck);
});

// Root endpoint - serve dashboard
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API info endpoint
app.get('/api', (req, res) => {
    res.json({
        message: 'Real-Time Call Processor API',
        version: '2.0.0',
        environment: NODE_ENV,
        endpoints: {
            health: '/health',
            voice_webhook: '/webhook/voice',
            dashboard: '/',
            websocket: '/ws',
            stream: '/stream',
            test_assemblyai: '/test/assemblyai',
            test_assemblyai_ws: '/test/assemblyai-ws',
            documentation: 'https://github.com/AlaxSwum/Real-Time-Phone-Call-Agent'
        }
    });
});

// Function to broadcast to all dashboard clients
function broadcastToClients(message) {
    // Only log non-transcript messages to reduce spam
    if (message.type !== 'live_transcript') {
        console.log(`📡 Broadcasting to ${dashboardClients.size} dashboard clients:`, message.type);
    }
    let sentCount = 0;
    dashboardClients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            try {
                client.send(JSON.stringify(message));
                sentCount++;
            } catch (error) {
                console.error('❌ Error broadcasting to client:', error);
            }
        }
    });
    // Only log success for important messages
    if (message.type !== 'live_transcript') {
        console.log(`✅ Successfully sent message to ${sentCount}/${dashboardClients.size} clients`);
    }
}

// Twilio Voice Webhook Endpoint - REAL-TIME STREAMING
app.post('/webhook/voice', (req, res) => {
    console.log('📞 Incoming call received from Twilio');
    console.log('📋 Call details:', req.body);
    
    // Extract call information
    const { From, To, CallSid, Direction } = req.body;
    
    // Log call details
    console.log(`📞 Call from ${From} to ${To} (${Direction})`);
    console.log(`🆔 Call SID: ${CallSid}`);
    
    // Send to n8n webhook if configured
    if (process.env.N8N_WEBHOOK_URL) {
        fetch(process.env.N8N_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                type: 'twilio_voice_webhook',
                data: req.body,
                timestamp: new Date().toISOString()
            })
        }).catch(error => {
            console.error('❌ Error sending to n8n webhook:', error);
        });
    }
    
    // Broadcast call start to all connected dashboard clients
    broadcastToClients({
        type: 'call_started',
        message: `Call started from ${From}`,
        data: {
            from: From,
            to: To,
            callSid: CallSid,
            direction: Direction,
            timestamp: new Date().toISOString()
        }
    });
    
    // TwiML response for real-time streaming
    const streamUrl = `wss://real-time-phone-call-agent.onrender.com/stream/${CallSid}`;
    console.log('🔗 Stream URL for TwiML:', streamUrl);
    
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">Hello! Please speak your message.</Say>
    <Start>
        <Stream url="${streamUrl}" track="inbound_track" />
    </Start>
    <Pause length="30"/>
</Response>`;
    
    console.log('📋 TwiML Response:', twiml);
    res.type('text/xml');
    res.send(twiml);
});

// Analyze transcript with OpenAI
async function analyzeTranscriptWithAI(text, callSid) {
    try {
        console.log('🧠 Analyzing transcript with OpenAI...');
        
        const aiResponse = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                {
                    role: "system",
                    content: `You are an AI assistant for a real-time call processing system. Analyze the following voice message focusing on meeting discussions and provide a JSON response with:
                    {
                        "intent": "meeting_discussion/support_request/information_request/general_inquiry",
                        "urgency": "low/medium/high",
                        "key_info": ["extracted information items"],
                        "sentiment": "positive/neutral/negative",
                        "follow_up": "recommended action",
                        "summary": "brief professional summary"
                    }
                    
                    For meeting discussions, focus on:
                    1. The topic or purpose of the meeting/discussion
                    2. Key points or concerns raised
                    3. Any decisions or conclusions reached
                    4. Participants mentioned
                    
                    Do NOT include scheduling or booking-related information in the response.`
                },
                {
                    role: "user",
                    content: `Voice message: "${text}"`
                }
            ],
            temperature: 0.3
        });
        
        let analysis;
        try {
            analysis = JSON.parse(aiResponse.choices[0].message.content);
        } catch (parseError) {
            analysis = {
                intent: "general_inquiry",
                urgency: "medium",
                key_info: [text.substring(0, 100)],
                sentiment: "neutral",
                follow_up: "Review and respond appropriately",
                summary: aiResponse.choices[0].message.content
            };
        }
        
        console.log('🎯 INTENT DETECTED:', analysis.intent);
        console.log('⚡ URGENCY LEVEL:', analysis.urgency);
        console.log('😊 SENTIMENT:', analysis.sentiment);
        console.log('📋 AI SUMMARY:', analysis.summary);
        
        // Broadcast AI analysis to dashboard
        broadcastToClients({
            type: 'ai_analysis',
            message: `AI Analysis: ${analysis.intent} (${analysis.urgency} urgency)`,
            data: {
                callSid: callSid,
                transcript: text,
                analysis: analysis,
                timestamp: new Date().toISOString()
            }
        });
        
        // Send to n8n webhook
        if (process.env.N8N_WEBHOOK_URL) {
            fetch(process.env.N8N_WEBHOOK_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    type: 'live_ai_analysis',
                    callSid: callSid,
                    transcript: text,
                    analysis: analysis,
                    timestamp: new Date().toISOString()
                })
            }).catch(error => {
                console.error('❌ Error sending to n8n webhook:', error);
            });
        }
        
    } catch (error) {
        console.error('❌ AI analysis error:', error);
    }
}

// Single WebSocket server with path routing
const wss = new WebSocket.Server({ server });

let activeConnections = 0;

wss.on('connection', (ws, req) => {
    const urlPath = req.url;
    console.log(`🔌 NEW WEBSOCKET CONNECTION to path: ${urlPath}`);
    
    if (urlPath.startsWith('/stream/')) {
        // This is a Twilio Media Stream connection
        handleTwilioStreamConnection(ws, req);
    } else if (urlPath === '/ws') {
        // This is a dashboard connection
        handleDashboardConnection(ws, req);
    } else {
        console.log(`❌ Unknown WebSocket path: ${urlPath}`);
        ws.close();
    }
});

// Dashboard WebSocket handler
function handleDashboardConnection(ws, req) {
    activeConnections++;
    dashboardClients.add(ws);
    const clientIP = req.socket.remoteAddress;
    console.log(`🔌 NEW DASHBOARD CLIENT connected from ${clientIP}`);
    console.log(`📊 Dashboard clients: ${dashboardClients.size}, Total connections: ${activeConnections}`);
    
    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            console.log('📧 Received dashboard message:', data.type);
            
            switch (data.type) {
                case 'ping':
                    ws.send(JSON.stringify({
                        type: 'pong',
                        timestamp: new Date().toISOString()
                    }));
                    break;
                    
                case 'get_active_calls':
                    ws.send(JSON.stringify({
                        type: 'active_calls',
                        data: Array.from(activeStreams.values()),
                        timestamp: new Date().toISOString()
                    }));
                    break;
                    
                default:
                    console.log('Unknown dashboard message type:', data.type);
            }
        } catch (error) {
            console.error('❌ Dashboard WebSocket message error:', error);
        }
    });
    
    ws.on('close', () => {
        activeConnections--;
        dashboardClients.delete(ws);
        console.log(`🔌 DASHBOARD CLIENT disconnected`);
        console.log(`📊 Dashboard clients: ${dashboardClients.size}, Total connections: ${activeConnections}`);
    });
    
    ws.on('error', (error) => {
        console.error('❌ Dashboard WebSocket error:', error);
    });
    
    // Send welcome message
    ws.send(JSON.stringify({
        type: 'welcome',
        message: 'Connected to Real-Time Call Processor Dashboard',
        timestamp: new Date().toISOString()
    }));
}

// Twilio Media Stream WebSocket handler  
function handleTwilioStreamConnection(ws, req) {
    const urlParts = req.url.split('/');
    const callSid = urlParts[urlParts.length - 1];
    console.log(`🎙️ NEW TWILIO STREAM CONNECTION for call: ${callSid}`);
    console.log(`🔗 Stream URL: ${req.url}`);
    console.log(`📡 Headers:`, req.headers);
    
    // Initialize AssemblyAI real-time transcription
    let assemblyAISocket = null;
    let fullTranscript = '';
    
    if (process.env.ASSEMBLYAI_API_KEY) {
        console.log('🤖 Creating AssemblyAI real-time session...');
        console.log('🔑 Using API key:', process.env.ASSEMBLYAI_API_KEY ? 'SET' : 'NOT SET');
        try {
            // Create WebSocket connection to AssemblyAI real-time service
            const WS = require('ws');
            const assemblyAIWS = new WS('wss://api.assemblyai.com/v2/realtime/ws?sample_rate=8000&encoding=pcm_mulaw&word_boost=["hello","hi","test","phone","call","yes","no","okay","thank","you","please","help","meeting","book","booking","appointment","email","schedule","international","next","week","friday"]', {
                headers: {
                    'Authorization': process.env.ASSEMBLYAI_API_KEY
                }
            });
            
            assemblyAISocket = assemblyAIWS;
            console.log('📡 AssemblyAI WebSocket state:', assemblyAIWS.readyState);
            
            assemblyAIWS.on('open', () => {
                console.log('✅ ASSEMBLYAI REAL-TIME WEBSOCKET CONNECTED for call:', callSid);
                console.log('📡 AssemblyAI connection state:', assemblyAIWS.readyState);
            });
            
            assemblyAIWS.on('message', (data) => {
                lastTranscriptTime = Date.now(); // Update timestamp for timeout monitoring
                messageCount++;
                try {
                    const transcript = JSON.parse(data);
                    console.log('📥 AssemblyAI message:', transcript.message_type, transcript.text ? `"${transcript.text}"` : '(empty)');
                    
                    if (transcript.message_type === 'SessionBegins') {
                        console.log('🎬 AssemblyAI session started for call:', callSid);
                    } else if (transcript.message_type === 'PartialTranscript' || transcript.message_type === 'FinalTranscript') {
                        // Clear timeout when we get actual transcripts
                        if (transcriptTimeout && transcript.text && transcript.text.length > 0) {
                            clearInterval(transcriptTimeout);
                            transcriptTimeout = null;
                            console.log('✅ Real-time transcription working successfully!');
                        }
                        
                        // Process the transcript (this was missing!)
                        if (transcript.text !== undefined) {
                            // Add to full transcript (accept even lower confidence for phone audio quality)
                            if (transcript.message_type === 'FinalTranscript' && transcript.text.trim().length > 0) {
                                fullTranscript += transcript.text + ' ';
                                console.log(`✅ Added to full transcript: "${transcript.text}"`);
                            }
                            
                            // Broadcast to dashboard clients (including empty for debugging)
                            const confidencePercent = Math.round((transcript.confidence || 0) * 100);
                            
                            if (transcript.text && transcript.text.trim().length > 0) {
                                console.log(`📝 TRANSCRIPT: "${transcript.text}" (${confidencePercent}% confidence, ${transcript.message_type})`);
                            }
                            
                            broadcastToClients({
                                type: 'live_transcript',
                                message: transcript.text ? `"${transcript.text}" (${confidencePercent}% confidence)` : `Processing audio (${confidencePercent}% confidence)`,
                                data: {
                                    callSid: callSid,
                                    text: transcript.text || "",
                                    confidence: transcript.confidence,
                                    is_final: transcript.message_type === 'FinalTranscript',
                                    timestamp: new Date().toISOString()
                                }
                            });
                            
                            // If final transcript, analyze with OpenAI and detect intents
                            if (transcript.message_type === 'FinalTranscript' && transcript.text.trim().length > 1) {
                                console.log('🧠 Analyzing transcript for intents...');
                                analyzeTranscriptWithAI(transcript.text, callSid);
                                detectAndProcessIntent(transcript.text, callSid);
                            }
                        }
                    } else if (transcript.text === "" && transcript.confidence === 0) {
                        console.log('🔇 Empty transcript received - audio may be too quiet or unclear');
                    } else if (transcript.message_type) {
                        console.log(`📡 AssemblyAI message type: ${transcript.message_type}`);
                    }
                } catch (parseError) {
                    console.error('❌ Error parsing AssemblyAI message:', parseError);
                    console.log('🔍 Raw data:', data.toString());
                }
            });
            
            assemblyAIWS.on('error', (error) => {
                console.error('❌ ASSEMBLYAI REAL-TIME ERROR:', error);
                console.error('🔍 Error details:', error.message);
                console.error('🔍 Error code:', error.code);
                console.error('🔍 Error stack:', error.stack);
                
                // Broadcast error to dashboard
                broadcastToClients({
                    type: 'assemblyai_error',
                    message: `AssemblyAI Error: ${error.message}`,
                    data: {
                        callSid: callSid,
                        error: error.message,
                        timestamp: new Date().toISOString()
                    }
                });
            });
            
            assemblyAIWS.on('close', (code, reason) => {
                console.log('🔌 AssemblyAI WebSocket closed for call:', callSid);
                console.log('🔍 Close code:', code, 'Reason:', reason.toString());
                console.log('🔍 Standard close codes: 1000=Normal, 1001=GoingAway, 1005=NoStatus, 1006=Abnormal');
                
                // Broadcast close info to dashboard
                broadcastToClients({
                    type: 'assemblyai_closed',
                    message: `AssemblyAI connection closed (code: ${code})`,
                    data: {
                        callSid: callSid,
                        closeCode: code,
                        reason: reason.toString(),
                        timestamp: new Date().toISOString()
                    }
                });
            });
            
            // Add a timeout to detect if AssemblyAI is not responding
            let lastTranscriptTime = Date.now();
            let messageCount = 0;
            let transcriptTimeout = setInterval(() => {
                const timeSinceLastTranscript = Date.now() - lastTranscriptTime;
                if (timeSinceLastTranscript > 8000 && mediaPacketCount > 100) { // 8 seconds without any message
                    console.log(`⚠️ No AssemblyAI messages for 8+ seconds (packets sent: ${mediaPacketCount}, messages received: ${messageCount})`);
                    console.log(`🔍 Socket state: ${assemblyAIWS.readyState}, Time since last: ${Math.round(timeSinceLastTranscript/1000)}s`);
                }
            }, 4000);
            
            // Clear transcript timeout on close
            assemblyAIWS.on('close', () => {
                if (transcriptTimeout) {
                    clearInterval(transcriptTimeout);
                }
            });
            
        } catch (error) {
            console.error('❌ FAILED TO CREATE ASSEMBLYAI SESSION:', error);
            console.error('🔍 Error details:', error.message);
            console.error('🔍 Error stack:', error.stack);
        }
    } else {
        console.log('⚠️ NO ASSEMBLYAI API KEY - Real-time transcription disabled');
    }
    
    let mediaPacketCount = 0;
    let isUserSpeaking = false;
    let silenceBuffer = 0;
    let twimlFinished = false;
    let firstAudioSample = null;
    let audioVariationDetected = false;
    
    // Delay audio forwarding to avoid TwiML voice pickup
    setTimeout(() => {
        twimlFinished = true;
        console.log('🎙️ TwiML playback should be finished, starting audio capture...');
    }, 2500); // Wait 2.5 seconds for TwiML to finish (reduced for better capture)
    
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            
            switch (data.event) {
                case 'start':
                    console.log('🎙️ STREAM STARTED for call:', callSid);
                    console.log('📋 Stream details:', JSON.stringify(data.start, null, 2));
                    console.log('🔍 AssemblyAI socket status:', assemblyAISocket ? 'EXISTS' : 'MISSING');
                    console.log('🔍 AssemblyAI ready state:', assemblyAISocket ? assemblyAISocket.readyState : 'N/A');
                    
                    activeStreams.set(callSid, {
                        callSid: callSid,
                        startTime: new Date(),
                        transcript: '',
                        status: 'active'
                    });
                    
                    // Broadcast stream start
                    broadcastToClients({
                        type: 'stream_started',
                        message: `Audio stream started for call ${callSid}`,
                        data: {
                            callSid: callSid,
                            timestamp: new Date().toISOString()
                        }
                    });
                    break;
                    
                case 'media':
                    mediaPacketCount++;
                    if (mediaPacketCount === 1) {
                        console.log(`🎵 FIRST AUDIO PACKET received from Twilio`);
                        console.log(`🔍 Audio data length: ${data.media.payload ? data.media.payload.length : 'NO PAYLOAD'}`);
                        console.log(`🔍 Audio sequence: ${data.media.sequence}`);
                        console.log(`🔍 AssemblyAI socket state: ${assemblyAISocket ? assemblyAISocket.readyState : 'NO SOCKET'}`);
                    }
                    
                    
                    // Forward audio to AssemblyAI for real-time transcription (only after TwiML finishes)
                    if (assemblyAISocket && assemblyAISocket.readyState === 1 && data.media.payload && twimlFinished) {
                        try {
                            // Send the mulaw audio data directly to AssemblyAI
                            // Twilio sends mulaw-encoded audio as base64, which is what AssemblyAI expects
                            const audioMessage = {
                                audio_data: data.media.payload
                            };
                            assemblyAISocket.send(JSON.stringify(audioMessage));
                            
                            if (mediaPacketCount === 1) {
                                console.log(`✅ FIRST audio packet sent to AssemblyAI (${data.media.payload.length} bytes)`);
                                console.log('🎙️ Audio format: mulaw, sample rate: 8000Hz');
                            }
                            
                            // Monitor audio quality every 500 packets  
                            if (mediaPacketCount % 500 === 0) {
                                console.log(`🎵 Audio packets sent: ${mediaPacketCount}`);
                            }
                        } catch (audioError) {
                            console.error('❌ Error sending audio to AssemblyAI:', audioError.message);
                            console.error('🔍 AssemblyAI socket state:', assemblyAISocket ? assemblyAISocket.readyState : 'NO SOCKET');
                        }
                    } else if (!twimlFinished) {
                        if (mediaPacketCount === 1) {
                            console.log('⏳ Skipping audio packets - waiting for TwiML to finish (avoiding echo)');
                        }
                    } else if (!assemblyAISocket) {
                        if (mediaPacketCount === 1) {
                            console.log('⚠️ No AssemblyAI socket available to send audio to');
                        }
                    } else if (assemblyAISocket.readyState !== 1) {
                        if (mediaPacketCount === 1) {
                            console.log(`⚠️ AssemblyAI socket not ready (state: ${assemblyAISocket.readyState})`);
                            console.log(`🔍 Socket states: 0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED`);
                        }
                    } else if (!data.media.payload) {
                        if (mediaPacketCount === 1) {
                            console.log('⚠️ No audio payload in media packet');
                        }
                    }
                    break;
                    
                case 'stop':
                    console.log('🎙️ STREAM STOPPED for call:', callSid);
                    console.log(`📊 Total audio packets received: ${mediaPacketCount}`);
                    
                    if (assemblyAISocket) {
                        console.log('🔌 Closing AssemblyAI session...');
                        assemblyAISocket.close();
                    }
                    
                    // Final analysis if we have a full transcript
                    if (fullTranscript.trim().length > 0) {
                        console.log('📝 FULL CALL TRANSCRIPT: "' + fullTranscript.trim() + '"');
                        if (fullTranscript.trim().length > 3) {
                            analyzeTranscriptWithAI(fullTranscript.trim(), callSid);
                            detectAndProcessIntent(fullTranscript.trim(), callSid);
                        }
                    } else {
                        console.log('📝 Call completed - individual transcripts were processed in real-time');
                    }
                    
                    activeStreams.delete(callSid);
                    
                    // Broadcast stream end
                    broadcastToClients({
                        type: 'stream_ended',
                        message: `Call ended for ${callSid}`,
                        data: {
                            callSid: callSid,
                            fullTranscript: fullTranscript.trim(),
                            timestamp: new Date().toISOString()
                        }
                    });
                    break;
                    
                default:
                    console.log(`📥 Unknown stream event: ${data.event}`);
            }
        } catch (error) {
            console.error('❌ Stream message error:', error);
        }
    });
    
    ws.on('close', () => {
        console.log(`🎙️ Stream connection closed for call: ${callSid}`);
        if (assemblyAISocket) {
            assemblyAISocket.close();
        }
        activeStreams.delete(callSid);
    });
    
    ws.on('error', (error) => {
        console.error('❌ Stream WebSocket error:', error);
    });
}

// Test AssemblyAI connection endpoint
app.post('/test/assemblyai', async (req, res) => {
    console.log('🧪 Testing AssemblyAI connection...');
    
    if (!process.env.ASSEMBLYAI_API_KEY) {
        return res.json({
            success: false,
            error: 'No AssemblyAI API key configured'
        });
    }
    
    try {
        // Test the API key with a simple request
        const response = await fetch('https://api.assemblyai.com/v2/transcript', {
            method: 'POST',
            headers: {
                'Authorization': process.env.ASSEMBLYAI_API_KEY,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                audio_url: 'https://storage.googleapis.com/aai-docs-samples/nbc.wav'
            })
        });
        
        const data = await response.json();
        console.log('✅ AssemblyAI API test response:', data);
        
        res.json({
            success: response.ok,
            status: response.status,
            api_key_valid: response.ok,
            api_key_length: process.env.ASSEMBLYAI_API_KEY ? process.env.ASSEMBLYAI_API_KEY.length : 0,
            api_key_prefix: process.env.ASSEMBLYAI_API_KEY ? process.env.ASSEMBLYAI_API_KEY.substring(0, 10) + '...' : 'N/A',
            response: data
        });
    } catch (error) {
        console.error('❌ AssemblyAI API test failed:', error);
        res.json({
            success: false,
            error: error.message
        });
    }
});

// Test real-time WebSocket connection to AssemblyAI
app.get('/test/assemblyai-ws', (req, res) => {
    console.log('🧪 Testing AssemblyAI WebSocket connection...');
    
    if (!process.env.ASSEMBLYAI_API_KEY) {
        return res.json({
            success: false,
            error: 'No AssemblyAI API key configured'
        });
    }
    
    try {
        const WS = require('ws');
        const testSocket = new WS('wss://api.assemblyai.com/v2/realtime/ws?sample_rate=8000&disable_partial_transcripts=false&speech_threshold=0.2', {
            headers: {
                'Authorization': process.env.ASSEMBLYAI_API_KEY
            }
        });
        
        let result = { success: false, messages: [] };
        
        testSocket.on('open', () => {
            console.log('✅ AssemblyAI WebSocket test connection opened');
            result.messages.push('WebSocket connection opened successfully');
            result.success = true;
            
            // Close test connection after 2 seconds
            setTimeout(() => {
                testSocket.close();
                res.json(result);
            }, 2000);
        });
        
        testSocket.on('message', (data) => {
            const message = JSON.parse(data);
            console.log('📥 AssemblyAI test message:', message);
            result.messages.push(`Received: ${message.message_type || 'unknown'}`);
        });
        
        testSocket.on('error', (error) => {
            console.error('❌ AssemblyAI WebSocket test error:', error);
            result.success = false;
            result.error = error.message;
            res.json(result);
        });
        
        // Timeout after 5 seconds
        setTimeout(() => {
            if (!res.headersSent) {
                testSocket.close();
                result.success = false;
                result.error = 'Connection timeout';
                res.json(result);
            }
        }, 5000);
        
    } catch (error) {
        console.error('❌ AssemblyAI WebSocket test failed:', error);
        res.json({
            success: false,
            error: error.message
        });
    }
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('❌ Unhandled error:', err);
    res.status(500).json({
        error: NODE_ENV === 'production' ? 'Internal server error' : err.message,
        timestamp: new Date().toISOString()
    });
});

// 404 handler
app.use('*', (req, res) => {
    res.status(404).json({
        error: 'Endpoint not found',
        path: req.originalUrl,
        available_endpoints: ['/', '/api', '/health', '/webhook/voice'],
        websocket_paths: ['/ws', '/stream']
    });
});

// Graceful shutdown handling
const connections = new Set();

server.on('connection', (connection) => {
    connections.add(connection);
    connection.on('close', () => {
        connections.delete(connection);
    });
});

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

function gracefulShutdown(signal) {
    console.log(`🔄 Received ${signal}. Attempting graceful shutdown...`);
    console.log('📴 Shutting down gracefully...');
    
    server.close(() => {
        console.log(`✅ Closed ${connections.size}/${connections.size} connections`);
        
        // Close WebSocket connections
        wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.close();
            }
        });
        
        console.log('🔌 Closing WebSocket connections...');
        console.log('✅ Graceful shutdown completed');
        process.exit(0);
    });
    
    // Force close after 10 seconds
    setTimeout(() => {
        console.log('⏰ Forcing shutdown after timeout');
        process.exit(1);
    }, 10000);
}

// Start server
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT} in ${NODE_ENV} mode`);
    console.log(`📡 WebSocket server ready for connections`);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('💥 Uncaught Exception:', error);
    gracefulShutdown('UNCAUGHT_EXCEPTION');
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
    gracefulShutdown('UNHANDLED_REJECTION');
}); 