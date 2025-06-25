# Real-Time Call Processor

A Node.js server that accepts WebSocket connections from Twilio Media Streams, transcribes audio in real-time using OpenAI Whisper, detects intent using OpenAI GPT, and forwards structured data to an n8n webhook for automation.

## Features

- Real-time audio streaming from Twilio calls
- Speech-to-text transcription using OpenAI Whisper API
- Intent detection using OpenAI GPT models
- Structured data forwarding to n8n for workflow automation
- Support for meeting scheduling and email sending intents

## Prerequisites

- Node.js (v14 or higher)
- npm or yarn
- Twilio account with Media Streams capability
- OpenAI API key
- n8n instance with a webhook endpoint
- ngrok or similar tool for exposing your local server to the internet (for Twilio to connect)

## Installation

1. Clone this repository or download the files

2. Install dependencies:

```bash
npm install
```

3. Create a `.env` file in the root directory with the following variables:

```
# Twilio Configuration
TWILIO_ACCOUNT_SID=your_twilio_account_sid
TWILIO_AUTH_TOKEN=your_twilio_auth_token

# OpenAI Configuration
OPENAI_API_KEY=your_openai_api_key

# n8n Webhook Configuration
N8N_WEBHOOK_URL=your_n8n_webhook_url

# Server Configuration
PORT=3000
```

## Running the Server

1. Start the server:

```bash
npm start
```

Or for development with auto-restart:

```bash
npm run dev
```

2. Expose your local server to the internet using ngrok:

```bash
ngrok http 3000
```

3. Note the HTTPS URL provided by ngrok (e.g., `https://your-ngrok-subdomain.ngrok.io`)

## Configuring Twilio

1. Go to your Twilio Console

2. Set up a TwiML Bin or TwiML App with the following configuration:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Start>
        <Stream url="wss://your-ngrok-subdomain.ngrok.io?callSid={{CallSid}}"/>
    </Start>
    <Say>This call is being transcribed and processed in real-time.</Say>
    <Pause length="60"/>
</Response>
```

3. Assign this TwiML to a Twilio phone number or use it in your Twilio application

## Setting up n8n

1. Create a new workflow in n8n

2. Add a Webhook node as a trigger

3. Configure the Webhook node to receive POST requests

4. Copy the webhook URL and add it to your `.env` file as `N8N_WEBHOOK_URL`

5. Add nodes to process the incoming data based on the intent:
   - For `meeting_schedule`, add nodes to create calendar events
   - For `email_send`, add nodes to send emails
   - For other intents, add appropriate handling

## Data Structure

The server forwards the following data structure to n8n:

```json
{
  "callSid": "TwilioCallSID",
  "transcription": "Transcribed text from the call",
  "intent": {
    "intent": "meeting_schedule|email_send|other",
    "confidence": 0.95,
    "details": {
      // Intent-specific details
    }
  },
  "timestamp": "2023-11-15T12:34:56.789Z",
  "isFinal": false
}
```

## Troubleshooting

- **WebSocket connection issues**: Ensure your ngrok tunnel is running and the URL in your TwiML is correct
- **Transcription errors**: Check your OpenAI API key and quota
- **Intent detection issues**: Adjust the system prompt in `intentDetector.js` for better accuracy
- **n8n webhook errors**: Verify your webhook URL and ensure n8n is running

## License

MIT