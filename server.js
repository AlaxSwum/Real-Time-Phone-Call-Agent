require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const WebSocket = require('ws');
const http = require('http');

// AI Service imports (uncomment when implementing)
// const OpenAI = require('openai');
// const { AssemblyAI } = require('assemblyai');

const app = express();
const server = http.createServer(app);

// Initialize AI clients (uncomment when implementing)
// const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
// const assemblyAI = new AssemblyAI({ apiKey: process.env.ASSEMBLYAI_API_KEY });

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

// Basic health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy', 
        environment: NODE_ENV,
        timestamp: new Date().toISOString(),
        ai_services: {
            openai: !!process.env.OPENAI_API_KEY,
            assemblyai: !!process.env.ASSEMBLYAI_API_KEY
        }
    });
});

// Root endpoint
app.get('/', (req, res) => {
    res.json({
        message: 'Real-Time Call Processor API',
        version: '1.0.0',
        environment: NODE_ENV,
        endpoints: {
            health: '/health',
            websocket: 'ws://your-render-url',
            documentation: 'https://github.com/AlaxSwum/Real-Time-Phone-Call-Agent'
        }
    });
});

// AI Processing Functions (to be implemented)
async function processAudioWithAI(audioData) {
    try {
        // TODO: Implement AssemblyAI transcription
        // const transcript = await assemblyAI.transcripts.create({
        //     audio_url: audioData.url,
        //     language_detection: true
        // });
        
        // TODO: Implement OpenAI response generation
        // const response = await openai.chat.completions.create({
        //     model: "gpt-4",
        //     messages: [{ role: "user", content: transcript.text }]
        // });
        
        // For now, return placeholder
        return {
            transcript: "Placeholder transcript",
            ai_response: "Placeholder AI response",
            processed: true
        };
    } catch (error) {
        console.error('❌ AI processing error:', error);
        return {
            error: 'AI processing failed',
            processed: false
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
        available_endpoints: ['/', '/health'],
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