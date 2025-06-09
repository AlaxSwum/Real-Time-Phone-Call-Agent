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
        twilio_phone: process.env.TWILIO_PHONE_NUMBER || '+441733964789'
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
        version: '1.0.0',
        environment: NODE_ENV,
        endpoints: {
            health: '/health',
            voice_webhook: '/webhook/voice',
            dashboard: '/',
            websocket: 'ws://your-render-url',
            documentation: 'https://github.com/AlaxSwum/Real-Time-Phone-Call-Agent'
        }
    });
});

// Twilio Voice Webhook Endpoint
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
    
    // Broadcast call start to all connected WebSocket clients
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
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">Hello! Welcome to the Real-Time Call Processor. Your call is being transcribed live by our AI system.</Say>
    <Start>
        <Stream url="wss://real-time-phone-call-agent.onrender.com/stream/${CallSid}" />
    </Start>
    <Say voice="alice">Please speak your message after the beep.</Say>
    <Pause length="30"/>
    <Say voice="alice">Thank you for your message. It has been processed by our AI system. Goodbye!</Say>
</Response>`;
    
    res.type('text/xml');
    res.send(twiml);
});

// Twilio Recording Webhook
app.post('/webhook/recording', async (req, res) => {
    console.log('🎙️ Recording completed:', req.body);
    
    const { RecordingUrl, CallSid, RecordingDuration } = req.body;
    
    console.log(`🎵 Recording URL: ${RecordingUrl}`);
    console.log(`⏱️ Duration: ${RecordingDuration} seconds`);
    
    // Process recording with AI - REAL IMPLEMENTATION
    console.log('🚀 Starting AI processing...');
    const aiResult = await processAudioWithAI({ url: RecordingUrl });
    
    // Enhanced data payload for n8n
    const enhancedPayload = {
        type: 'twilio_recording_with_ai',
        call_data: req.body,
        ai_processing: aiResult,
        timestamp: new Date().toISOString()
    };
    
    // Send recording data with AI analysis to n8n if configured
    if (process.env.N8N_WEBHOOK_URL) {
        fetch(process.env.N8N_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(enhancedPayload)
        }).then(response => {
            console.log('✅ Enhanced data sent to n8n webhook:', response.status);
        }).catch(error => {
            console.error('❌ Error sending enhanced data to n8n:', error);
        });
    }
    
    // Log AI results for monitoring
    if (aiResult.processed) {
        console.log('🎯 INTENT DETECTED:', aiResult.analysis?.intent);
        console.log('⚡ URGENCY LEVEL:', aiResult.analysis?.urgency);
        console.log('😊 SENTIMENT:', aiResult.analysis?.sentiment);
        console.log('📋 AI SUMMARY:', aiResult.analysis?.summary);
        console.log('🎯 RECOMMENDED ACTION:', aiResult.analysis?.follow_up);
        if (aiResult.analysis?.key_info && aiResult.analysis.key_info.length > 0) {
            console.log('🔑 KEY INFORMATION:', aiResult.analysis.key_info.join(', '));
        }
        console.log('🤖 Full AI analysis sent to n8n webhook');
    } else {
        console.log('❌ AI processing failed:', aiResult.error);
    }
    
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">Thank you for your message. It has been processed and analyzed by our AI system. We will respond accordingly. Goodbye!</Say>
</Response>`;
    
    res.type('text/xml');
    res.send(twiml);
});

// Twilio Recording Status Webhook
app.post('/webhook/recording-status', (req, res) => {
    console.log('📊 Recording status update:', req.body);
    res.status(200).send('OK');
});

// Manual AI Processing Test Endpoint
app.post('/test/ai-processing', async (req, res) => {
    const { recording_url } = req.body;
    
    if (!recording_url) {
        return res.status(400).json({ 
            error: 'Missing recording_url in request body',
            example: { recording_url: 'https://your-recording-url.mp3' }
        });
    }
    
    console.log('🧪 Manual AI processing test for:', recording_url);
    
    try {
        const result = await processAudioWithAI({ url: recording_url });
        res.json({
            success: true,
            result: result,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Helper function to download Twilio recordings with authentication
async function downloadTwilioRecording(recordingUrl) {
    try {
        const accountSid = process.env.TWILIO_ACCOUNT_SID;
        const authToken = process.env.TWILIO_AUTH_TOKEN;
        
        if (!accountSid || !authToken) {
            throw new Error('Twilio credentials missing');
        }
        
        // Create basic auth header
        const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
        
        console.log('📡 Fetching recording with Twilio credentials...');
        const response = await fetch(recordingUrl, {
            method: 'GET',
            headers: {
                'Authorization': `Basic ${auth}`,
                'User-Agent': 'Real-Time-Call-Processor/1.0'
            }
        });
        
        if (!response.ok) {
            throw new Error(`Failed to download recording: ${response.status} ${response.statusText}`);
        }
        
        const audioBuffer = await response.arrayBuffer();
        console.log(`✅ Downloaded ${audioBuffer.byteLength} bytes from Twilio`);
        
        return Buffer.from(audioBuffer);
    } catch (error) {
        console.error('❌ Error downloading Twilio recording:', error);
        throw error;
    }
}

// AI Processing Functions
async function processAudioWithAI(audioData) {
    try {
        console.log('🤖 Starting AI processing for audio:', audioData.url);
        
        // Step 1: Download audio from Twilio with authentication
        console.log('📥 Downloading audio from Twilio...');
        const audioBuffer = await downloadTwilioRecording(audioData.url);
        
        // Step 2: Upload to AssemblyAI for transcription
        console.log('📤 Uploading to AssemblyAI...');
        const uploadUrl = await assemblyAI.files.upload(audioBuffer);
        
        // Step 3: Transcribe audio with AssemblyAI
        console.log('📝 Starting transcription...');
        const transcript = await assemblyAI.transcripts.create({
            audio_url: uploadUrl,
            language_detection: true,
            speaker_labels: true,
            sentiment_analysis: true,
            entity_detection: true,
            iab_categories: true
        });
        
        // Wait for transcription to complete
        let transcriptResult = transcript;
        while (transcriptResult.status !== 'completed' && transcriptResult.status !== 'error') {
            await new Promise(resolve => setTimeout(resolve, 1000));
            transcriptResult = await assemblyAI.transcripts.get(transcript.id);
            console.log('⏳ Transcription status:', transcriptResult.status);
        }
        
        if (transcriptResult.status === 'error') {
            throw new Error(`Transcription failed: ${transcriptResult.error}`);
        }
        
        const transcriptText = transcriptResult.text;
        console.log('✅ Transcription completed!');
        console.log('🗣️ CALLER SAID: "' + transcriptText + '"');
        
        // Step 2: Analyze intent and generate response with OpenAI
        console.log('🧠 Analyzing intent and generating response...');
        const aiResponse = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                {
                    role: "system",
                    content: `You are an AI assistant for a real-time call processing system. Analyze the following voice message and:
                    1. Identify the caller's intent (inquiry, complaint, request, booking, etc.)
                    2. Extract key information (contact details, dates, specific requests)
                    3. Determine urgency level (low, medium, high)
                    4. Suggest appropriate follow-up actions
                    5. Generate a professional summary
                    
                    Provide your response in this JSON format:
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
                    content: `Voice message transcription: "${transcriptText}"`
                }
            ],
            temperature: 0.3
        });
        
        let aiAnalysis;
        try {
            aiAnalysis = JSON.parse(aiResponse.choices[0].message.content);
        } catch (parseError) {
            // Fallback if JSON parsing fails
            aiAnalysis = {
                intent: "general_inquiry",
                urgency: "medium",
                key_info: [transcriptText.substring(0, 100)],
                sentiment: "neutral",
                follow_up: "Review and respond appropriately",
                summary: aiResponse.choices[0].message.content
            };
        }
        
        console.log('✅ AI analysis completed:', aiAnalysis);
        
        return {
            transcript: transcriptText,
            analysis: aiAnalysis,
            audio_insights: {
                sentiment: transcriptResult.sentiment_analysis_results,
                entities: transcriptResult.entities,
                categories: transcriptResult.iab_categories_result
            },
            processed: true,
            timestamp: new Date().toISOString()
        };
    } catch (error) {
        console.error('❌ AI processing error:', error);
        return {
            error: `AI processing failed: ${error.message}`,
            processed: false,
            timestamp: new Date().toISOString()
        };
    }
}

// WebSocket server for real-time communication
const wss = new WebSocket.Server({ 
    server,
    path: '/ws'
});

let activeConnections = 0;

wss.on('connection', (ws, req) => {
    activeConnections++;
    const clientIP = req.socket.remoteAddress;
    console.log(`🔌 New WebSocket connection from ${clientIP} (Total: ${activeConnections})`);
    
    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            console.log('📧 Received message:', data.type);
            
            switch (data.type) {
                case 'audio':
                    // Process audio with AI
                    const aiResult = await processAudioWithAI(data.payload);
                    ws.send(JSON.stringify({
                        type: 'ai_response',
                        data: aiResult,
                        timestamp: new Date().toISOString()
                    }));
                    break;
                    
                case 'ping':
                    ws.send(JSON.stringify({
                        type: 'pong',
                        timestamp: new Date().toISOString()
                    }));
                    break;
                    
                default:
                    // Echo other messages
                    ws.send(JSON.stringify({
                        type: 'response',
                        data: 'Message received successfully',
                        original_type: data.type,
                        timestamp: new Date().toISOString()
                    }));
            }
        } catch (error) {
            console.error('❌ Error parsing message:', error);
            ws.send(JSON.stringify({
                type: 'error',
                message: 'Invalid message format',
                timestamp: new Date().toISOString()
            }));
        }
    });
    
    ws.on('close', () => {
        activeConnections--;
        console.log(`🔌 WebSocket connection closed (Remaining: ${activeConnections})`);
    });
    
    ws.on('error', (error) => {
        console.error('❌ WebSocket error:', error);
    });
    
    // Send welcome message
    ws.send(JSON.stringify({
        type: 'welcome',
        message: 'Connected to Real-Time Call Processor',
        server_time: new Date().toISOString(),
        connection_id: Date.now()
    }));
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
        available_endpoints: ['/', '/api', '/health', '/webhook/voice', '/webhook/recording', '/webhook/recording-status', '/test/ai-processing'],
        websocket_path: '/ws'
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
server.listen(PORT, () => {
    console.log(`🚀 Real-Time Call Processor running on port ${PORT}`);
    console.log(`🌍 Environment: ${NODE_ENV}`);
    console.log(`🔗 Health check: http://localhost:${PORT}/health`);
    console.log(`🔌 WebSocket endpoint: ws://localhost:${PORT}/ws`);
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