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
                scriptSrc: ["'self'"],
                imgSrc: ["'self'", "data:", "https:"],
            },
        },
        hsts: {
            maxAge: 31536000,
            includeSubDomains: true,
            preload: true
        }
    }));
    console.log('✅ Production security enabled');
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

// Basic health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy', 
        environment: NODE_ENV,
        timestamp: new Date().toISOString(),
        ai_services: {
            openai: !!process.env.OPENAI_API_KEY,
            assemblyai: !!process.env.ASSEMBLYAI_API_KEY
        },
        n8n_webhook: !!process.env.N8N_WEBHOOK_URL,
        twilio_phone: process.env.TWILIO_PHONE_NUMBER || '+441733964789',
        active_calls: activeStreams.size
    });
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
            documentation: 'https://github.com/AlaxSwum/Real-Time-Phone-Call-Agent'
        }
    });
});

// Function to broadcast to all dashboard clients
function broadcastToClients(message) {
    dashboardClients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            try {
                client.send(JSON.stringify(message));
            } catch (error) {
                console.error('❌ Error broadcasting to client:', error);
            }
        }
    });
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
    <Say voice="alice">Hello! Welcome to the Real-Time Call Processor. Your call is being transcribed live by our AI system.</Say>
    <Start>
        <Stream url="${streamUrl}" />
    </Start>
    <Say voice="alice">Please speak your message. I'm listening and transcribing in real-time.</Say>
    <Pause length="30"/>
    <Say voice="alice">Thank you for your message. It has been processed by our AI system. Goodbye!</Say>
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
                    content: `You are an AI assistant for a real-time call processing system. Analyze the following voice message and provide a JSON response with:
                    {
                        "intent": "primary intent category",
                        "urgency": "low/medium/high",
                        "key_info": ["extracted information items"],
                        "sentiment": "positive/neutral/negative",
                        "follow_up": "recommended action",
                        "summary": "brief professional summary"
                    }`
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

// Dashboard WebSocket server
const dashboardWss = new WebSocket.Server({ 
    server,
    path: '/ws'
});

// Twilio Media Stream WebSocket server
const streamWss = new WebSocket.Server({ 
    server,
    path: '/stream'
});

let activeConnections = 0;

// Dashboard WebSocket connections
dashboardWss.on('connection', (ws, req) => {
    activeConnections++;
    dashboardClients.add(ws);
    const clientIP = req.socket.remoteAddress;
    console.log(`🔌 New dashboard WebSocket connection from ${clientIP} (Total: ${activeConnections})`);
    
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
        console.log(`🔌 Dashboard WebSocket disconnected (Total: ${activeConnections})`);
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
});

// Twilio Media Stream WebSocket connections
streamWss.on('connection', (ws, req) => {
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
        try {
            // Create WebSocket connection to AssemblyAI real-time service
            const WS = require('ws');
            const assemblyAIWS = new WS('wss://api.assemblyai.com/v2/realtime/ws?sample_rate=8000', {
                headers: {
                    'Authorization': process.env.ASSEMBLYAI_API_KEY
                }
            });
            
            assemblyAISocket = assemblyAIWS;
            
            assemblyAIWS.on('open', () => {
                console.log('✅ ASSEMBLYAI REAL-TIME WEBSOCKET CONNECTED for call:', callSid);
            });
            
            assemblyAIWS.on('message', (data) => {
                const transcript = JSON.parse(data);
                console.log('📥 Raw transcript event:', transcript);
                
                if (transcript.text) {
                    console.log(`🗣️ LIVE TRANSCRIPT [${transcript.message_type}]: "${transcript.text}"`);
                    console.log(`📊 Confidence: ${Math.round((transcript.confidence || 0) * 100)}%`);
                    
                    // Add to full transcript
                    if (transcript.message_type === 'FinalTranscript') {
                        fullTranscript += transcript.text + ' ';
                        console.log(`📝 FULL TRANSCRIPT SO FAR: "${fullTranscript.trim()}"`);
                    }
                    
                    // Broadcast to dashboard clients
                    broadcastToClients({
                        type: 'live_transcript',
                        data: {
                            callSid: callSid,
                            text: transcript.text,
                            confidence: transcript.confidence,
                            is_final: transcript.message_type === 'FinalTranscript',
                            timestamp: new Date().toISOString()
                        }
                    });
                    
                    // If final transcript, analyze with OpenAI
                    if (transcript.message_type === 'FinalTranscript' && transcript.text.trim().length > 10) {
                        console.log('🧠 Sending to OpenAI for analysis...');
                        analyzeTranscriptWithAI(transcript.text, callSid);
                    }
                }
            });
            
            assemblyAIWS.on('error', (error) => {
                console.error('❌ ASSEMBLYAI REAL-TIME ERROR:', error);
            });
            
            assemblyAIWS.on('close', () => {
                console.log('🔌 AssemblyAI WebSocket closed for call:', callSid);
            });
            
        } catch (error) {
            console.error('❌ FAILED TO CREATE ASSEMBLYAI SESSION:', error);
            console.error('🔍 Error details:', error.message);
        }
    } else {
        console.log('⚠️ NO ASSEMBLYAI API KEY - Real-time transcription disabled');
    }
    
    let mediaPacketCount = 0;
    
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            
            switch (data.event) {
                case 'start':
                    console.log('🎙️ STREAM STARTED for call:', callSid);
                    console.log('📋 Stream details:', JSON.stringify(data.start, null, 2));
                    activeStreams.set(callSid, {
                        callSid: callSid,
                        startTime: new Date(),
                        transcript: '',
                        status: 'active'
                    });
                    
                    // Broadcast stream start
                    broadcastToClients({
                        type: 'stream_started',
                        data: {
                            callSid: callSid,
                            timestamp: new Date().toISOString()
                        }
                    });
                    break;
                    
                case 'media':
                    mediaPacketCount++;
                    if (mediaPacketCount % 100 === 0) {
                        console.log(`📡 Received ${mediaPacketCount} audio packets from Twilio`);
                    }
                    
                    // Forward audio to AssemblyAI for real-time transcription
                    if (assemblyAISocket && assemblyAISocket.readyState === 1 && data.media.payload) {
                        try {
                            // Convert base64 audio data to the format AssemblyAI expects
                            const audioMessage = {
                                audio_data: data.media.payload
                            };
                            assemblyAISocket.send(JSON.stringify(audioMessage));
                            
                            if (mediaPacketCount % 200 === 0) {
                                console.log(`🎵 Sent ${mediaPacketCount} audio packets to AssemblyAI`);
                            }
                        } catch (audioError) {
                            console.error('❌ Error sending audio to AssemblyAI:', audioError);
                        }
                    } else if (!assemblyAISocket) {
                        if (mediaPacketCount === 1) {
                            console.log('⚠️ No AssemblyAI socket available to send audio to');
                        }
                    } else if (assemblyAISocket.readyState !== 1) {
                        if (mediaPacketCount === 1) {
                            console.log(`⚠️ AssemblyAI socket not ready (state: ${assemblyAISocket.readyState})`);
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
                    if (fullTranscript.trim().length > 10) {
                        console.log('🗣️ FULL CALL TRANSCRIPT: "' + fullTranscript.trim() + '"');
                        analyzeTranscriptWithAI(fullTranscript.trim(), callSid);
                    } else {
                        console.log('⚠️ No transcript captured during call');
                    }
                    
                    activeStreams.delete(callSid);
                    
                    // Broadcast stream end
                    broadcastToClients({
                        type: 'stream_ended',
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
        dashboardWss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.close();
            }
        });
        
        streamWss.clients.forEach((client) => {
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
server.listen(PORT, () => {
    console.log(`🚀 Real-Time Call Processor running on port ${PORT}`);
    console.log(`🌍 Environment: ${NODE_ENV}`);
    console.log(`🔗 Health check: http://localhost:${PORT}/health`);
    console.log(`🔌 Dashboard WebSocket: ws://localhost:${PORT}/ws`);
    console.log(`🎙️ Stream WebSocket: ws://localhost:${PORT}/stream`);
    if (NODE_ENV === 'production') {
        console.log('🛡️ Production security features enabled');
    }
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