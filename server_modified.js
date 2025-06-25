require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { processAudio } = require('./audioProcessor');
const { detectIntent } = require('./intentDetector');
const { forwardToN8n } = require('./webhookForwarder');

const app = express();

// Middleware for parsing request bodies
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000; // Changed back to 3000 to match ngrok
const HOST = '0.0.0.0'; // Changed back to 0.0.0.0 for better binding

// Store active call sessions
const activeCalls = new Map();

// Basic route for health check
app.get('/', (req, res) => {
  res.send('Twilio Media Stream Processor is running');
});

// TwiML route for Twilio webhook
app.post('/twiml', (req, res) => {
  // Get the current ngrok URL from environment or use a fallback
  const ngrokUrl = process.env.NGROK_URL || req.protocol + '://' + req.get('host');
  
  // Convert http:// to wss:// for WebSocket connection
  const wsUrl = ngrokUrl.replace('http://', 'wss://').replace('https://', 'wss://');
  
  // Generate TwiML response with Stream element
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Start>
    <Stream url="${wsUrl}?callSid={{CallSid}}" />
  </Start>
  <Say>Hello! I'm your AI assistant. How can I help you today?</Say>
  <Pause length="60" />
</Response>`;

  console.log('Sending TwiML response with Stream URL:', wsUrl);
  
  // Send TwiML response
  res.type('text/xml');
  res.send(twiml);
  
  console.log(`TwiML response sent with Stream URL: ${wsUrl}?callSid={{CallSid}}`);
});

// WebSocket connection handler
wss.on('connection', (ws, req) => {
  console.log('=== New WebSocket connection established ===');
  console.log(`Connection time: ${new Date().toISOString()}`);
  console.log(`Connection URL: ${req.url}`);
  console.log(`Client IP: ${req.socket.remoteAddress}`);
  console.log(`Headers: ${JSON.stringify(req.headers)}`);
  
  // Extract call SID from URL if available
  const callSid = new URLSearchParams(req.url.slice(1)).get('callSid');
  
  if (callSid) {
    console.log(`Call SID: ${callSid}`);
    console.log('Media stream connection initialized and ready to receive audio');
    
    // Initialize call session
    activeCalls.set(callSid, {
      ws,
      audioBuffer: [],
      transcriptionBuffer: [],
      lastProcessedTimestamp: Date.now(),
      messageCount: 0,
      mediaChunksReceived: 0
    });
    console.log(`Active calls count: ${activeCalls.size}`);
  } else {
    console.warn('No Call SID provided in connection');
    console.warn(`Connection URL parsing failed. Raw URL: ${req.url}`);
  }

  // Handle incoming messages
  ws.on('message', async (message) => {
    try {
      const msg = JSON.parse(message);
      
      // Handle different message types from Twilio Media Streams
      switch (msg.event) {
        case 'connected':
          console.log('=== Media stream connected ===');
          console.log(`Protocol: ${msg.protocol}, Version: ${msg.version}`);
          break;
          
        case 'start':
          console.log('=== Media stream started ===');
          console.log(`Stream SID: ${msg.streamSid}`);
          console.log(`Call SID: ${msg.start?.callSid}`);
          console.log(`Tracks: ${msg.start?.tracks?.join(', ')}`);
          console.log(`Media Format: ${msg.start?.mediaFormat?.encoding}, ${msg.start?.mediaFormat?.sampleRate}Hz`);
          if (msg.start?.customParameters) {
            console.log('Custom Parameters:', msg.start.customParameters);
          }
          break;
          
        case 'media':
          if (callSid && activeCalls.has(callSid)) {
            // Process audio data
            const audioData = Buffer.from(msg.media.payload, 'base64');
            const callSession = activeCalls.get(callSid);
            
            // Increment media chunks counter
            callSession.mediaChunksReceived++;
            callSession.messageCount++;
            
            // Log media chunk info (but not for every chunk to avoid console spam)
            if (msg.sequenceNumber % 100 === 0 || callSession.mediaChunksReceived <= 5) {
              console.log(`Receiving media: Track ${msg.media.track}, Chunk ${msg.media.chunk}, Timestamp ${msg.media.timestamp}ms`);
              console.log(`Media payload size: ${audioData.length} bytes`);
              console.log(`Total media chunks received: ${callSession.mediaChunksReceived}`);
              console.log(`Total messages received: ${callSession.messageCount}`);
            }
            
            // Add to buffer
            callSession.audioBuffer.push(audioData);
            console.log(`Audio buffer size: ${callSession.audioBuffer.length} chunks`);
            
            // Process audio in chunks (every 2 seconds)
            const currentTime = Date.now();
            const timeSinceLastProcess = currentTime - callSession.lastProcessedTimestamp;
            console.log(`Time since last processing: ${timeSinceLastProcess}ms`);
            
            if (timeSinceLastProcess >= 2000 && callSession.audioBuffer.length > 0) {
              console.log(`=== PROCESSING AUDIO AFTER ${timeSinceLastProcess}ms ===`);
              console.log(`Audio buffer has ${callSession.audioBuffer.length} chunks to process`);
              // Combine audio chunks
              const combinedAudio = Buffer.concat(callSession.audioBuffer);
              const bufferSizeKb = combinedAudio.length / 1024;
              console.log(`Processing audio chunk: ${bufferSizeKb.toFixed(2)} KB`);
              
              callSession.audioBuffer = [];
              callSession.lastProcessedTimestamp = currentTime;
              
              // Process audio to get transcription
              try {
                console.log('Sending audio to OpenAI Whisper for transcription...');
                const transcription = await processAudio(combinedAudio);
                
                if (transcription && transcription.trim()) {
                  console.log(`✓ Transcription received: "${transcription}"`);
                  
                  // Add to transcription buffer
                  callSession.transcriptionBuffer.push(transcription);
                  console.log(`Transcription buffer now has ${callSession.transcriptionBuffer.length} segments`);
                  
                  // Detect intent from transcription
                  console.log('Analyzing transcription for intent detection...');
                  const intentResult = await detectIntent(transcription);
                  
                  // If we have a structured result with high confidence, forward it
                  if (intentResult) {
                    console.log(`✓ Intent detected: ${intentResult.intent} (confidence: ${intentResult.confidence.toFixed(2)})`);
                    
                    if (intentResult.confidence > 0.7) {
                      console.log('High confidence intent detected, forwarding to n8n webhook');
                      console.log('Intent details:', JSON.stringify(intentResult.details, null, 2));
                      
                      // Forward to n8n webhook
                      await forwardToN8n({
                        callSid,
                        transcription,
                        intent: intentResult
                      });
                      console.log('✓ Successfully forwarded to n8n webhook');
                      
                      // Clear transcription buffer after successful processing
                      callSession.transcriptionBuffer = [];
                      console.log('Transcription buffer cleared after successful processing');
                    } else {
                      console.log(`Intent confidence too low (${intentResult.confidence.toFixed(2)}), not forwarding to webhook`);
                    }
                  } else {
                    console.log('No intent detected from transcription');
                  }
                } else {
                  console.log('No transcription received or empty transcription');
                }
              } catch (error) {
                console.error('Error processing audio:', error);
              }
            }
          }
          break;
          
        case 'stop':
          console.log('=== Media stream stopped ===');
          console.log(`Stream SID: ${msg.streamSid}`);
          console.log(`Call SID: ${msg.stop?.callSid || 'Unknown'}`);
          console.log(`Stop reason: ${msg.stop?.reason || 'Not provided'}`);
          
          // Process any remaining audio in buffer
          if (callSid && activeCalls.has(callSid)) {
            const callSession = activeCalls.get(callSid);
            console.log(`Processing final transcription buffer with ${callSession.transcriptionBuffer.length} segments`);
            
            // Process any remaining transcriptions
            if (callSession.transcriptionBuffer.length > 0) {
              const fullTranscription = callSession.transcriptionBuffer.join(' ');
              console.log(`Final transcription: ${fullTranscription}`);
              
              const intentResult = await detectIntent(fullTranscription);
              console.log(`Final intent detection result: ${intentResult ? intentResult.intent : 'None'} (confidence: ${intentResult ? intentResult.confidence : 0})`);
              
              if (intentResult) {
                console.log('Forwarding final data to n8n webhook');
                await forwardToN8n({
                  callSid,
                  transcription: fullTranscription,
                  intent: intentResult,
                  isFinal: true
                });
              }
            }
            
            // Clean up
            activeCalls.delete(callSid);
            console.log(`Call session cleaned up. Active calls remaining: ${activeCalls.size}`);
          }
          break;
          
        case 'dtmf':
          console.log('=== DTMF detected ===');
          console.log(`DTMF digit: ${msg.dtmf?.digit}`);
          console.log(`DTMF type: ${msg.dtmf?.type}`);
          break;
          
        case 'mark':
          console.log('=== Mark event received ===');
          console.log(`Mark ID: ${msg.mark?.id}`);
          break;
          
        default:
          console.log(`Unknown event type: ${msg.event}`, msg);
      }
    } catch (error) {
      console.error('Error handling WebSocket message:', error);
    }
  });

  // Handle WebSocket closure
  ws.on('close', () => {
    console.log('WebSocket connection closed');
    
    // Clean up if call SID exists
    if (callSid && activeCalls.has(callSid)) {
      activeCalls.delete(callSid);
    }
  });

  // Handle WebSocket errors
  ws.on('error', (error) => {
    console.error('=== WebSocket error ===');
    console.error(`Error message: ${error.message}`);
    console.error(`Error name: ${error.name}`);
    console.error(`Error stack: ${error.stack}`);
    
    if (callSid && activeCalls.has(callSid)) {
      console.error(`Error occurred for Call SID: ${callSid}`);
    }
  });
});

// Start the server with error handling for port conflicts
server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Error: Port ${PORT} is already in use.`);
    console.error('Please try one of the following:');
    console.error('1. Stop the process using this port');
    console.error('2. Use a different port by setting the PORT environment variable:');
    console.error('   PORT=3001 node server.js');
    process.exit(1);
  } else {
    console.error('Server error:', error);
    process.exit(1);
  }
});

// Modified to explicitly specify host
server.listen(PORT, HOST, () => {
  console.log('=================================================');
  console.log(`Twilio Media Stream Processor started successfully`);
  console.log(`Server is running on ${HOST}:${PORT}`);
  console.log(`Waiting for Twilio Media Stream connections...`);
  console.log('=================================================');
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Twilio Account SID: ${process.env.TWILIO_ACCOUNT_SID ? '✓ Configured' : '✗ Missing'}`);
  console.log(`OpenAI API Key: ${process.env.OPENAI_API_KEY ? '✓ Configured' : '✗ Missing'}`);
  console.log(`n8n Webhook URL: ${process.env.N8N_WEBHOOK_URL ? '✓ Configured' : '✗ Missing'}`);
  console.log('=================================================');
});

// Handle process termination gracefully (only for explicit shutdown)
// Removed automatic SIGINT/SIGTERM handlers to keep server running
// Use Ctrl+C twice or kill command to force shutdown if needed

// Keep the process alive
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  // Don't exit on uncaught exceptions to keep server running
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Don't exit on unhandled rejections to keep server running
});