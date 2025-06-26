require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');

// AI Service imports
const OpenAI = require('openai');

// Deepgram for real-time transcription
const { createClient } = require('@deepgram/sdk');

const app = express();
const server = http.createServer(app);

// Initialize AI clients
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Initialize Deepgram client for real-time transcription
const deepgramApiKey = process.env.DEEPGRAM_API_KEY || '7fba0511f54adc490a379bd27cf84720b71ae433';
console.log('🔑 Deepgram API Key configured:', deepgramApiKey ? `${deepgramApiKey.substring(0, 10)}...` : 'MISSING');
const deepgram = createClient(deepgramApiKey);

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
                connectSrc: ["'self'", "ws:", "wss:", "https://api.openai.com"]
            },
        },
        hsts: {
            maxAge: 31536000,
            includeSubDomains: true,
            preload: true
        }
    }));
    console.log('Production security enabled (relaxed CSP for dashboard)');
} else {
    console.log('Development mode - reduced security');
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

// Debug middleware to log ALL incoming requests
app.use((req, res, next) => {
    const timestamp = new Date().toISOString();
    console.log(`🌐 [${timestamp}] ${req.method} ${req.url}`);
    console.log(`🌐 IP: ${req.ip}`);
    console.log(`🌐 User-Agent: ${req.headers['user-agent']}`);
    if (req.url.includes('voice') || req.url.includes('webhook')) {
        console.log(`🌐 IMPORTANT: Webhook-related request detected!`);
        console.log(`🌐 Headers:`, JSON.stringify(req.headers, null, 2));
    }
    next();
});

// Serve static files from public directory
app.use(express.static('public'));

// Global variables for real-time functionality
let dashboardClients = new Set();
let activeStreams = new Map();



// Intent detection and processing function
async function detectAndProcessIntent(text, callSid) {
    const lowerText = text.toLowerCase();
    let detectedIntent = null;
    let confidence = 0;
    
    // Extract email and meeting details from transcript
    const extractedEmail = extractEmailFromTranscript(text);
    const meetingDetails = extractMeetingDetails(text);
    
    console.log('📧 Email extraction result:', extractedEmail || 'No email found');
    console.log('📅 Meeting details:', meetingDetails);
    
    // Enhanced meeting intent detection with better keyword matching
    const meetingKeywords = [
        // Exact phrases
        'arrange a meeting',
        'set up a meeting', 
        'schedule a meeting',
        'schedule meeting',
        'have a meeting',
        'going to have a meeting',
        'would like to schedule',
        'want to schedule',
        'like to schedule',
        'arrange a medium',        // Speech-to-text error
        'set up a medium',         // Speech-to-text error
        'schedule a medium',       // Speech-to-text error
        'meeting on',
        'meeting at', 
        'meeting next',
        'a meeting',
        'medium on',               // Speech-to-text error
        'medium at',               // Speech-to-text error
        'medium next',             // Speech-to-text error
        'would like to meet',
        'want to meet',
        'let\'s meet',
        'discuss',
        'catch up',
        'get together',
        'resignation',
        'about my resignation'
    ];
    
    // Individual high-value keywords that should trigger meeting intent
    const meetingIndividualKeywords = [
        'arrange',
        'schedule', 
        'meeting',
        'meet',
        'discuss',
        'appointment',
        'consultation'
    ];
    
    console.log('🔍 Checking meeting keywords against transcript:', text);
    console.log('🔍 Lowercase text:', lowerText);
    
    // Check exact phrase matches first
    const meetingMatch = meetingKeywords.some(keyword => {
        const found = lowerText.includes(keyword);
        if (found) {
            console.log(`✅ Found meeting phrase: "${keyword}" in text: "${lowerText}"`);
        }
        return found;
    });
    
    // Check individual keywords for partial matches
    const individualMatch = meetingIndividualKeywords.some(keyword => {
        const found = lowerText.includes(keyword);
        if (found) {
            console.log(`✅ Found meeting keyword: "${keyword}" in text: "${lowerText}"`);
        }
        return found;
    });
    
    const finalMeetingMatch = meetingMatch || individualMatch;
    console.log('🔍 Meeting keywords matched:', finalMeetingMatch);
    console.log('🔍 Full text being analyzed:', lowerText);
    
    // Support intent detection
    const supportKeywords = ['help', 'support', 'problem', 'issue', 'trouble', 'assistance'];
    const supportMatch = supportKeywords.some(keyword => lowerText.includes(keyword));
    
    // Information intent detection
    const infoKeywords = ['information', 'info', 'details', 'tell me', 'what is', 'how much', 'price'];
    const infoMatch = infoKeywords.some(keyword => lowerText.includes(keyword));
    
    // Determine primary intent with higher confidence for meetings
    if (finalMeetingMatch) {
        detectedIntent = 'meeting_discussion';
        // Higher confidence for strong meeting indicators
        if (meetingMatch) {
            // Exact phrase match gets highest confidence
            confidence = 0.95;
        } else if (individualMatch) {
            // Individual keyword match gets high confidence
            confidence = 0.85;
        }
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
            extractedEmail: extractedEmail,
            meetingDetails: meetingDetails,
            timestamp: new Date().toISOString()
        }
    });
    
    // Send enhanced data to n8n webhook if configured
    if (process.env.N8N_WEBHOOK_URL) {
        console.log(`🔗 Sending enhanced intent data to n8n: ${detectedIntent}`);
        console.log(`📧 Including email: ${extractedEmail || 'None'}`);
        console.log(`🔗 N8N Webhook URL: ${process.env.N8N_WEBHOOK_URL}`);
        console.log(`🔍 N8N_WEBHOOK_URL environment variable is SET`);
        
        // Fire-and-forget approach for better performance
        const sendToN8N = async () => {
            try {
                const webhookData = {
                    type: 'intent_detection',
                    callSid: callSid,
                    intent: detectedIntent,
                    confidence: confidence,
                    transcript: text,
                    extractedEmail: extractedEmail,
                    fallbackEmail: 'swumpyaealax@gmail.com', // Your business email
                    emailStatus: extractedEmail ? 'found' : 'not_found',
                    meetingDetails: meetingDetails,
                    timestamp: new Date().toISOString(),
                    keywords_matched: getMatchedKeywords(lowerText, detectedIntent),
                    // Additional useful data
                    hasEmail: !!extractedEmail,
                    hasDateTime: meetingDetails.hasDateTime,
                    urgency: confidence > 0.8 ? 'high' : confidence > 0.6 ? 'medium' : 'low'
                };
                
                console.log(`📤 Sending webhook data:`, JSON.stringify(webhookData, null, 2));
                console.log(`🔍 Webhook payload size: ${JSON.stringify(webhookData).length} bytes`);
                console.log(`🔍 Data types check:`);
                console.log(`  - intent: ${typeof webhookData.intent} = "${webhookData.intent}"`);
                console.log(`  - confidence: ${typeof webhookData.confidence} = ${webhookData.confidence}`);
                console.log(`  - extractedEmail: ${typeof webhookData.extractedEmail} = "${webhookData.extractedEmail}"`);
                console.log(`  - hasEmail: ${typeof webhookData.hasEmail} = ${webhookData.hasEmail}`);
                console.log(`  - meetingDetails: ${typeof webhookData.meetingDetails} = ${JSON.stringify(webhookData.meetingDetails)}`);
                
                const response = await fetch(process.env.N8N_WEBHOOK_URL, {
                    method: 'POST',
                    headers: { 
                        'Content-Type': 'application/json',
                        'Accept': 'application/json'
                    },
                    body: JSON.stringify(webhookData)
                });

                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }
                
                console.log(`✅ Enhanced intent data sent to n8n (${response.status}): ${detectedIntent}`);
                const responseText = await response.text();
                console.log(`📡 N8N Response:`, responseText);
            } catch (error) {
                console.error('❌ Error sending intent to n8n:', error.message);
                console.error('🔍 Full error:', error);
                console.error('🔗 Webhook URL:', process.env.N8N_WEBHOOK_URL);
            }
        };
        
        // Don't await - let it run in background
        sendToN8N();
    } else {
        console.log('⚠️ No N8N webhook URL configured - skipping webhook');
        console.log('🔍 N8N_WEBHOOK_URL environment variable is NOT SET');
        console.log('🔍 Available environment variables:', Object.keys(process.env).filter(key => key.includes('N8N')));
    }
}

// Enhanced keyword analysis function with multiple detection methods
function performEnhancedKeywordAnalysis(text) {
    const lowerText = text.toLowerCase();
    const words = lowerText.split(/\s+/);
    const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
    
    // Enhanced keyword dictionaries with weights and patterns
    const enhancedIntentPatterns = {
        meeting_discussion: {
            exactPhrases: [
                { phrase: 'arrange a meeting', weight: 10 },
                { phrase: 'schedule a meeting', weight: 10 },
                { phrase: 'set up a meeting', weight: 10 },
                { phrase: 'book a meeting', weight: 10 },
                { phrase: 'organize a meeting', weight: 9 },
                { phrase: 'plan a meeting', weight: 9 }
            ],
            keywords: [
                { word: 'meeting', weight: 8 },
                { word: 'discuss', weight: 7 },
                { word: 'conference', weight: 7 },
                { word: 'appointment', weight: 6 },
                { word: 'consultation', weight: 6 },
                { word: 'session', weight: 5 },
                { word: 'gather', weight: 4 },
                { word: 'convene', weight: 4 }
            ],
            contextualPhrases: [
                { phrase: 'would like to meet', weight: 8 },
                { phrase: 'want to meet', weight: 8 },
                { phrase: 'need to talk', weight: 7 },
                { phrase: 'catch up', weight: 6 },
                { phrase: 'get together', weight: 6 },
                { phrase: 'sit down', weight: 5 },
                { phrase: 'have a chat', weight: 5 }
            ],
            timeIndicators: [
                { phrase: 'next week', weight: 3 },
                { phrase: 'tomorrow', weight: 3 },
                { phrase: 'this week', weight: 3 },
                { phrase: 'friday', weight: 2 },
                { phrase: 'monday', weight: 2 }
            ],
            urgencyIndicators: [
                { phrase: 'urgent', weight: 5 },
                { phrase: 'asap', weight: 5 },
                { phrase: 'immediately', weight: 4 },
                { phrase: 'soon', weight: 3 }
            ]
        },
        
        support_request: {
            exactPhrases: [
                { phrase: 'need help', weight: 10 },
                { phrase: 'technical support', weight: 10 },
                { phrase: 'customer service', weight: 9 },
                { phrase: 'having trouble', weight: 8 }
            ],
            keywords: [
                { word: 'help', weight: 8 },
                { word: 'support', weight: 8 },
                { word: 'problem', weight: 7 },
                { word: 'issue', weight: 7 },
                { word: 'trouble', weight: 6 },
                { word: 'assistance', weight: 6 },
                { word: 'broken', weight: 5 },
                { word: 'error', weight: 5 },
                { word: 'bug', weight: 4 }
            ],
            contextualPhrases: [
                { phrase: 'not working', weight: 7 },
                { phrase: 'stopped functioning', weight: 6 },
                { phrase: 'cant access', weight: 6 },
                { phrase: 'difficulty with', weight: 5 }
            ]
        },
        
        sales_inquiry: {
            exactPhrases: [
                { phrase: 'interested in buying', weight: 10 },
                { phrase: 'want to purchase', weight: 10 },
                { phrase: 'looking to buy', weight: 9 }
            ],
            keywords: [
                { word: 'buy', weight: 8 },
                { word: 'purchase', weight: 8 },
                { word: 'price', weight: 7 },
                { word: 'cost', weight: 7 },
                { word: 'quote', weight: 6 },
                { word: 'pricing', weight: 6 },
                { word: 'discount', weight: 5 },
                { word: 'deal', weight: 5 }
            ]
        },
        
        information_request: {
            exactPhrases: [
                { phrase: 'more information', weight: 9 },
                { phrase: 'tell me about', weight: 8 },
                { phrase: 'want to know', weight: 7 }
            ],
            keywords: [
                { word: 'information', weight: 7 },
                { word: 'details', weight: 6 },
                { word: 'explain', weight: 6 },
                { word: 'clarify', weight: 5 },
                { word: 'understand', weight: 5 }
            ]
        },
        
        complaint_feedback: {
            exactPhrases: [
                { phrase: 'not satisfied', weight: 10 },
                { phrase: 'disappointed with', weight: 9 },
                { phrase: 'poor service', weight: 8 }
            ],
            keywords: [
                { word: 'complaint', weight: 8 },
                { word: 'unhappy', weight: 7 },
                { word: 'dissatisfied', weight: 7 },
                { word: 'frustrated', weight: 6 },
                { word: 'disappointed', weight: 6 }
            ]
        }
    };
    
    // Calculate scores for each intent
    const intentScores = {};
    const matchedPatterns = {};
    
    for (const [intentName, patterns] of Object.entries(enhancedIntentPatterns)) {
        let totalScore = 0;
        matchedPatterns[intentName] = [];
        
        // Check exact phrases with proximity bonus
        if (patterns.exactPhrases) {
            patterns.exactPhrases.forEach(({ phrase, weight }) => {
                if (lowerText.includes(phrase)) {
                    totalScore += weight;
                    matchedPatterns[intentName].push({ type: 'exact_phrase', phrase, weight });
                }
                
                // Fuzzy matching for slight variations
                const fuzzyMatch = findFuzzyMatch(phrase, lowerText);
                if (fuzzyMatch.score > 0.8 && !lowerText.includes(phrase)) {
                    totalScore += weight * fuzzyMatch.score * 0.8; // Reduced weight for fuzzy
                    matchedPatterns[intentName].push({ 
                        type: 'fuzzy_phrase', 
                        original: phrase, 
                        matched: fuzzyMatch.match, 
                        score: fuzzyMatch.score,
                        weight: weight * fuzzyMatch.score * 0.8 
                    });
                }
            });
        }
        
        // Check individual keywords with context
        if (patterns.keywords) {
            patterns.keywords.forEach(({ word, weight }) => {
                const occurrences = (lowerText.match(new RegExp(`\\b${word}\\b`, 'g')) || []).length;
                if (occurrences > 0) {
                    // Multiple occurrences get bonus
                    const contextBonus = occurrences > 1 ? 1.5 : 1;
                    totalScore += weight * occurrences * contextBonus;
                    matchedPatterns[intentName].push({ 
                        type: 'keyword', 
                        word, 
                        occurrences, 
                        weight: weight * occurrences * contextBonus 
                    });
                }
            });
        }
        
        // Check contextual phrases
        if (patterns.contextualPhrases) {
            patterns.contextualPhrases.forEach(({ phrase, weight }) => {
                if (lowerText.includes(phrase)) {
                    totalScore += weight;
                    matchedPatterns[intentName].push({ type: 'contextual_phrase', phrase, weight });
                }
            });
        }
        
        // Check time indicators (adds context to meeting intent)
        if (patterns.timeIndicators) {
            patterns.timeIndicators.forEach(({ phrase, weight }) => {
                if (lowerText.includes(phrase)) {
                    totalScore += weight;
                    matchedPatterns[intentName].push({ type: 'time_indicator', phrase, weight });
                }
            });
        }
        
        // Check urgency indicators
        if (patterns.urgencyIndicators) {
            patterns.urgencyIndicators.forEach(({ phrase, weight }) => {
                if (lowerText.includes(phrase)) {
                    totalScore += weight;
                    matchedPatterns[intentName].push({ type: 'urgency_indicator', phrase, weight });
                }
            });
        }
        
        intentScores[intentName] = totalScore;
    }
    
    // Find primary intent
    const sortedIntents = Object.entries(intentScores)
        .sort(([,a], [,b]) => b - a)
        .filter(([,score]) => score > 0);
    
    let primaryIntent = 'general_inquiry';
    let confidence = 0.5;
    
    if (sortedIntents.length > 0) {
        const [topIntent, topScore] = sortedIntents[0];
        const secondScore = sortedIntents[1] ? sortedIntents[1][1] : 0;
        
        // Calculate confidence based on score and separation from second place
        const baseConfidence = Math.min(topScore / 20, 1); // Normalize to max score of 20
        const separationBonus = topScore > secondScore ? (topScore - secondScore) / topScore * 0.3 : 0;
        confidence = Math.min(baseConfidence + separationBonus, 0.98);
        
        if (confidence > 0.6) {
            primaryIntent = topIntent;
        }
    }
    
    // Analyze contextual factors
    const contextualFactors = analyzeContextualFactors(text, words, sentences);
    
    // Detect sentiment indicators
    const sentimentIndicators = detectSentimentIndicators(lowerText);
    
    // Determine urgency level
    const urgencyLevel = determineUrgencyLevel(matchedPatterns, lowerText);
    
    // Extract potential action items
    const actionItems = extractActionItems(text, primaryIntent);
    
    return {
        primaryIntent,
        confidence,
        intentScores,
        matchedPatterns,
        contextualFactors,
        sentimentIndicators,
        urgencyLevel,
        actionItems
    };
}

// Fuzzy string matching function
function findFuzzyMatch(pattern, text) {
    const words = pattern.split(' ');
    let bestMatch = '';
    let bestScore = 0;
    
    // Look for patterns where most words match
    const textWords = text.split(' ');
    for (let i = 0; i <= textWords.length - words.length; i++) {
        const segment = textWords.slice(i, i + words.length).join(' ');
        const score = calculateSimilarity(pattern, segment);
        if (score > bestScore) {
            bestScore = score;
            bestMatch = segment;
        }
    }
    
    return { match: bestMatch, score: bestScore };
}

// Calculate string similarity
function calculateSimilarity(str1, str2) {
    const longer = str1.length > str2.length ? str1 : str2;
    const shorter = str1.length > str2.length ? str2 : str1;
    
    if (longer.length === 0) return 1.0;
    
    const editDistance = levenshteinDistance(longer, shorter);
    return (longer.length - editDistance) / longer.length;
}

// Levenshtein distance calculation
function levenshteinDistance(str1, str2) {
    const matrix = [];
    
    for (let i = 0; i <= str2.length; i++) {
        matrix[i] = [i];
    }
    
    for (let j = 0; j <= str1.length; j++) {
        matrix[0][j] = j;
    }
    
    for (let i = 1; i <= str2.length; i++) {
        for (let j = 1; j <= str1.length; j++) {
            if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(
                    matrix[i - 1][j - 1] + 1,
                    matrix[i][j - 1] + 1,
                    matrix[i - 1][j] + 1
                );
            }
        }
    }
    
    return matrix[str2.length][str1.length];
}

// Analyze contextual factors
function analyzeContextualFactors(text, words, sentences) {
    return {
        wordCount: words.length,
        sentenceCount: sentences.length,
        avgWordsPerSentence: words.length / Math.max(sentences.length, 1),
        hasQuestions: text.includes('?'),
        hasNumbers: /\d/.test(text),
        hasTimeReferences: /\b(today|tomorrow|next week|this week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(text),
        hasPersonalPronouns: /\b(i|we|us|my|our)\b/i.test(text),
        textLength: text.length,
        complexityScore: calculateComplexityScore(words)
    };
}

// Calculate text complexity score
function calculateComplexityScore(words) {
    const uniqueWords = new Set(words).size;
    const repetitionRatio = words.length / uniqueWords;
    const avgWordLength = words.reduce((sum, word) => sum + word.length, 0) / words.length;
    
    return {
        uniquenessRatio: uniqueWords / words.length,
        repetitionRatio,
        avgWordLength,
        complexityIndex: (uniqueWords / words.length) * avgWordLength
    };
}

// Detect sentiment indicators
function detectSentimentIndicators(lowerText) {
    const positiveWords = ['great', 'excellent', 'good', 'happy', 'satisfied', 'pleased', 'wonderful', 'amazing', 'fantastic'];
    const negativeWords = ['bad', 'terrible', 'awful', 'disappointed', 'frustrated', 'angry', 'upset', 'horrible', 'disgusted'];
    
    const positiveCount = positiveWords.filter(word => lowerText.includes(word)).length;
    const negativeCount = negativeWords.filter(word => lowerText.includes(word)).length;
    
    let sentiment = 'neutral';
    if (positiveCount > negativeCount) sentiment = 'positive';
    else if (negativeCount > positiveCount) sentiment = 'negative';
    
    return {
        sentiment,
        positiveIndicators: positiveCount,
        negativeIndicators: negativeCount,
        sentimentStrength: Math.abs(positiveCount - negativeCount)
    };
}

// Determine urgency level
function determineUrgencyLevel(matchedPatterns, lowerText) {
    const urgencyKeywords = {
        high: ['urgent', 'emergency', 'asap', 'immediately', 'critical', 'now'],
        medium: ['soon', 'quickly', 'prompt', 'timely', 'expedite'],
        low: ['eventually', 'when possible', 'no rush', 'sometime']
    };
    
    for (const [level, keywords] of Object.entries(urgencyKeywords)) {
        if (keywords.some(keyword => lowerText.includes(keyword))) {
            return level;
        }
    }
    
    // Check if any patterns have urgency indicators
    for (const patterns of Object.values(matchedPatterns)) {
        if (patterns.some(p => p.type === 'urgency_indicator')) {
            return 'medium';
        }
    }
    
    return 'low';
}

// Extract potential action items
function extractActionItems(text, intent) {
    const actionItems = [];
    
    // Look for common action patterns
    const actionPatterns = [
        /\b(schedule|arrange|set up|book|plan)\s+([^.!?]+)/gi,
        /\b(call|email|contact|reach out)\s+([^.!?]+)/gi,
        /\b(send|provide|give|share)\s+([^.!?]+)/gi,
        /\b(fix|resolve|address|handle)\s+([^.!?]+)/gi
    ];
    
    actionPatterns.forEach(pattern => {
        const matches = text.match(pattern);
        if (matches) {
            actionItems.push(...matches);
        }
    });
    
    return actionItems.slice(0, 5); // Limit to top 5 action items
}

// Basic health check endpoint
app.get('/health', (req, res) => {
    const healthCheck = {
        status: 'healthy', 
        timestamp: new Date().toISOString(),
        environment: NODE_ENV,
        services: {
            deepgram: {
                configured: !!(process.env.DEEPGRAM_API_KEY || deepgramApiKey),
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

            documentation: 'https://github.com/AlaxSwum/Real-Time-Phone-Call-Agent'
        }
    });
});

// Function to broadcast to all dashboard clients
function broadcastToClients(message) {
    // Only log non-transcript messages to reduce spam
    if (message.type !== 'live_transcript') {
        console.log(`BROADCAST Broadcasting to ${dashboardClients.size} dashboard clients:`, message.type);
    }
    let sentCount = 0;
    dashboardClients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            try {
                client.send(JSON.stringify(message));
                sentCount++;
            } catch (error) {
                console.error('ERROR Error broadcasting to client:', error);
            }
        }
    });
    // Only log success for important messages
    if (message.type !== 'live_transcript') {
        console.log(`SUCCESS Successfully sent message to ${sentCount}/${dashboardClients.size} clients`);
    }
}

// Old duplicate webhook handler removed - using handleVoiceWebhook function instead

// Analyze transcript with OpenAI
async function analyzeTranscriptWithAI(text, callSid) {
    try {
        console.log('🧠 Analyzing transcript with OpenAI...');
        
        // Skip analysis for very short or incomplete transcripts
        if (text.trim().length < 20) {
            console.log('⏭️ Skipping AI analysis - transcript too short:', text.length, 'characters');
            return;
        }
        
        // Skip if transcript doesn't contain meaningful content
        const meaningfulWords = text.toLowerCase().split(' ').filter(word => 
            word.length > 2 && 
            !['the', 'and', 'that', 'this', 'with', 'for', 'are', 'was', 'but', 'not', 'you', 'all', 'can', 'had', 'her', 'his', 'one', 'our', 'out', 'day', 'get', 'has', 'him', 'how', 'man', 'new', 'now', 'old', 'see', 'two', 'way', 'who', 'boy', 'did', 'its', 'let', 'put', 'say', 'she', 'too', 'use'].includes(word)
        );
        
        if (meaningfulWords.length < 3) {
            console.log('⏭️ Skipping AI analysis - not enough meaningful content');
            return;
        }
        
        console.log(`🔍 Analyzing meaningful transcript (${meaningfulWords.length} meaningful words): "${text}"`);
        
        const aiResponse = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                {
                    role: "system",
                    content: `You are an AI assistant for a real-time call processing system. Analyze the following voice message and provide a JSON response with:
                    {
                        "intent": "meeting_discussion/support_request/information_request/general_inquiry",
                        "urgency": "low/medium/high",
                        "key_info": ["extracted information items"],
                        "sentiment": "positive/neutral/negative",
                        "follow_up": "recommended action",
                        "summary": "brief professional summary"
                    }
                    
                    IMPORTANT: If the message contains ANY of these phrases, classify as "meeting_discussion":
                    - "arrange a meeting", "schedule a meeting", "set up a meeting"
                    - "have a meeting", "going to meet", "would like to meet"
                    - "meeting on", "meeting at", "meeting next week"
                    - "arrange a medium", "schedule a medium" (speech-to-text errors)
                    
                    For meeting discussions, focus on:
                    1. Meeting scheduling and arrangements
                    2. Date, time, and location details
                    3. Email addresses for confirmations
                    4. Participants and attendees
                    5. Meeting purpose or agenda items
                    
                    ALWAYS prioritize meeting intent over general inquiry when meeting keywords are present.`
                },
                {
                    role: "user",
                    content: `Voice message: "${text}"`
                }
            ],
            temperature: 0.1  // Lower temperature for more consistent results
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
        
        console.log('AI ANALYSIS:', analysis.intent, analysis.urgency, 'urgency');
        
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
                console.error('ERROR Error sending to n8n webhook:', error);
            });
        }
        
    } catch (error) {
        console.error('ERROR AI analysis error:', error);
    }
}

// Single WebSocket server with path routing
const wss = new WebSocket.Server({ server });

let activeConnections = 0;

wss.on('connection', (ws, req) => {
    const urlPath = req.url;
    const clientIP = req.socket.remoteAddress;
    console.log(`SOCKET NEW WEBSOCKET CONNECTION to path: ${urlPath}`);
    console.log(`SOCKET Client IP: ${clientIP}`);
    console.log(`SOCKET Headers:`, req.headers);
    
    // Check if this is a Twilio Media Stream connection
    // Supports both /stream/CALLSID and /?callSid=CALLSID formats
    if (urlPath.startsWith('/stream/') || urlPath.includes('callSid=')) {
        // This is a Twilio Media Stream connection
        console.log(`SOCKET ✅ Routing to Twilio Media Stream handler`);
        console.log(`SOCKET Stream path: ${urlPath}`);
        handleTwilioStreamConnection(ws, req);
    } else if (urlPath === '/ws' || urlPath === '/') {
        // This is a dashboard connection
        console.log(`SOCKET ✅ Routing to dashboard handler`);
        handleDashboardConnection(ws, req);
    } else {
        console.log(`ERROR ❌ Unknown WebSocket path: ${urlPath}`);
        console.log(`ERROR Available paths: /stream/CALLSID, /?callSid=CALLSID, /ws`);
        console.log(`ERROR Client IP: ${clientIP}`);
        ws.close(1002, 'Unknown path');
    }
});

// Dashboard WebSocket handler
function handleDashboardConnection(ws, req) {
    activeConnections++;
    dashboardClients.add(ws);
    const clientIP = req.socket.remoteAddress;
    console.log(`SOCKET NEW DASHBOARD CLIENT connected from ${clientIP}`);
    console.log(`STATS Dashboard clients: ${dashboardClients.size}, Total connections: ${activeConnections}`);
    
    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            
            // Only log non-ping messages to reduce spam
            if (data.type && data.type !== 'ping') {
                console.log('MESSAGE Received dashboard message:', data.type);
            }
            
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
                    if (data.type) {
                        console.log('Unknown dashboard message type:', data.type);
                    } else {
                        // Likely a Twilio message that got routed to the wrong handler
                        console.log('WARNING: Received non-dashboard message on dashboard connection');
                        console.log('DEBUG: Message preview:', message.toString().substring(0, 50) + '...');
                        console.log('DEBUG: This suggests a WebSocket routing issue');
                    }
            }
        } catch (error) {
            console.error('ERROR Dashboard WebSocket message error:', error);
            console.error('ERROR Raw message:', message.toString().substring(0, 100));
        }
    });
    
    ws.on('close', () => {
        activeConnections--;
        dashboardClients.delete(ws);
        console.log(`SOCKET DASHBOARD CLIENT disconnected`);
        console.log(`STATS Dashboard clients: ${dashboardClients.size}, Total connections: ${activeConnections}`);
    });
    
    ws.on('error', (error) => {
        console.error('ERROR Dashboard WebSocket error:', error);
    });
    
    // Send welcome message
    ws.send(JSON.stringify({
        type: 'welcome',
        message: 'Connected to Real-Time Call Processor Dashboard',
        timestamp: new Date().toISOString()
    }));
}

// Twilio Media Stream WebSocket handler  
async function handleTwilioStreamConnection(ws, req) {
    // Extract callSid from URL - supports both formats
    let callSid = '';
    if (req.url.includes('callSid=')) {
        // New format: /?callSid=CALLSID
        const urlParams = new URLSearchParams(req.url.split('?')[1]);
        callSid = urlParams.get('callSid');
    } else if (req.url.startsWith('/stream/')) {
        // Old format: /stream/CALLSID
        const urlParts = req.url.split('/');
        callSid = urlParts[urlParts.length - 1];
    }
    
    console.log(`STREAM NEW TWILIO STREAM CONNECTION for call: ${callSid}`);
    console.log(`URL Stream URL: ${req.url}`);
    console.log(`BROADCAST Headers:`, req.headers);
    
    // DEBUG: Show transcription service selection logic
    const hasDeepgram = !!(process.env.DEEPGRAM_API_KEY || deepgramApiKey);
    console.log(`🔍 TRANSCRIPTION SERVICE DEBUG:`);
    console.log(`  - Deepgram available: ${hasDeepgram} (API key: ${hasDeepgram ? 'SET' : 'MISSING'})`);
    console.log(`  - Will use: ${hasDeepgram ? 'DEEPGRAM' : 'NONE'}`);
    
    // Initialize variables for this stream
    let fullTranscript = '';
    
    // Use Deepgram for real-time transcription service
    if (process.env.DEEPGRAM_API_KEY || deepgramApiKey) {
        console.log('🎙️ Using Deepgram for real-time transcription service...');
        await initializeDeepgramRealtime(callSid, ws);
    } else {
        console.log('❌ WARNING: No Deepgram API key configured');
        broadcastToClients({
            type: 'transcription_unavailable',
            message: 'No real-time transcription available - will analyze recording after call',
            data: {
                callSid: callSid,
                error: 'No Deepgram API key configured',
                fallbackMethod: 'post_call_recording_analysis',
                timestamp: new Date().toISOString()
            }
        });
    }
    
    let mediaPacketCount = 0;
    let isUserSpeaking = false;
    let silenceBuffer = 0;
    let twimlFinished = false;
    let firstAudioSample = null;
    let audioVariationDetected = false;
    
    // Delay audio forwarding to avoid TwiML voice pickup (further reduced for faster detection)
    setTimeout(() => {
        twimlFinished = true;
        console.log('STREAM TwiML playback should be finished, starting audio capture...');
    }, 800); // Reduced timing for faster speech detection
    
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            
            switch (data.event) {
                case 'start':
                    console.log('STREAM STREAM STARTED for call:', callSid);
                    console.log('INFO Stream details:', JSON.stringify(data.start, null, 2));
                    console.log('DEBUG Deepgram connection:', ws.deepgramLive ? 'EXISTS' : 'MISSING');
                    
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
                        console.log(`AUDIO FIRST AUDIO PACKET received from Twilio`);
                        console.log(`DEBUG Audio data length: ${data.media.payload ? data.media.payload.length : 'NO PAYLOAD'}`);
                        console.log(`DEBUG Audio sequence: ${data.media.sequence}`);
                        console.log(`DEBUG Deepgram connection: ${ws.deepgramLive ? 'EXISTS' : 'MISSING'}`);
                    }
                    
                    // Handle audio processing (WebSocket or HTTP chunked fallback)
                    if (data.media.payload && twimlFinished) {
                        try {
                            const mulawData = Buffer.from(data.media.payload, 'base64');
                            
                            // Try WebSocket first (using raw mulaw), fallback to HTTP chunked processing
                            if (ws.deepgramLive && ws.deepgramConnected()) {
                                // WebSocket mode - send raw mulaw data
                                ws.deepgramLive.send(mulawData);
                                
                                if (mediaPacketCount === 1) {
                                    console.log(`✅ DEEPGRAM WEBSOCKET: First mulaw packet sent (${mulawData.length} bytes)`);
                                    console.log(`🎯 USING RAW MULAW: No conversion for WebSocket mode`);
                                    
                                    // Analyze first audio packet for speech detection
                                    let nonSilentBytes = 0;
                                    let maxAmplitude = 0;
                                    for (let i = 0; i < Math.min(mulawData.length, 50); i++) {
                                        const sample = mulawData[i];
                                        if (sample !== 0 && sample !== 127 && sample !== 255) nonSilentBytes++;
                                        maxAmplitude = Math.max(maxAmplitude, Math.abs(sample - 127));
                                    }
                                    console.log(`🔊 AUDIO ANALYSIS: ${nonSilentBytes}/50 non-silent bytes, max amplitude: ${maxAmplitude}`);
                                    
                                    if (maxAmplitude < 5) {
                                        console.log(`⚠️ WARNING: Audio appears to be very quiet or silent`);
                                    } else if (maxAmplitude > 100) {
                                        console.log(`✅ GOOD: Audio has strong signal levels`);
                                    } else {
                                        console.log(`📊 INFO: Audio has moderate signal levels`);
                                    }
                                }
                                
                                if (mediaPacketCount % 300 === 0) {
                                    console.log(`🎙️ DEEPGRAM WEBSOCKET: ${mediaPacketCount} mulaw packets sent`);
                                    
                                    // Analyze audio quality every 300 packets
                                    let activeBytes = 0;
                                    let totalAmplitude = 0;
                                    for (let i = 0; i < Math.min(mulawData.length, 50); i++) {
                                        const sample = mulawData[i];
                                        const amplitude = Math.abs(sample - 127);
                                        if (amplitude > 5) activeBytes++;
                                        totalAmplitude += amplitude;
                                    }
                                    const avgAmplitude = totalAmplitude / Math.min(mulawData.length, 50);
                                    
                                    console.log(`🔊 AUDIO QUALITY: ${activeBytes}/50 active bytes, avg amplitude: ${avgAmplitude.toFixed(1)}`);
                                    
                                    if (avgAmplitude < 3) {
                                        console.log(`⚠️ AUDIO ISSUE: Very low audio levels - may be silence or background noise only`);
                                    }
                                }
                            } else if (ws.chunkProcessor) {
                                // HTTP chunked processing mode - convert to linear16
                                const linear16Data = convertMulawToLinear16(mulawData);
                                ws.chunkBuffer = Buffer.concat([ws.chunkBuffer, linear16Data]);
                                
                                if (mediaPacketCount === 1) {
                                    console.log(`✅ HTTP CHUNKED: First audio packet buffered`);
                                    console.log(`🔄 CONVERSION: mulaw ${mulawData.length} bytes → linear16 ${linear16Data.length} bytes`);
                                    console.log(`📊 BUFFER: Audio will be processed in 3-second chunks`);
                                }
                                
                                if (mediaPacketCount % 300 === 0) {
                                    console.log(`🎙️ HTTP CHUNKED: ${mediaPacketCount} packets buffered, buffer size: ${ws.chunkBuffer.length} bytes`);
                                }
                            } else {
                                // Buffer until either WebSocket or HTTP chunked is ready
                                if (!ws.audioBuffer) ws.audioBuffer = [];
                                ws.audioBuffer.push(mulawData);
                                if (ws.audioBuffer.length > 100) {
                                    ws.audioBuffer.shift(); // Keep only last 100 packets
                                }
                            }
                        } catch (audioError) {
                            console.error('❌ Audio processing error:', audioError.message);
                        }
                    }

                    break;
                    
                case 'stop':
                    console.log('STREAM STREAM STOPPED for call:', callSid);
                    console.log(`STATS Total audio packets received: ${mediaPacketCount}`);
                    
                    // Clean up WebSocket connection
                    if (ws.deepgramLive) {
                        console.log('🛑 DEEPGRAM WEBSOCKET: Finishing transcription session...');
                        ws.deepgramLive.finish();
                    }
                    
                    // Clean up HTTP chunked processing
                    if (ws.chunkProcessor) {
                        console.log('🛑 HTTP CHUNKED: Processing final audio chunk...');
                        clearInterval(ws.chunkProcessor);
                        
                        // Process any remaining audio in buffer
                        if (ws.chunkBuffer && ws.chunkBuffer.length > 0) {
                            (async () => {
                                try {
                                    console.log(`🔄 Processing final chunk (${ws.chunkBuffer.length} bytes)`);
                                    
                                    // Create proper WAV file for final chunk
                                    const wavHeader = createWavHeader(ws.chunkBuffer.length);
                                    const wavFile = Buffer.concat([wavHeader, ws.chunkBuffer]);
                                    
                                    const response = await fetch('https://api.deepgram.com/v1/listen', {
                                        method: 'POST',
                                        headers: {
                                            'Authorization': `Token ${deepgramApiKey}`,
                                            'Content-Type': 'audio/wav',
                                            'Accept': 'application/json'
                                        },
                                        body: wavFile
                                    });
                                    
                                    if (response.ok) {
                                        const result = await response.json();
                                        const transcript = result.results?.channels?.[0]?.alternatives?.[0]?.transcript;
                                        
                                        if (transcript && transcript.trim().length > 0) {
                                            console.log(`📝 FINAL CHUNK TRANSCRIPT: "${transcript}"`);
                                            
                                            broadcastToClients({
                                                type: 'live_transcript',
                                                message: transcript,
                                                data: {
                                                    callSid: callSid,
                                                    text: transcript,
                                                    confidence: result.results?.channels?.[0]?.alternatives?.[0]?.confidence || 0,
                                                    is_final: true,
                                                    provider: 'deepgram_http_final',
                                                    timestamp: new Date().toISOString()
                                                }
                                            });
                                            
                                            detectAndProcessIntent(transcript, callSid);
                                        }
                                    }
                                } catch (error) {
                                    console.error('❌ Final chunk processing error:', error.message);
                                }
                            })();
                        }
                    }
                    
                    // Final analysis if we have a full transcript
                    if (fullTranscript.trim().length > 0) {
                        console.log('📝 FULL CALL TRANSCRIPT: "' + fullTranscript.trim() + '"');
                        if (fullTranscript.trim().length > 3) {
                            console.log('🚀 Starting parallel analysis of full transcript...');
                            
                            // Run final analysis in parallel
                            const finalAnalysisOperations = [
                                analyzeTranscriptWithAI(fullTranscript.trim(), callSid),
                                detectAndProcessIntent(fullTranscript.trim(), callSid)
                            ];
                            
                            Promise.allSettled(finalAnalysisOperations).then(results => {
                                const [aiResult, intentResult] = results;
                                
                                if (aiResult.status === 'rejected') {
                                    console.error('❌ Final AI analysis failed:', aiResult.reason);
                                } else {
                                    console.log('✅ Final AI analysis completed');
                                }
                                
                                if (intentResult.status === 'rejected') {
                                    console.error('❌ Final intent detection failed:', intentResult.reason);
                                } else {
                                    console.log('✅ Final intent detection completed');
                                }
                                
                                console.log('🎯 Final parallel analysis completed');
                            }).catch(error => {
                                console.error('❌ Final parallel processing error:', error);
                            });
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
            console.error('ERROR Stream message error:', error);
        }
    });
    
    ws.on('close', () => {
        console.log(`STREAM Stream connection closed for call: ${callSid}`);
        activeStreams.delete(callSid);
    });
    
    ws.on('error', (error) => {
        console.error('ERROR Stream WebSocket error:', error);
    });
}

// Test current transcription service priority
app.get('/test/transcription-priority', (req, res) => {
    const hasDeepgram = !!(process.env.DEEPGRAM_API_KEY || deepgramApiKey);
    
    let primaryService = hasDeepgram ? 'Deepgram' : 'none';
    
    res.json({
        primary_service: primaryService,
        services_available: {
            deepgram: hasDeepgram
        },
        api_keys: {
            deepgram_configured: hasDeepgram,
            deepgram_is_hardcoded: !!deepgramApiKey
        },
        recommendation: hasDeepgram ? 
            'Deepgram will be used for real-time transcription' : 
            'Configure DEEPGRAM_API_KEY for real-time transcription',
        timestamp: new Date().toISOString()
    });
});



// Email extraction and validation functions
function extractEmailFromTranscript(transcript) {
    const text = transcript.toLowerCase();
    
    // Try normal email pattern first
    const normalEmailRegex = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
    const normalEmail = text.match(normalEmailRegex);
    if (normalEmail && normalEmail[0]) {
        return validateAndCleanEmail(normalEmail[0]);
    }
    
    // Try spelled email pattern: "j-o-h-n at g-m-a-i-l dot c-o-m"
    const spelledEmail = parseSpelledEmail(text);
    if (spelledEmail) {
        return validateAndCleanEmail(spelledEmail);
    }
    
    // Enhanced spoken email pattern with comprehensive speech-to-text error corrections
    let spokenPattern = text
        .replace(/\s+at\s+/gi, '@')
        .replace(/\s+dot\s+/gi, '.')
        .replace(/\s+dash\s+/gi, '-')
        .replace(/\s+underscore\s+/gi, '_')
        .replace(/\s+hyphen\s+/gi, '-')
        .replace(/\s+minus\s+/gi, '-')
        .replace(/\s+period\s+/gi, '.')
        .replace(/\s+point\s+/gi, '.')
        
        // Common speech-to-text errors for domain endings
        .replace(/\s+token\s*/gi, '.com')           // "token" → ".com"
        .replace(/\s+talking\s*/gi, '.com')         // "talking" → ".com"
        .replace(/\s+common\s*/gi, '.com')          // "common" → ".com"
        .replace(/\s+calm\s*/gi, '.com')            // "calm" → ".com"
        .replace(/\s+come\s*/gi, '.com')            // "come" → ".com"
        .replace(/\s+coming\s*/gi, '.com')          // "coming" → ".com"
        .replace(/\s+column\s*/gi, '.com')          // "column" → ".com"
        .replace(/\s+commercial\s*/gi, '.com')      // "commercial" → ".com"
        .replace(/\s+commerce\s*/gi, '.com')        // "commerce" → ".com"
        .replace(/\s+compact\s*/gi, '.com')         // "compact" → ".com"
        .replace(/\s+company\s*/gi, '.com')         // "company" → ".com"
        .replace(/\s+complete\s*/gi, '.com')        // "complete" → ".com"
        
        // Email provider corrections with speech-to-text errors
        .replace(/gmail\s+(token|talking|common|calm|come|coming|column|commercial|commerce|compact|company|complete)/gi, 'gmail.com')
        .replace(/g\s*mail\s+(token|talking|common|calm|come|coming|column|commercial|commerce|compact|company|complete)/gi, 'gmail.com')
        .replace(/jemail\s+(token|talking|common|calm|come|coming|column|commercial|commerce|compact|company|complete)/gi, 'gmail.com')
        .replace(/gmail\s+dot\s+com/gi, 'gmail.com')
        .replace(/g\s*mail\s+dot\s+com/gi, 'gmail.com')
        .replace(/jemail\s+dot\s+com/gi, 'gmail.com')
        .replace(/\s+gmail\s+/gi, '@gmail.')         // Better gmail handling
        .replace(/\s+g\s*mail\s+/gi, '@gmail.')      // "g mail" → "@gmail."
        .replace(/\s+jemail\s+/gi, '@gmail.')        // "jemail" → "@gmail."
        
        .replace(/outlook\s+(token|talking|common|calm|come|coming|column|commercial|commerce|compact|company|complete)/gi, 'outlook.com')
        .replace(/out\s*look\s+(token|talking|common|calm|come|coming|column|commercial|commerce|compact|company|complete)/gi, 'outlook.com')
        .replace(/\s+outlook\s+/gi, '@outlook.')     // Better outlook handling
        .replace(/\s+out\s*look\s+/gi, '@outlook.')  // "out look" → "@outlook."
        
        .replace(/yahoo\s+(token|talking|common|calm|come|coming|column|commercial|commerce|compact|company|complete)/gi, 'yahoo.com')
        .replace(/ya\s*hoo\s+(token|talking|common|calm|come|coming|column|commercial|commerce|compact|company|complete)/gi, 'yahoo.com')
        .replace(/\s+yahoo\s+/gi, '@yahoo.')         // Better yahoo handling
        .replace(/\s+ya\s*hoo\s+/gi, '@yahoo.')      // "ya hoo" → "@yahoo."
        
        .replace(/hotmail\s+(token|talking|common|calm|come|coming|column|commercial|commerce|compact|company|complete)/gi, 'hotmail.com')
        .replace(/hot\s*mail\s+(token|talking|common|calm|come|coming|column|commercial|commerce|compact|company|complete)/gi, 'hotmail.com')
        .replace(/\s+hotmail\s+/gi, '@hotmail.')     // Better hotmail handling
        .replace(/\s+hot\s*mail\s+/gi, '@hotmail.')  // "hot mail" → "@hotmail."
        
        // Handle other common providers
        .replace(/\s+icloud\s+/gi, '@icloud.')
        .replace(/\s+i\s*cloud\s+/gi, '@icloud.')
        .replace(/\s+protonmail\s+/gi, '@protonmail.')
        .replace(/\s+proton\s*mail\s+/gi, '@protonmail.')
        
        // Handle org, net, edu endings
        .replace(/\s+org\s*/gi, '.org')
        .replace(/\s+organization\s*/gi, '.org')
        .replace(/\s+net\s*/gi, '.net')
        .replace(/\s+network\s*/gi, '.net')
        .replace(/\s+edu\s*/gi, '.edu')
        .replace(/\s+education\s*/gi, '.edu');
    
    const spokenEmail = spokenPattern.match(normalEmailRegex);
    if (spokenEmail && spokenEmail[0]) {
        return validateAndCleanEmail(spokenEmail[0]);
    }
    
    // Enhanced pattern for various speech formats
    const enhancedEmailPatterns = [
        // "alex at gmail token" format
        /([a-zA-Z0-9._-]+)\s+at\s+(gmail|g\s*mail|jemail|outlook|out\s*look|yahoo|ya\s*hoo|hotmail|hot\s*mail|icloud|i\s*cloud)\s+(token|talking|common|calm|come|coming|column|commercial|commerce|compact|company|complete|dot\s+com)/gi,
        
        // "alex at gmail dot com" format
        /([a-zA-Z0-9._-]+)\s+at\s+(gmail|g\s*mail|jemail|outlook|out\s*look|yahoo|ya\s*hoo|hotmail|hot\s*mail|icloud|i\s*cloud)\s+dot\s+(com|org|net|edu)/gi,
        
        // "alex gmail token" format (missing "at")
        /([a-zA-Z0-9._-]+)\s+(gmail|g\s*mail|jemail|outlook|out\s*look|yahoo|ya\s*hoo|hotmail|hot\s*mail|icloud|i\s*cloud)\s+(token|talking|common|calm|come|coming|column|commercial|commerce|compact|company|complete)/gi,
        
        // Context-aware patterns (looking for email keywords nearby)
        /(email\s+is\s+|my\s+email\s+|email\s+address\s+is\s+|contact\s+me\s+at\s+|reach\s+me\s+at\s+)([a-zA-Z0-9._-]+)\s+at\s+([a-zA-Z0-9.-]+)\s+(token|talking|common|calm|come|coming|dot\s+com)/gi,
        
        // Spelled out email patterns: "s w u m p y a e at gmail dot com"
        /(email\s+is\s+|my\s+email\s+|email\s+address\s+is\s+)([a-z]\s+){3,}(at\s+|@\s*)(gmail|outlook|yahoo|hotmail|icloud)\s+(dot\s+com|token|talking|common|calm)/gi,
        
        // Handle sequences like "o and e f w" for individual characters
        /(email\s+is\s+|my\s+email\s+)([a-z](\s+(and\s+)?)){2,}([a-z]\s*){0,5}\s*(at\s+|@\s*)?([a-z](\s+(and\s+)?)){1,}\s*(dot\s+com|token|talking|common|calm)/gi,
        
        // Simple character sequence: "a b c at gmail dot com"
        /([a-z]\s+){2,}at\s+(gmail|outlook|yahoo|hotmail|icloud)\s+(dot\s+com|token|talking|common|calm)/gi
    ];
    
    for (const pattern of enhancedEmailPatterns) {
        const matches = text.match(pattern);
        if (matches) {
            for (const match of matches) {
                let cleaned = match
                    .replace(/^(email\s+is\s+|my\s+email\s+|email\s+address\s+is\s+|contact\s+me\s+at\s+|reach\s+me\s+at\s+)/gi, '')
                    .replace(/\s+at\s+/gi, '@')
                    .replace(/\s+(token|talking|common|calm|come|coming|column|commercial|commerce|compact|company|complete)\s*/gi, '.com')
                    .replace(/\s+dot\s+(com|org|net|edu)/gi, '.$1')
                    .replace(/g\s*mail/gi, 'gmail')
                    .replace(/jemail/gi, 'gmail')
                    .replace(/out\s*look/gi, 'outlook')
                    .replace(/ya\s*hoo/gi, 'yahoo')
                    .replace(/hot\s*mail/gi, 'hotmail')
                    .replace(/i\s*cloud/gi, 'icloud')
                    .replace(/proton\s*mail/gi, 'protonmail')
                    .replace(/\s+(and\s+)?/g, ''); // Remove spaces and "and" words
                
                // Special handling for spelled out characters
                if (cleaned.includes(' ')) {
                    // Handle "o and e f w crown" type patterns
                    const words = cleaned.split(/\s+/);
                    let emailParts = [];
                    for (const word of words) {
                        if (word.length === 1 && /[a-z0-9]/i.test(word)) {
                            emailParts.push(word);
                        } else if (['gmail', 'outlook', 'yahoo', 'hotmail', 'icloud'].includes(word.toLowerCase())) {
                            emailParts.push('@' + word.toLowerCase() + '.com');
                            break;
                        }
                    }
                    if (emailParts.length > 1) {
                        cleaned = emailParts.join('');
                    }
                }
                
                const validatedEmail = validateAndCleanEmail(cleaned);
                if (validatedEmail) {
                    return validatedEmail;
                }
            }
        }
    }
    
    // Final attempt: Look for partial email patterns and try to complete them
    const partialPatterns = [
        // Find something like "alex gmail" and assume it's "alex@gmail.com"
        /([a-zA-Z0-9._-]{2,})\s+(gmail|outlook|yahoo|hotmail|icloud)\b/gi,
        // Find "my email alex" patterns
        /(email\s+is\s+|my\s+email\s+)([a-zA-Z0-9._-]{2,})/gi,
        // Handle "o and e f w crown" type patterns (individual letters)
        /(email\s+is\s+|my\s+email\s+)(([a-z]\s*(and\s+)?){2,}[a-z])\s*(crown|gmail|outlook|yahoo|hotmail|icloud|token|talking|common|calm|come|dot\s+com)/gi,
        // Handle sequences like "s w u m p y a e" followed by provider
        /([a-z]\s+){3,}(crown|gmail|outlook|yahoo|hotmail|icloud|token|talking|common|calm)/gi
    ];
    
    for (const pattern of partialPatterns) {
        const matches = text.match(pattern);
        if (matches) {
            for (const match of matches) {
                let processed = match
                    .replace(/(email\s+is\s+|my\s+email\s+)/gi, '')
                    .replace(/\s+/g, '');
                
                // Handle spelled-out emails like "o and e f w crown"
                if (processed.includes('crown')) {
                    // "crown" might be ".com" or "gmail.com"
                    processed = processed.replace(/crown/gi, '@gmail.com');
                } else if (processed.includes('gmail') && !processed.includes('@')) {
                    processed = processed.replace('gmail', '@gmail.com');
                } else if (processed.includes('outlook') && !processed.includes('@')) {
                    processed = processed.replace('outlook', '@outlook.com');
                } else if (processed.includes('yahoo') && !processed.includes('@')) {
                    processed = processed.replace('yahoo', '@yahoo.com');
                } else if (processed.includes('hotmail') && !processed.includes('@')) {
                    processed = processed.replace('hotmail', '@hotmail.com');
                } else if (processed.includes('icloud') && !processed.includes('@')) {
                    processed = processed.replace('icloud', '@icloud.com');
                }
                
                // Clean up character sequences like "oandeefw" → "oefw"
                processed = processed
                    .replace(/and/g, '')
                    .replace(/\s+/g, '')
                    .toLowerCase();
                
                const validatedEmail = validateAndCleanEmail(processed);
                if (validatedEmail) {
                    return validatedEmail;
                }
            }
        }
    }
    
    return null;
}

function parseSpelledEmail(text) {
    // Pattern for spelled emails: "j-o-h-n at g-m-a-i-l dot c-o-m"
    const spelledPattern = /([a-z][\s\-]*){2,}[\s\-]*at[\s\-]*([a-z][\s\-]*){2,}[\s\-]*dot[\s\-]*([a-z][\s\-]*){2,}/gi;
    
    if (spelledPattern.test(text)) {
        let email = text
            .replace(/[\s\-]+/g, '')           // Remove spaces and dashes
            .replace(/at/g, '@')               // "at" → "@"  
            .replace(/dot/g, '.')              // "dot" → "."
            .replace(/underscore/g, '_');      // "underscore" → "_"
        
        return email;
    }
    
    return null;
}

function validateAndCleanEmail(email) {
    if (!email) return null;
    
    // Clean up common speech-to-text errors
    let cleanEmail = email
        .replace(/\s+/g, '')                  // Remove all spaces
        .toLowerCase()
        .trim();
    
    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    
    if (emailRegex.test(cleanEmail)) {
        return cleanEmail;
    }
    
    return null;
}

// Extract meeting details from transcript
function extractMeetingDetails(transcript) {
    const text = transcript.toLowerCase();
    
    // Extract date patterns
    const datePatterns = [
        /next\s+(week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)/gi,
        /(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+next\s+week/gi,
        /(tomorrow|today)/gi
    ];
    
    // Extract time patterns
    const timePatterns = [
        /(\d{1,2}):?(\d{2})?\s*(am|pm|a\.m\.|p\.m\.)/gi,
        /(\d{1,2})\s+(o'clock|oclock)/gi
    ];
    
    let extractedDate = null;
    let extractedTime = null;
    
    // Find date matches
    for (const pattern of datePatterns) {
        const match = text.match(pattern);
        if (match) {
            extractedDate = match[0];
            break;
        }
    }
    
    // Find time matches
    for (const pattern of timePatterns) {
        const match = text.match(pattern);
        if (match) {
            extractedTime = match[0];
            break;
        }
    }
    
    return {
        date: extractedDate,
        time: extractedTime,
        hasDateTime: !!(extractedDate || extractedTime)
    };
}

// Helper function to get matched keywords for debugging
function getMatchedKeywords(lowerText, intent) {
    const keywordSets = {
        meeting_discussion: [
            // Phrases
            'arrange a meeting', 'set up a meeting', 'schedule a meeting', 'schedule meeting',
            'have a meeting', 'going to have a meeting', 'would like to schedule', 'want to schedule',
            'arrange a medium', 'set up a medium', 'schedule a medium',
            'meeting on', 'meeting at', 'meeting next', 'medium on', 'medium at', 'medium next',
            'would like to meet', 'want to meet', 'let\'s meet', 'discuss', 'catch up', 'get together',
            'resignation', 'about my resignation',
            // Individual keywords
            'arrange', 'schedule', 'meeting', 'meet', 'appointment', 'consultation'
        ],
        support_request: ['help', 'support', 'problem', 'issue', 'trouble', 'assistance'],
        information_request: ['information', 'info', 'details', 'tell me', 'what is', 'how much', 'price'],
        general_inquiry: []
    };
    
    const keywords = keywordSets[intent] || [];
    return keywords.filter(keyword => lowerText.includes(keyword));
}

// ====== ALL ROUTE DEFINITIONS MUST BE BEFORE ERROR HANDLERS ======

// Helper endpoint to get Twilio webhook URL
app.get('/twilio-config', (req, res) => {
    try {
        const protocol = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
        const host = req.headers['x-forwarded-host'] || req.headers['host'] || req.hostname;
        const webhookUrl = `${protocol}://${host}/voice`;
        
        console.log(`📋 Twilio config requested by ${req.ip}`);
        console.log(`🔗 Generated webhook URL: ${webhookUrl}`);
        
        res.json({
            status: 'success',
            webhook_url: webhookUrl,
            current_host: host,
            protocol: protocol,
            instructions: [
                "1. Go to your Twilio Console (https://console.twilio.com/)",
                "2. Navigate to Phone Numbers > Manage > Active numbers",
                "3. Click on your phone number",
                `4. Set the webhook URL to: ${webhookUrl}`,
                "5. Set HTTP method to POST",
                "6. Save the configuration"
            ],
            bridge_mode: {
                enabled: !!process.env.BRIDGE_TARGET_NUMBER,
                target_number: process.env.BRIDGE_TARGET_NUMBER || "Not configured"
            },
            environment: {
                node_env: NODE_ENV,
                twilio_configured: !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN),
                openai_configured: !!process.env.OPENAI_API_KEY,
                deepgram_configured: !!(process.env.DEEPGRAM_API_KEY || deepgramApiKey),
                n8n_configured: !!process.env.N8N_WEBHOOK_URL
            },
            websocket_url: `${protocol === 'https' ? 'wss' : 'ws'}://${host}?callSid=CALL_SID_HERE`,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('❌ Error in /twilio-config:', error);
        res.status(500).json({
            error: 'Internal server error',
            message: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Simple debug endpoint
app.get('/debug', (req, res) => {
    res.json({
        status: 'Server is running',
        timestamp: new Date().toISOString(),
        environment: NODE_ENV,
        bridge_configured: !!process.env.BRIDGE_TARGET_NUMBER,
        bridge_target: process.env.BRIDGE_TARGET_NUMBER || 'Not set',
        endpoints_available: [
            '/',
            '/api',
            '/health', 
            '/twilio-config',
            '/debug',
            '/voice',
            '/webhook/voice',
            '/webhook/recording'
        ],
        deployment_version: 'DEEPGRAM-OPTIMIZED-V2', // Deepgram-only transcription
        headers: req.headers,
        url: req.url,
        method: req.method,
        ip: req.ip
    });
});

// Voice webhook endpoints (both supported for compatibility)
app.post('/voice', (req, res) => {
    console.log('✅ /voice endpoint called - CORRECT endpoint!');
    handleVoiceWebhook(req, res);
});

app.post('/webhook/voice', (req, res) => {
    console.log('⚠️ /webhook/voice endpoint called - legacy endpoint, but still working');
    handleVoiceWebhook(req, res);
});

// Webhook for recording completion (bridge mode)
app.post('/webhook/recording', async (req, res) => {
    console.log('🎵 Bridge call recording completed:', req.body);
    
    const { RecordingUrl, CallSid, RecordingDuration, RecordingSid } = req.body;
    
    console.log(`🎵 Recording URL: ${RecordingUrl}`);
    console.log(`⏱️ Duration: ${RecordingDuration} seconds`);
    console.log(`🆔 Recording SID: ${RecordingSid}`);
    
    // Process the bridge call recording with AI
    if (RecordingUrl && RecordingDuration > 2) {
        console.log('🚀 Starting AI analysis of bridge call recording...');
        
        try {
            // Download and analyze the recording
            const analysisResult = await analyzeBridgeRecording({
                url: RecordingUrl,
                callSid: CallSid,
                duration: RecordingDuration
            });
            
            console.log('✅ Bridge call analysis completed:', analysisResult);
            
            // Send bridge call analysis to n8n
            if (process.env.N8N_WEBHOOK_URL) {
                const bridgeWebhookData = {
                    type: 'bridge_call_analysis',
                    callSid: CallSid,
                    recordingUrl: RecordingUrl,
                    duration: RecordingDuration,
                    analysis: analysisResult,
                    timestamp: new Date().toISOString()
                };
                
                fetch(process.env.N8N_WEBHOOK_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(bridgeWebhookData)
                }).then(response => {
                    console.log('✅ Bridge call analysis sent to n8n:', response.status);
                }).catch(error => {
                    console.error('❌ Error sending bridge analysis to n8n:', error);
                });
            }
            
        } catch (error) {
            console.error('❌ Bridge call analysis failed:', error);
        }
    }
    
    res.status(200).send('OK');
});

// ====== ERROR HANDLERS AND 404 MUST BE LAST ======

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('ERROR Unhandled error:', err);
    res.status(500).json({
        error: NODE_ENV === 'production' ? 'Internal server error' : err.message,
        timestamp: new Date().toISOString()
    });
});

// 404 handler (MUST BE LAST)
app.use('*', (req, res) => {
    res.status(404).json({
        error: 'Endpoint not found',
        path: req.originalUrl,
        available_endpoints: [
            '/',
            '/api', 
            '/health',
            '/twilio-config',
            '/debug',
            '/voice',
            '/webhook/voice',
            '/webhook/recording'
        ],
        websocket_paths: ['/ws', '/stream', '/?callSid=CALLSID']
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
    console.log(`SHUTDOWN Received ${signal}. Attempting graceful shutdown...`);
    console.log('GRACEFUL Shutting down gracefully...');
    
    server.close(() => {
        console.log(`SUCCESS Closed ${connections.size}/${connections.size} connections`);
        
        // Close WebSocket connections
        wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.close();
            }
        });
        
        console.log('SOCKET Closing WebSocket connections...');
        console.log('SUCCESS Graceful shutdown completed');
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
    console.log(`BROADCAST WebSocket server ready for connections`);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('ERROR Uncaught Exception:', error);
    gracefulShutdown('UNCAUGHT_EXCEPTION');
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('ERROR Unhandled Rejection at:', promise, 'reason:', reason);
    gracefulShutdown('UNHANDLED_REJECTION');
});

// Voice webhook handler function (moved above route definitions)
function handleVoiceWebhook(req, res) {
    console.log('🔥 WEBHOOK CALLED:', req.url);
    console.log('🔥 WEBHOOK METHOD:', req.method);
    console.log('🔥 WEBHOOK HEADERS:', JSON.stringify(req.headers, null, 2));
    console.log('🔥 WEBHOOK BODY:', JSON.stringify(req.body, null, 2));
    
    const { CallSid, From, To, CallStatus } = req.body;
    console.log('📞 Incoming call received from Twilio');
    console.log('📋 Call details:', { Called: To, CallerCountry: req.body.CallerCountry, Direction: req.body.Direction, CallerState: req.body.CallerState, ToZip: req.body.ToZip, CallSid, To, CallerZip: req.body.CallerZip, ToCountry: req.body.ToCountry, CallToken: req.body.CallToken, CalledZip: req.body.CalledZip, ApiVersion: req.body.ApiVersion, CalledCity: req.body.CalledCity, CallStatus, From, AccountSid: req.body.AccountSid, CalledCountry: req.body.CalledCountry, CallerCity: req.body.CallerCity, ToCity: req.body.ToCity, FromCountry: req.body.FromCountry, Caller: req.body.Caller, FromCity: req.body.FromCity, CalledState: req.body.CalledState, FromZip: req.body.FromZip, FromState: req.body.FromState });
    
    console.log(`📞 Call from ${From} to ${To} (${req.body.Direction})`);
    console.log(`🆔 Call SID: ${CallSid}`);
    
    // Broadcast call start to dashboard
    broadcastToClients({
        type: 'call_started',
        message: `Call started from ${From}`,
        data: {
            callSid: CallSid,
            from: From,
            to: To,
            status: CallStatus,
            timestamp: new Date().toISOString()
        }
    });
    
    // Get the current host dynamically (works for localhost, ngrok, or deployed URLs)
    const protocol = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
    const host = req.headers['x-forwarded-host'] || req.headers['host'] || req.hostname;
    const wsProtocol = protocol === 'https' ? 'wss' : 'ws';
    const baseWsUrl = `${wsProtocol}://${host}`;
    
    console.log(`🔗 Detected host: ${host}`);
    console.log(`🔗 Using WebSocket base URL: ${baseWsUrl}`);
    
    // Check if this is a bridge call (Person A calling to be connected to Person B)
    const bridgeNumber = process.env.BRIDGE_TARGET_NUMBER; // Set this in your environment variables
    
    if (bridgeNumber) {
        console.log(`🌉 Bridge mode: Connecting ${From} to ${bridgeNumber}`);
        
        // TwiML for bridge mode with recording and real-time streaming
        const streamUrl = `${baseWsUrl}/stream/${CallSid}`;
        console.log('🔗 Stream URL for TwiML:', streamUrl);
        
        const bridgeTwiML = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">Connecting your call, please wait...</Say>
    <Start>
        <Stream url="${streamUrl}" track="both_tracks" />
    </Start>
    <Dial 
        record="true" 
        recordingStatusCallback="${protocol}://${host}/webhook/recording"
        timeout="30"
        callerId="${From}">
        <Number>${bridgeNumber}</Number>
    </Dial>
    <Say voice="alice">The call could not be connected. Please try again later.</Say>
</Response>`;
        
        console.log('🌉 Bridge TwiML Response:', bridgeTwiML);
        res.type('text/xml');
        res.send(bridgeTwiML);
        
    } else {
        // Original real-time analysis mode (no bridge)
        console.log('🎙️ Real-time analysis mode (no bridge number configured)');
        
        // TwiML response for real-time streaming
        const streamUrl = `${baseWsUrl}/stream/${CallSid}`;
        console.log('🔗 Stream URL for TwiML:', streamUrl);
        
        // Generate TwiML response for incoming calls
        const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Start>
        <Stream url="${streamUrl}" track="inbound_track" />
    </Start>
    <Pause length="30"/>
</Response>`;
        
        console.log('📋 TwiML Response:', twimlResponse);
        res.type('text/xml');
        res.send(twimlResponse);
    }
}

// Analyze bridge call recording (moved above route definitions)
async function analyzeBridgeRecording({ url, callSid, duration }) {
    try {
        console.log('🎵 Downloading bridge call recording...');
        
        // Download the recording from Twilio
        if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
            throw new Error('Twilio credentials not configured for recording download');
        }
        
        console.log('🔐 Using Twilio credentials for recording download...');
        console.log('🔍 Account SID:', process.env.TWILIO_ACCOUNT_SID ? process.env.TWILIO_ACCOUNT_SID.substring(0, 10) + '...' : 'MISSING');
        console.log('🔍 Auth Token:', process.env.TWILIO_AUTH_TOKEN ? process.env.TWILIO_AUTH_TOKEN.substring(0, 10) + '...' : 'MISSING');
        console.log('🔍 Recording URL format:', url.substring(0, 50) + '...');
        
        // Verify credentials exist
        if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
            throw new Error('Missing Twilio credentials - check TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN');
        }
        
        // Wait a bit for recording to be ready
        await new Promise(resolve => setTimeout(resolve, 2000));
        console.log('⏱️ Waited 2 seconds for recording to be ready...');
        
        // Enhanced Twilio authentication with better error handling
        const accountSid = process.env.TWILIO_ACCOUNT_SID;
        const authToken = process.env.TWILIO_AUTH_TOKEN;
        
        console.log('🔑 Account SID check:', accountSid ? `${accountSid.substring(0, 10)}...` : 'MISSING');
        console.log('🔑 Auth Token check:', authToken ? `${authToken.substring(0, 10)}...` : 'MISSING');
        
        if (!accountSid || !authToken) {
            throw new Error('Missing Twilio credentials - check TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN');
        }
        
        // Create proper basic auth header
        const authString = `${accountSid}:${authToken}`;
        const authHeader = 'Basic ' + Buffer.from(authString).toString('base64');
        console.log('🔑 Auth header created, length:', authHeader.length);
        
        // Use Twilio's direct media URL format - try different approaches
        let downloadUrl = url;
        
        // Try the original URL first, then with .wav extension
        console.log('🔗 Trying original download URL:', url);
        
        let audioBuffer;
        
        const response = await fetch(downloadUrl, {
            headers: {
                'Authorization': authHeader,
                'User-Agent': 'Real-Time-Call-Processor/1.0',
                'Accept': 'audio/wav, audio/mpeg, audio/*',
                'Content-Type': 'application/json'
            }
        });
        
        console.log(`📡 Recording download response: ${response.status} ${response.statusText}`);
        
        if (!response.ok) {
            // Try alternative URL formats if first attempt fails
            if (response.status === 401 && !downloadUrl.endsWith('.wav')) {
                console.log('🔄 Retrying with .wav extension...');
                downloadUrl = url + '.wav';
                
                const retryResponse = await fetch(downloadUrl, {
                    headers: {
                        'Authorization': authHeader,
                        'User-Agent': 'Real-Time-Call-Processor/1.0',
                        'Accept': 'audio/wav, audio/mpeg, audio/*',
                    }
                });
                
                if (!retryResponse.ok) {
                    console.log(`❌ Retry also failed: ${retryResponse.status} ${retryResponse.statusText}`);
                    throw new Error(`Recording download failed even with retry: ${retryResponse.status} ${retryResponse.statusText}`);
                }
                
                console.log('✅ Retry with .wav extension successful');
                audioBuffer = await retryResponse.buffer();
                console.log(`📥 Downloaded ${audioBuffer.length} bytes of audio (retry successful)`);
            } else {
                if (response.status === 401) {
                    throw new Error(`Authentication failed - check Twilio credentials (${response.status})`);
                } else if (response.status === 403) {
                    throw new Error(`Access forbidden - check Twilio permissions (${response.status})`);
                } else if (response.status === 404) {
                    throw new Error(`Recording not found - it may not be ready yet (${response.status})`);
                } else {
                    throw new Error(`Failed to download recording: ${response.status} ${response.statusText}`);
                }
            }
        } else {
            audioBuffer = await response.buffer();
            console.log(`📥 Downloaded ${audioBuffer.length} bytes of audio`);
        }
        
        // For now, return basic analysis without transcription
        // TODO: Implement Deepgram transcription for bridge recordings
        console.log('⚠️ Bridge call recording transcription not implemented with Deepgram yet');
        const transcriptResult = {
            text: 'Bridge call recording analysis not yet implemented with Deepgram',
            status: 'completed'
        };
        
        // Analyze with OpenAI for meeting insights
        console.log('🧠 Analyzing bridge conversation with OpenAI...');
        const aiResponse = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                {
                    role: "system",
                    content: `You are an AI assistant analyzing a bridge call conversation between two people. Provide a JSON response with:
                    {
                        "conversation_type": "meeting/negotiation/support/consultation/other",
                        "participants": ["speaker_a_role", "speaker_b_role"],
                        "key_topics": ["topic1", "topic2"],
                        "decisions_made": ["decision1", "decision2"],
                        "action_items": ["action1", "action2"],
                        "sentiment": "positive/neutral/negative",
                        "urgency": "low/medium/high",
                        "follow_up_needed": true/false,
                        "summary": "brief professional summary of the conversation",
                        "emails_mentioned": ["email1@domain.com"],
                        "dates_mentioned": ["next friday", "january 15th"],
                        "next_steps": "recommended next steps"
                    }`
                },
                {
                    role: "user",
                    content: `Bridge call conversation transcript: "${transcriptResult.text}"`
                }
            ],
            temperature: 0.2
        });
        
        let aiAnalysis;
        try {
            aiAnalysis = JSON.parse(aiResponse.choices[0].message.content);
        } catch (parseError) {
            aiAnalysis = {
                conversation_type: "meeting",
                participants: ["speaker_a", "speaker_b"],
                key_topics: ["general discussion"],
                summary: aiResponse.choices[0].message.content,
                sentiment: "neutral",
                urgency: "medium",
                follow_up_needed: true
            };
        }
        
        return {
            transcript: transcriptResult.text,
            speakers: transcriptResult.utterances || [],
            ai_analysis: aiAnalysis,
            assembly_insights: {
                sentiment: transcriptResult.sentiment_analysis_results,
                entities: transcriptResult.entities,
                chapters: transcriptResult.chapters,
                summary: transcriptResult.summary
            },
            duration: duration,
            processed: true,
            timestamp: new Date().toISOString()
        };
        
    } catch (error) {
        console.error('❌ Bridge recording analysis error:', error);
        return {
            error: `Bridge analysis failed: ${error.message}`,
            processed: false,
            timestamp: new Date().toISOString()
        };
    }
}

// Create WAV header for PCM audio data
function createWavHeader(pcmDataLength, sampleRate = 16000, channels = 1, bitsPerSample = 16) {
    const header = Buffer.alloc(44);
    const bytesPerSample = bitsPerSample / 8;
    const blockAlign = channels * bytesPerSample;
    const byteRate = sampleRate * blockAlign;
    
    // RIFF header
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + pcmDataLength, 4);
    header.write('WAVE', 8);
    
    // fmt chunk
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16); // fmt chunk size
    header.writeUInt16LE(1, 20);  // audio format (PCM)
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    
    // data chunk
    header.write('data', 36);
    header.writeUInt32LE(pcmDataLength, 40);
    
    return header;
}

// Mulaw to Linear16 PCM conversion with upsampling for Deepgram compatibility
function convertMulawToLinear16(mulawBuffer) {
    // Mulaw decompression table (8-bit mulaw to 16-bit linear PCM)
    const mulawToLinear = [
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
    
    // Convert mulaw to linear16 and upsample from 8kHz to 16kHz
    // Simple upsampling: duplicate each sample (8kHz → 16kHz)
    const upsampledBuffer = Buffer.alloc(mulawBuffer.length * 4); // 2x for linear16, 2x for upsampling
    
    for (let i = 0; i < mulawBuffer.length; i++) {
        const mulawValue = mulawBuffer[i];
        const linearValue = mulawToLinear[mulawValue];
        
        // Write each sample twice for 2x upsampling
        const outputIndex = i * 4;
        upsampledBuffer.writeInt16LE(linearValue, outputIndex);     // Original sample
        upsampledBuffer.writeInt16LE(linearValue, outputIndex + 2); // Duplicate for upsampling
    }
    
    return upsampledBuffer;
}

// HTTP-based chunked audio processing fallback
function initializeHttpChunkedProcessing(callSid, ws) {
    console.log('🔄 Initializing HTTP chunked processing for call:', callSid);
    
    // Audio buffer for chunked processing
    ws.audioChunks = [];
    ws.chunkBuffer = Buffer.alloc(0);
    ws.lastProcessTime = Date.now();
    ws.chunkCount = 0;
    
    // Process audio chunks every 3 seconds
    ws.chunkProcessor = setInterval(async () => {
        if (ws.chunkBuffer.length > 0) {
            try {
                console.log(`🔄 Processing audio chunk ${++ws.chunkCount} (${ws.chunkBuffer.length} bytes)`);
                
                // Create proper WAV file with header
                const wavHeader = createWavHeader(ws.chunkBuffer.length);
                const wavFile = Buffer.concat([wavHeader, ws.chunkBuffer]);
                
                console.log(`📊 WAV file created: ${wavFile.length} bytes (${wavHeader.length} header + ${ws.chunkBuffer.length} data)`);
                
                // Send to Deepgram HTTP API
                const response = await fetch('https://api.deepgram.com/v1/listen', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Token ${deepgramApiKey}`,
                        'Content-Type': 'audio/wav',
                        'Accept': 'application/json'
                    },
                    body: wavFile
                });
                
                if (response.ok) {
                    const result = await response.json();
                    const transcript = result.results?.channels?.[0]?.alternatives?.[0]?.transcript;
                    
                    if (transcript && transcript.trim().length > 0) {
                        console.log(`📝 HTTP CHUNK TRANSCRIPT: "${transcript}"`);
                        
                        // Broadcast transcript
                        broadcastToClients({
                            type: 'live_transcript',
                            message: transcript,
                            data: {
                                callSid: callSid,
                                text: transcript,
                                confidence: result.results?.channels?.[0]?.alternatives?.[0]?.confidence || 0,
                                is_final: true,
                                provider: 'deepgram_http',
                                chunk_number: ws.chunkCount,
                                timestamp: new Date().toISOString()
                            }
                        });
                        
                        // Process for intent detection
                        detectAndProcessIntent(transcript, callSid);
                        analyzeTranscriptWithAI(transcript, callSid);
                    }
                } else {
                    console.error(`❌ HTTP chunk processing failed: ${response.status} ${response.statusText}`);
                }
                
                // Clear buffer for next chunk
                ws.chunkBuffer = Buffer.alloc(0);
                
            } catch (error) {
                console.error('❌ HTTP chunk processing error:', error.message);
            }
        }
    }, 3000); // Process every 3 seconds
    
    console.log('✅ HTTP chunked processing initialized - will process audio every 3 seconds');
    
    broadcastToClients({
        type: 'http_transcription_ready',
        message: 'HTTP-based transcription ready (3-second chunks)',
        data: {
            callSid: callSid,
            method: 'http_chunked',
            interval: '3_seconds',
            timestamp: new Date().toISOString()
        }
    });
}

// Deepgram real-time transcription initialization
async function initializeDeepgramRealtime(callSid, ws) {
    console.log('🎙️ Initializing Deepgram real-time transcription for call:', callSid);
    console.log('🔑 Using Deepgram API Key:', deepgramApiKey ? `${deepgramApiKey.substring(0, 10)}...` : 'MISSING');
    
    if (!deepgramApiKey) {
        console.error('❌ No Deepgram API key available');
        broadcastToClients({
            type: 'transcription_fallback',
            message: 'Deepgram API key missing - will analyze recording after call',
            data: {
                callSid: callSid,
                error: 'Missing API key',
                fallbackMethod: 'post_call_recording_analysis',
                timestamp: new Date().toISOString()
            }
        });
        return null;
    }
    
    try {
        // Test API key validity first
        console.log('🔑 TESTING API KEY VALIDITY before WebSocket connection...');
        
        try {
            const testResponse = await fetch('https://api.deepgram.com/v1/projects', {
                headers: {
                    'Authorization': `Token ${deepgramApiKey}`,
                    'Content-Type': 'application/json'
                }
            });
            
            console.log(`🔑 API KEY TEST: ${testResponse.status} ${testResponse.statusText}`);
            
            if (!testResponse.ok) {
                const errorText = await testResponse.text();
                console.error(`❌ API KEY INVALID: ${testResponse.status} - ${errorText}`);
                throw new Error(`Invalid Deepgram API key: ${testResponse.status} ${testResponse.statusText}`);
            }
            
            const projectData = await testResponse.json();
            console.log('✅ API KEY VALID - Projects accessible:', projectData.projects?.length || 0);
            
        } catch (apiError) {
            console.error('❌ API KEY TEST FAILED:', apiError.message);
            console.log('⚠️ Proceeding with WebSocket connection anyway...');
            // Don't throw - try the WebSocket connection anyway
        }
        
        // Create Deepgram live connection with ENHANCED TROUBLESHOOTING
        console.log('🔗 Creating Deepgram WebSocket connection...');
        console.log('🔧 TESTING: mulaw → linear16 with 8kHz → 16kHz upsampling...');
        console.log('🎯 MODEL: Using enhanced-general model for better compatibility...');
        // Use PHONE-OPTIMIZED configuration for better bridge call compatibility
        console.log('🔧 PHONE-OPTIMIZED CONFIG: Enhanced settings for bridge calls...');
        const deepgramLive = deepgram.listen.live({
            model: 'nova-2-phonecall',  // Phone call optimized model
            language: 'en-US',
            sample_rate: 8000,
            encoding: 'mulaw',
            channels: 1,
            interim_results: true,
            smart_format: true,         // Better formatting for phone calls
            punctuate: true,           // Add punctuation
            vad_events: true,          // Voice activity detection events
            endpointing: 300,          // Wait 300ms before finalizing
            utterance_end_ms: 1000     // End utterance after 1 second of silence
        });

        let isConnected = false;
        let audioBuffer = [];
        let fullTranscript = '';
        let mediaPacketCount = 0;
        let twimlFinished = true; // Start immediately for Deepgram
        let resultsReceived = 0;
        let lastResultTime = Date.now();

        // Add connection timeout
        const connectionTimeout = setTimeout(() => {
            if (!isConnected) {
                console.error('⏰ DEEPGRAM CONNECTION TIMEOUT after 10 seconds');
                broadcastToClients({
                    type: 'deepgram_timeout',
                    message: 'Deepgram connection timeout - will analyze recording after call',
                    data: {
                        callSid: callSid,
                        error: 'Connection timeout',
                        timestamp: new Date().toISOString()
                    }
                });
            }
        }, 10000);

        // Add results timeout checker with more detailed diagnosis
        const resultsChecker = setInterval(() => {
            if (isConnected && mediaPacketCount > 100 && resultsReceived === 0) {
                const timeSinceStart = Date.now() - lastResultTime;
                console.error(`⚠️ DEEPGRAM RESULTS TIMEOUT: ${mediaPacketCount} packets sent, 0 results received after ${Math.round(timeSinceStart/1000)}s`);
                console.error('🔍 MOST LIKELY ISSUES FOR BRIDGE CALLS:');
                console.error('  1. Audio contains only silence or background noise (no speech detected)');
                console.error('  2. Bridge call audio quality too low for speech recognition');
                console.error('  3. Twilio bridge audio routing issues');
                console.error('  4. Deepgram mulaw format compatibility issues');
                console.error('💡 SOLUTION: Check audio analysis logs above for signal levels');
                
                // Switch to HTTP fallback if no results after significant time
                if (mediaPacketCount > 600 && resultsReceived === 0) {
                    console.log('🔄 SWITCHING TO HTTP FALLBACK due to no WebSocket results...');
                    clearInterval(resultsChecker);
                    initializeHttpChunkedProcessing(callSid, ws);
                }
            }
        }, 10000); // Check every 10 seconds

        deepgramLive.on('open', () => {
            console.log('✅ DEEPGRAM CONNECTED for call:', callSid);
            console.log('🔧 DEEPGRAM CONFIG: nova-2-phonecall model, en-US language, mulaw encoding, 8kHz sample rate');
            console.log('🎯 RAW MULAW: Sending original Twilio audio format directly');
            console.log('📊 INTERIM RESULTS: Enabled with VAD events and smart formatting');
            console.log('🌍 DEEPGRAM PHONE: Optimized specifically for phone call transcription');
            isConnected = true;
            clearTimeout(connectionTimeout);
            
            // Test connection with a small audio packet
            console.log('🧪 DEEPGRAM: Testing connection with initial audio...');
            
            // Send a test audio packet to verify the connection works
            const testAudio = Buffer.alloc(160, 127); // Silent mulaw audio
            try {
                deepgramLive.send(testAudio);
                console.log('✅ DEEPGRAM: Test audio packet sent successfully');
                
                // Send a second test with some variation to trigger processing
                const testAudio2 = Buffer.alloc(160);
                for (let i = 0; i < 160; i++) {
                    testAudio2[i] = 127 + Math.sin(i * 0.1) * 50; // Generate some audio variation
                }
                deepgramLive.send(testAudio2);
                console.log('✅ DEEPGRAM: Test audio with variation sent');
            } catch (testError) {
                console.error('❌ DEEPGRAM: Failed to send test audio:', testError);
            }
            
            // Broadcast connection success
            broadcastToClients({
                type: 'deepgram_connected',
                message: 'Deepgram phone-optimized transcription ready (nova-2-phonecall with VAD)',
                data: {
                    callSid: callSid,
                    provider: 'deepgram',
                    model: 'nova-2-phonecall',
                    encoding: 'mulaw',
                    audio_format: 'raw_mulaw_8khz',
                    sample_rate: 8000,
                    features: ['vad_events', 'smart_format', 'punctuate'],
                    optimization: 'phone_calls',
                    timestamp: new Date().toISOString()
                }
            });

            // Process any buffered audio
            if (audioBuffer.length > 0) {
                console.log(`📤 Sending ${audioBuffer.length} buffered audio packets to Deepgram`);
                audioBuffer.forEach(audio => deepgramLive.send(audio));
                audioBuffer = [];
            }
        });

        // Add debugging for ALL Deepgram events
        console.log('🔧 DEEPGRAM: Setting up event listeners...');
        
        deepgramLive.on('results', (data) => {
            resultsReceived++;
            lastResultTime = Date.now();
            console.log(`📥 DEEPGRAM RAW RESULT #${resultsReceived} received for call:`, callSid);
            console.log('🔍 DEEPGRAM RESULT TYPE:', data.type || 'unknown');
            console.log('📄 DEEPGRAM FULL RESULT:', JSON.stringify(data, null, 2));
            
            if (data.channel && data.channel.alternatives && data.channel.alternatives[0]) {
                const transcript = data.channel.alternatives[0];
                
                if (transcript && transcript.transcript) {
                    const confidence = transcript.confidence || 0;
                    const isFinal = data.is_final;
                    
                    console.log(`🎯 DEEPGRAM TRANSCRIPT: "${transcript.transcript}" (final: ${isFinal}, confidence: ${confidence.toFixed(2)})`);
                    
                    // Filter low quality transcripts (reduced thresholds for better detection)
                    if (confidence > 0.1 && transcript.transcript.trim().length > 0) {
                        console.log(`✅ DEEPGRAM ACCEPTED: "${transcript.transcript}"`);
                        
                        // Add to full transcript if final
                        if (isFinal) {
                            fullTranscript += transcript.transcript + ' ';
                        }
                        
                        // Broadcast to dashboard
                        broadcastToClients({
                            type: 'live_transcript',
                            message: transcript.transcript,
                            data: {
                                callSid: callSid,
                                text: transcript.transcript,
                                confidence: confidence,
                                is_final: isFinal,
                                provider: 'deepgram',
                                timestamp: new Date().toISOString()
                            }
                        });
                        
                        // Process final transcripts for intent detection
                        if (isFinal && transcript.transcript.trim().length > 2) {
                            console.log('🧠 Processing Deepgram transcript for intents...');
                            
                            // Run intent detection and AI analysis in parallel
                            Promise.allSettled([
                                detectAndProcessIntent(transcript.transcript, callSid),
                                analyzeTranscriptWithAI(transcript.transcript, callSid)
                            ]).then(results => {
                                console.log('✅ Deepgram transcript processing completed');
                            }).catch(error => {
                                console.error('❌ Deepgram transcript processing error:', error);
                            });
                        }
                    } else {
                        console.log(`🚫 DEEPGRAM FILTERED: "${transcript.transcript}" (confidence: ${confidence.toFixed(2)}, length: ${transcript.transcript.trim().length})`);
                    }
                } else {
                    console.log('📥 DEEPGRAM: No transcript in alternatives[0]');
                }
            } else {
                console.log('📥 DEEPGRAM: No channel/alternatives in result');
            }
        });

        // Add listeners for ALL possible Deepgram events
        deepgramLive.on('utteranceEnd', (data) => {
            console.log('🗣️ DEEPGRAM UTTERANCE END:', JSON.stringify(data, null, 2));
        });

        deepgramLive.on('speechStarted', (data) => {
            console.log('🎤 DEEPGRAM SPEECH STARTED:', JSON.stringify(data, null, 2));
        });

        deepgramLive.on('speechEnded', (data) => {
            console.log('🔇 DEEPGRAM SPEECH ENDED:', JSON.stringify(data, null, 2));
        });

        // Voice Activity Detection events
        deepgramLive.on('vad', (data) => {
            console.log('🗣️ DEEPGRAM VAD EVENT:', JSON.stringify(data, null, 2));
        });

        deepgramLive.on('metadata', (data) => {
            console.log('📊 DEEPGRAM METADATA:', JSON.stringify(data, null, 2));
        });

        deepgramLive.on('warning', (data) => {
            console.log('⚠️ DEEPGRAM WARNING:', JSON.stringify(data, null, 2));
        });

        deepgramLive.on('finalize', (data) => {
            console.log('🏁 DEEPGRAM FINALIZE:', JSON.stringify(data, null, 2));
        });

        // Catch any other events
        deepgramLive.on('message', (data) => {
            console.log('📨 DEEPGRAM MESSAGE:', JSON.stringify(data, null, 2));
        });

        deepgramLive.on('error', (error) => {
            console.error('❌ DEEPGRAM WEBSOCKET ERROR:', error);
            console.error('🔍 WebSocket URL that failed:', error.url || 'Unknown URL');
            console.error('🔍 Ready State:', error.readyState || 'Unknown');
            
            // WebSocket failed - switch to HTTP chunked processing fallback
            console.log('🔄 WEBSOCKET FAILED - Switching to HTTP chunked processing fallback...');
            console.log('💡 This is likely due to Render.com blocking WebSocket connections to Deepgram');
            
            // Initialize HTTP-based chunked processing
            initializeHttpChunkedProcessing(callSid, ws);
            
            broadcastToClients({
                type: 'transcription_fallback',
                message: 'Switched to HTTP-based transcription due to WebSocket blocking',
                data: {
                    callSid: callSid,
                    fallback_method: 'http_chunked_processing',
                    reason: 'WebSocket connection blocked by hosting platform',
                    timestamp: new Date().toISOString()
                }
            });
        });

        deepgramLive.on('close', () => {
            console.log('🔒 DEEPGRAM CONNECTION CLOSED for call:', callSid);
            console.log(`📊 DEEPGRAM STATS: ${resultsReceived} results received, packets should be >0 if audio was sent`);
            isConnected = false;
            clearInterval(resultsChecker);
            
            // Log final transcript
            if (fullTranscript.trim()) {
                console.log('📝 DEEPGRAM FULL TRANSCRIPT:', fullTranscript.trim());
            } else {
                console.log('⚠️ DEEPGRAM: No transcript generated - possible audio or configuration issue');
            }
        });

        // Store the Deepgram connection for use in the existing message handler
        ws.deepgramLive = deepgramLive;
        ws.deepgramConnected = () => isConnected;
        ws.deepgramBuffer = audioBuffer;

        return deepgramLive;

    } catch (error) {
        console.error('❌ Failed to initialize Deepgram:', error);
        
        broadcastToClients({
            type: 'transcription_fallback',
            message: 'Real-time transcription unavailable - will analyze recording after call',
            data: {
                callSid: callSid,
                error: error.message,
                fallbackMethod: 'post_call_recording_analysis',
                timestamp: new Date().toISOString()
            }
        });
        
        return null;
    }
}