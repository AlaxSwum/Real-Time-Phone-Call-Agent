# Real-Time Phone Call Agent with Twilio Bridge - Railway Optimized

A powerful real-time phone call processing system that connects two phone numbers via Twilio while capturing and transcribing conversations with high accuracy. Optimized for Railway hosting with sentence-aware transcription.

## 🚀 Features

### Bridge Mode
- **Two-way call bridging**: Connect caller to target number automatically
- **Real-time transcription**: Capture both sides of conversation with 93.3%+ accuracy
- **Sentence-aware processing**: Output complete sentences every 2-3 seconds
- **Speaker identification**: Distinguish between different speakers
- **High accuracy**: AssemblyAI with enhanced word boosting for business terms

### Real-time Analysis
- **Intent detection**: Automatically detect meeting requests, support needs, etc.
- **Email extraction**: Find and validate email addresses from speech
- **Meeting scheduling**: Extract dates, times, and meeting details
- **AI analysis**: OpenAI-powered conversation insights
- **Dashboard**: Real-time web interface for monitoring calls

## 🛠️ Railway Setup Guide

### 1. Environment Variables

Set these in your Railway project settings:

#### Required
```bash
# AssemblyAI (Primary transcription service - 93.3% accuracy)
ASSEMBLYAI_API_KEY=your_assemblyai_api_key_here

# Twilio (For phone call handling)
TWILIO_ACCOUNT_SID=your_twilio_account_sid
TWILIO_AUTH_TOKEN=your_twilio_auth_token

# Bridge Target (The number to connect calls to)
BRIDGE_TARGET_NUMBER=+1234567890  # Replace with target phone number
```

#### Optional
```bash
# OpenAI (For AI analysis)
OPENAI_API_KEY=your_openai_api_key_here

# n8n Integration (For workflow automation)
N8N_WEBHOOK_URL=https://your-n8n-instance.com/webhook/calls

# Railway Environment (Auto-detected, but can be set manually)
RAILWAY_STATIC_URL=your-app-name.railway.app
RAILWAY_PUBLIC_DOMAIN=your-app-name.railway.app
```

### 2. Deploy to Railway

1. **Fork this repository**
2. **Connect to Railway**: Link your GitHub repo to Railway
3. **Set environment variables**: Add all required variables in Railway dashboard
4. **Deploy**: Railway will automatically build and deploy

### 3. Configure Twilio Webhook

1. **Get your Railway URL**: After deployment, note your app URL (e.g., `https://your-app.railway.app`)

2. **Set Twilio webhook**:
   - Go to [Twilio Console](https://console.twilio.com/)
   - Navigate to Phone Numbers → Manage → Active numbers
   - Click your phone number
   - Set webhook URL to: `https://your-app.railway.app/voice`
   - Set HTTP method to: `POST`
   - Save configuration

3. **Test the setup**:
   - Call your Twilio number
   - Should hear: "Connecting your call, please wait..."
   - Gets connected to your bridge target number
   - Real-time transcription appears on dashboard

## 📱 How It Works

### Bridge Call Flow
1. **Incoming call** → Twilio number
2. **Greeting** → "Connecting your call, please wait..."
3. **Bridge connection** → Dials target number
4. **Real-time streaming** → Audio sent to your Railway app
5. **Transcription** → AssemblyAI processes audio in 2-3 second chunks
6. **Sentence output** → Complete sentences displayed every 2-3 seconds
7. **Analysis** → AI extracts intents, emails, meeting details
8. **Recording** → Full conversation recorded for post-call analysis

### Technical Architecture
```
[Caller] → [Twilio] → [Railway App] → [AssemblyAI] → [Dashboard]
    ↓           ↓           ↓             ↓            ↓
[Target]   [Bridge]   [WebSocket]   [HTTP API]   [Real-time UI]
```

## 🎯 Optimizations for High Accuracy

### Sentence-Aware Processing
- **Buffer accumulation**: Collects partial transcripts
- **Sentence boundary detection**: Waits for complete sentences
- **Smart timeout**: Forces output after 8 seconds to prevent hanging
- **Quality filtering**: Skips silent or low-quality audio chunks

### AssemblyAI Configuration
```javascript
{
  speech_model: 'best',           // Highest accuracy model
  punctuate: true,                // Add punctuation
  format_text: true,              // Smart formatting
  speaker_labels: true,           // Identify speakers
  speakers_expected: 2,           // Bridge calls have 2 speakers
  word_boost: [                   // Enhanced accuracy for business terms
    'meeting', 'schedule', 'arrange', 'discuss', 'appointment',
    'email', 'call', 'phone', 'contact', 'business', 'work'
  ],
  boost_param: 'high'             // Maximum word boost effect
}
```

### Railway-Specific Optimizations
- **HTTPS URLs**: Railway provides HTTPS by default
- **Environment detection**: Auto-detects Railway environment variables
- **WebSocket compatibility**: Uses query parameter format for better compatibility
- **Static file serving**: Temporary audio files served from `/tmp`

## 🔧 Configuration Options

### Bridge Mode Settings
```bash
# Enable bridge mode (connect calls to target number)
BRIDGE_TARGET_NUMBER=+1234567890

# Disable bridge mode (analysis only)
# BRIDGE_TARGET_NUMBER=  # Leave empty or unset
```

### Transcription Timing
- **Minimum chunk**: 1 second of audio (8000 bytes)
- **Preferred chunk**: 3 seconds of audio (24000 bytes)
- **Processing interval**: Every 1.5 seconds
- **Sentence timeout**: 8 seconds maximum wait
- **Output frequency**: Complete sentences every 2-3 seconds

## 📊 Dashboard Features

Access your dashboard at: `https://your-app.railway.app`

### Real-time Monitoring
- **Live transcription**: See conversation as it happens
- **Call status**: Track bridge connection progress
- **Speaker identification**: See who's speaking
- **Intent detection**: Automatic conversation analysis
- **Audio quality**: Monitor signal strength and clarity

### Call Analytics
- **Meeting detection**: Automatically identify scheduling requests
- **Email extraction**: Capture email addresses mentioned
- **Action items**: Extract tasks and follow-ups
- **Sentiment analysis**: Gauge conversation tone
- **Summary generation**: AI-powered call summaries

## 🔗 API Endpoints

### Webhooks (for Twilio)
- `POST /voice` - Main webhook for incoming calls
- `POST /webhook/recording` - Recording completion callback
- `POST /webhook/dial-status` - Bridge call status updates

### Information
- `GET /` - Dashboard interface
- `GET /api` - API information and features
- `GET /health` - Service health check
- `GET /debug` - Detailed system information
- `GET /twilio-config` - Twilio setup instructions

### WebSocket
- `WS /?callSid=CALLSID` - Real-time audio streaming (recommended)
- `WS /ws` - Dashboard real-time updates

## 🚨 Troubleshooting

### Common Issues

1. **No transcription appearing**
   - Check ASSEMBLYAI_API_KEY is set correctly
   - Verify Railway app is receiving audio (check logs)
   - Ensure Twilio webhook is pointing to correct URL

2. **Bridge not connecting**
   - Verify BRIDGE_TARGET_NUMBER format (+1234567890)
   - Check target number can receive calls
   - Review Twilio logs for dial failures

3. **Audio quality issues**
   - Phone connection quality affects transcription
   - Ensure good cellular/landline connection
   - Check for background noise

4. **WebSocket connection failures**
   - Railway hosting may block some WebSocket connections
   - System automatically falls back to HTTP chunked processing
   - No action required - fallback maintains full functionality

### Logs and Monitoring
```bash
# View Railway logs
railway logs

# Key log messages to look for:
# ✅ "Optimized sentence-aware transcription ready"
# 📝 "COMPLETE SENTENCES: ..."
# 🌉 "Bridge mode: Connecting..."
# 📞 "Bridge dial status: ..."
```

## 🔮 Advanced Features

### n8n Integration
Connect to n8n for automated workflows:
```bash
N8N_WEBHOOK_URL=https://your-n8n.com/webhook/calls
```

Received data includes:
- Full transcript
- Intent analysis (meeting, support, etc.)
- Extracted emails and dates
- Speaker identification
- Conversation summary

### Custom Intent Detection
The system automatically detects:
- **Meeting requests**: "schedule a meeting", "arrange a call"
- **Support needs**: "help", "problem", "issue"
- **Information requests**: "tell me about", "details"
- **Business inquiries**: Sales, pricing, services

### Email Extraction
Handles various speech formats:
- Standard: "alex@gmail.com"
- Spoken: "alex at gmail dot com"
- Spelled: "a-l-e-x at gmail dot com"
- Speech errors: "alex gmail token" → "alex@gmail.com"

## 📈 Performance

### Transcription Accuracy
- **AssemblyAI**: 93.3%+ accuracy for clear audio
- **Business terms**: Enhanced accuracy with word boosting
- **Phone quality**: Optimized for telephony audio (8kHz)
- **Noise handling**: Filters background noise and silence

### Latency
- **Processing delay**: 2-3 seconds for complete sentences
- **Network latency**: ~500ms Railway → AssemblyAI
- **Total delay**: ~3-4 seconds from speech to dashboard
- **Real-time feel**: Optimized for live conversation monitoring

### Scalability
- **Concurrent calls**: Limited by AssemblyAI rate limits
- **Railway resources**: Auto-scales based on usage
- **Cost efficiency**: Pay-per-use pricing model
- **Global deployment**: Railway's global infrastructure

## 💰 Cost Estimation

### Per Hour of Conversation
- **AssemblyAI**: ~$0.15/hour (both speakers)
- **Railway hosting**: ~$0.01/hour
- **Twilio calls**: Variable by region (~$0.01-0.05/minute)
- **OpenAI analysis**: ~$0.001/call (optional)

**Total**: ~$0.17-0.50/hour depending on call rates

## 🤝 Contributing

1. Fork the repository
2. Create feature branch
3. Test with Railway deployment
4. Submit pull request

## 📄 License

MIT License - see LICENSE file for details

## 🆘 Support

- **GitHub Issues**: Report bugs and feature requests
- **Documentation**: Check README for setup instructions
- **Logs**: Use Railway dashboard for debugging
- **Community**: Join discussions in GitHub Discussions

---

**Railway Optimized** | **AssemblyAI Powered** | **Real-time Transcription** | **Bridge Mode Ready**