// Clean Real-Time Phone Call Agent - Focused on Core Functionality
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const fs = require('fs');

// AI Service imports (optional)
const OpenAI = require('openai');
const { AssemblyAI } = require('assemblyai');

const app = express();
const server = http.createServer(app);

// Initialize OpenAI (optional)
let openai = null;
if (process.env.OPENAI_API_KEY) {
    try {
        openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        console.log('🧠 OpenAI initialized');
    } catch (error) {
        console.error('❌ OpenAI initialization failed:', error.message);
        openai = null;
    }
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

// ============================================================================
// SIMPLIFIED INTENT DETECTION (replaces 500+ lines of complex analysis)
// ============================================================================
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

// ============================================================================
// SIMPLIFIED EMAIL EXTRACTION (replaces 200+ lines)
// ============================================================================
function extractEmail(text) {
    // Standard email pattern
    const emailRegex = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
    const match = text.match(emailRegex);
    if (match) return match[0];
    
    // Simple spoken email pattern
    let spokenPattern = text.toLowerCase()
        .replace(/\s+at\s+/gi, '@')
        .replace(/\s+dot\s+/gi, '.')
        .replace(/\s+gmail\s*/gi, 'gmail.com')
        .replace(/\s+outlook\s*/gi, 'outlook.com');
    
    const spokenMatch = spokenPattern.match(emailRegex);
    return spokenMatch ? spokenMatch[0] : null;
}

// ============================================================================
// CORE PROCESSING FUNCTIONS
// ============================================================================

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
