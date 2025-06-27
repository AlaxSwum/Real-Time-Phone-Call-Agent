# Railway + Twilio Bridge Setup Checklist

## ✅ Pre-deployment Checklist

### 1. Account Setup
- [ ] **Railway Account**: Create account at [railway.app](https://railway.app)
- [ ] **Twilio Account**: Create account at [twilio.com](https://twilio.com)
- [ ] **AssemblyAI Account**: Create account at [assemblyai.com](https://assemblyai.com)
- [ ] **GitHub Account**: Fork this repository

### 2. API Keys Collection
- [ ] **AssemblyAI API Key**: Get from AssemblyAI dashboard
  - Go to [AssemblyAI Console](https://www.assemblyai.com/app)
  - Copy API key (starts with `bearer_...`)
- [ ] **Twilio Credentials**: Get from Twilio Console
  - Account SID (starts with `AC...`)
  - Auth Token (starts with `SK...` or similar)
- [ ] **Target Phone Number**: Number to bridge calls to
  - Format: `+1234567890` (include country code)
- [ ] **Optional: OpenAI API Key**: For AI analysis
- [ ] **Optional: n8n Webhook URL**: For workflow automation

## 🚀 Deployment Steps

### Step 1: Railway Project Setup
1. [ ] **Connect Repository**
   - Go to [Railway Dashboard](https://railway.app/dashboard)
   - Click "New Project"
   - Choose "Deploy from GitHub repo"
   - Select your forked repository

2. [ ] **Environment Variables**
   - Go to your Railway project
   - Click "Variables" tab
   - Add all required variables:

   ```bash
   # Required Variables
   ASSEMBLYAI_API_KEY=your_assemblyai_api_key_here
   BRIDGE_TARGET_NUMBER=+1234567890
   TWILIO_ACCOUNT_SID=your_twilio_account_sid
   TWILIO_AUTH_TOKEN=your_twilio_auth_token
   
   # Optional Variables
   OPENAI_API_KEY=your_openai_api_key_here
   N8N_WEBHOOK_URL=https://your-n8n-instance.com/webhook/calls
   ```

3. [ ] **Deploy Application**
   - Railway automatically deploys after adding variables
   - Wait for deployment to complete
   - Note your app URL (e.g., `https://your-app.railway.app`)

### Step 2: Twilio Configuration
1. [ ] **Buy Phone Number** (if needed)
   - Go to [Twilio Console > Phone Numbers](https://console.twilio.com/us1/develop/phone-numbers/manage/incoming)
   - Buy a phone number with Voice capabilities

2. [ ] **Configure Webhook**
   - Select your phone number
   - In "Voice Configuration":
     - Webhook URL: `https://your-app.railway.app/voice`
     - HTTP Method: `POST`
   - Click "Save configuration"

3. [ ] **Test Phone Number**
   - Call your Twilio number
   - Should hear: "Connecting your call, please wait..."
   - Should connect to bridge target number
   - Check Railway logs for activity

### Step 3: Verification
1. [ ] **Health Check**
   - Visit: `https://your-app.railway.app/health`
   - Should show service status as "healthy"

2. [ ] **Debug Info**
   - Visit: `https://your-app.railway.app/debug`
   - Verify all environment variables are set

3. [ ] **Dashboard Access**
   - Visit: `https://your-app.railway.app`
   - Should see real-time dashboard

4. [ ] **Test Call**
   - Call your Twilio number
   - Verify bridge connection works
   - Check transcription appears on dashboard

## 🔧 Configuration Options

### Bridge Mode Settings
```bash
# Enable bridge mode (recommended)
BRIDGE_TARGET_NUMBER=+1234567890

# Disable bridge mode (analysis only)
# Leave BRIDGE_TARGET_NUMBER empty or unset
```

### Transcription Quality
- **High accuracy**: AssemblyAI provides 93.3%+ accuracy
- **Sentence-aware**: Outputs complete sentences every 2-3 seconds
- **Speaker labels**: Distinguishes between caller and target
- **Business terms**: Enhanced accuracy for business conversations

### Optional Integrations
```bash
# OpenAI Integration (for AI analysis)
OPENAI_API_KEY=sk-...

# n8n Integration (for workflow automation)
N8N_WEBHOOK_URL=https://your-n8n.app.n8n.cloud/webhook/...
```

## 🚨 Troubleshooting

### Common Issues

#### ❌ "No transcription appearing"
**Possible Causes:**
- AssemblyAI API key missing or invalid
- Audio not reaching the server
- Twilio webhook misconfigured

**Solutions:**
1. Check Railway logs: `railway logs`
2. Verify environment variables: Visit `/debug`
3. Test Twilio webhook: Check Twilio Console logs
4. Ensure AssemblyAI account has credits

#### ❌ "Bridge not connecting"
**Possible Causes:**
- Target number format incorrect
- Target number doesn't accept calls
- Twilio account issues

**Solutions:**
1. Verify number format: `+1234567890`
2. Test target number manually
3. Check Twilio account balance
4. Review Twilio Console logs

#### ❌ "Dashboard not loading"
**Possible Causes:**
- Railway deployment failed
- Server crashed due to missing environment variables

**Solutions:**
1. Check Railway deployment status
2. Review Railway logs for errors
3. Verify all required environment variables are set
4. Redeploy if necessary

### Log Analysis
**Key log messages to look for:**

✅ **Success indicators:**
```
✅ "Optimized sentence-aware transcription ready"
🌉 "Bridge mode: Connecting..."
📝 "COMPLETE SENTENCES: ..."
📞 "Bridge dial status: ..."
```

❌ **Error indicators:**
```
❌ "ASSEMBLYAI_API_KEY environment variable is required"
❌ "Bridge recording analysis failed"
❌ "No AssemblyAI API key available"
```

### Getting Help
1. **Check Railway logs**: Most issues show up in logs
2. **Test endpoints**: Use `/health` and `/debug` for diagnostics
3. **Twilio Console**: Check webhook logs and call logs
4. **AssemblyAI Dashboard**: Verify API usage and quotas

## 📊 Monitoring

### Real-time Dashboard
- **URL**: `https://your-app.railway.app`
- **Features**: Live transcription, call status, intent detection
- **Updates**: Every 2-3 seconds during calls

### API Endpoints
- **Health**: `/health` - Service status
- **Debug**: `/debug` - Configuration details
- **API Info**: `/api` - Available endpoints
- **Twilio Config**: `/twilio-config` - Setup instructions

### Key Metrics
- **Transcription latency**: 2-4 seconds
- **Accuracy**: 93.3%+ for clear audio
- **Processing time**: Real-time with sentence completion
- **Cost**: ~$0.17-0.50/hour per conversation

## 🎯 Performance Tips

### For Best Transcription Quality
1. **Clear audio**: Ensure good phone connection
2. **Minimize background noise**: Use quiet environment
3. **Speak clearly**: Normal pace and clear pronunciation
4. **Business terms**: System is optimized for business conversations

### For Optimal Performance
1. **Railway region**: Choose region closest to your users
2. **Monitor usage**: Check AssemblyAI usage in dashboard
3. **Error handling**: System automatically falls back if WebSocket fails
4. **Scaling**: Railway auto-scales based on usage

## ✅ Final Verification

After completing setup, verify all features work:

1. [ ] **Call Bridge**: Phone connects to target number
2. [ ] **Real-time Transcription**: Text appears every 2-3 seconds
3. [ ] **Speaker Labels**: Different speakers identified
4. [ ] **Intent Detection**: Meeting requests detected automatically
5. [ ] **Email Extraction**: Email addresses captured from speech
6. [ ] **Dashboard Updates**: Real-time updates during calls
7. [ ] **Recording**: Post-call recording analysis works
8. [ ] **n8n Integration**: Webhooks sent to n8n (if configured)

**🎉 Setup Complete!** Your Railway-hosted Twilio bridge with real-time transcription is ready to use.

---

**Need Help?** Check the [GitHub Issues](https://github.com/your-username/real-time-phone-call-agent/issues) or Railway logs for troubleshooting. 