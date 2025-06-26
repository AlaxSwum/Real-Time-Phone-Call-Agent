// Simple public webhook handler for Twilio
const { createClient } = require('@deepgram/sdk');

// Initialize Deepgram
const deepgramApiKey = process.env.DEEPGRAM_API_KEY || '7fba0511f54adc490a379bd27cf84720b71ae433';
const deepgram = createClient(deepgramApiKey);

// Main handler function
module.exports = async (req, res) => {
    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    // Handle preflight requests
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    
    const { method, url } = req;
    const path = url.split('?')[0];
    
    console.log(`📞 ${method} ${path} - ${new Date().toISOString()}`);
    console.log(`📋 Headers:`, req.headers);
    console.log(`📋 Body:`, req.body);
    
    try {
        // Route handling
        if (path === '/health') {
            return res.json({
                status: 'healthy',
                timestamp: new Date().toISOString(),
                environment: 'production',
                services: {
                    deepgram: {
                        configured: !!deepgramApiKey,
                        status: 'operational'
                    }
                },
                server: {
                    platform: 'vercel_public_webhook',
                    uptime: process.uptime(),
                    memory: process.memoryUsage()
                }
            });
        }
        
        if (path === '/debug') {
            return res.json({
                status: 'Server is running (Public Webhook)',
                timestamp: new Date().toISOString(),
                environment: 'production',
                platform: 'vercel_public_webhook',
                method: method,
                path: path,
                headers: req.headers,
                deployment_version: 'PUBLIC-WEBHOOK-V1'
            });
        }
        
        if (path === '/twilio-config') {
            const protocol = req.headers['x-forwarded-proto'] || 'https';
            const host = req.headers['x-forwarded-host'] || req.headers['host'];
            const webhookUrl = `${protocol}://${host}/voice`;
            
            return res.json({
                status: 'success',
                webhook_url: webhookUrl,
                current_host: host,
                protocol: protocol,
                instructions: [
                    "1. Go to your Twilio Console",
                    "2. Navigate to Phone Numbers > Active numbers", 
                    "3. Click on your phone number",
                    `4. Set the webhook URL to: ${webhookUrl}`,
                    "5. Set HTTP method to POST",
                    "6. Save the configuration"
                ],
                note: "Public webhook - no authentication required",
                timestamp: new Date().toISOString()
            });
        }
        
        if (path === '/voice' || path === '/webhook/voice') {
            console.log('🔥 VOICE WEBHOOK CALLED!');
            
            if (method !== 'POST') {
                return res.status(405).json({ error: 'Method not allowed' });
            }
            
            const { CallSid, From, To, CallStatus } = req.body;
            console.log(`📞 Call from ${From} to ${To} (${CallStatus})`);
            console.log(`🆔 Call SID: ${CallSid}`);
            
            // Get current host for URLs
            const protocol = req.headers['x-forwarded-proto'] || 'https';
            const host = req.headers['x-forwarded-host'] || req.headers['host'];
            
            // Check if this is bridge mode
            const bridgeNumber = process.env.BRIDGE_TARGET_NUMBER;
            
            if (bridgeNumber) {
                console.log(`🌉 Bridge mode: Connecting ${From} to ${bridgeNumber}`);
                
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
                
                console.log('🌉 Bridge TwiML Response generated');
                res.setHeader('Content-Type', 'text/xml');
                return res.send(bridgeTwiML);
                
            } else {
                console.log('🎙️ Recording mode (no bridge number configured)');
                
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
                
                console.log('📋 Recording TwiML Response generated');
                res.setHeader('Content-Type', 'text/xml');
                return res.send(twimlResponse);
            }
        }
        
        if (path === '/webhook/recording') {
            console.log('🎵 Recording webhook called');
            console.log('📋 Recording data:', req.body);
            
            const { RecordingUrl, CallSid, RecordingDuration } = req.body;
            
            if (RecordingUrl && RecordingDuration > 2) {
                console.log(`🎵 Processing recording: ${RecordingUrl}`);
                
                // Send to n8n if configured
                if (process.env.N8N_WEBHOOK_URL) {
                    try {
                        const webhookData = {
                            type: 'recording_completed',
                            callSid: CallSid,
                            recordingUrl: RecordingUrl,
                            duration: RecordingDuration,
                            timestamp: new Date().toISOString()
                        };
                        
                        await fetch(process.env.N8N_WEBHOOK_URL, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(webhookData)
                        });
                        
                        console.log('✅ Recording data sent to n8n');
                    } catch (error) {
                        console.error('❌ Error sending to n8n:', error.message);
                    }
                }
            }
            
            return res.status(200).send('OK');
        }
        
        // Default 404 for unknown paths
        return res.status(404).json({
            error: 'Endpoint not found',
            path: path,
            available_endpoints: ['/health', '/debug', '/twilio-config', '/voice', '/webhook/voice', '/webhook/recording']
        });
        
    } catch (error) {
        console.error('❌ Webhook error:', error);
        return res.status(500).json({
            error: 'Internal server error',
            message: error.message,
            timestamp: new Date().toISOString()
        });
    }
}; 