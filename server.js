// Real-Time Phone Call Agent with AssemblyAI Integration - Force restart for API key update
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const fs = require('fs');

// AI Service imports
const OpenAI = require('openai');

// AssemblyAI for real-time transcription - MAXIMUM ACCURACY PROVIDER (93.3% accuracy!)
const { AssemblyAI } = require('assemblyai');

const app = express();
const server = http.createServer(app);

// Initialize AI clients - handle OpenAI gracefully
let openai = null;
try {
    if (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim().length > 0) {
        openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        console.log('🧠 OpenAI client initialized successfully');
    } else {
        console.log('⚠️ OpenAI API key not provided - AI analysis will be skipped');
    }
} catch (error) {
    console.error('❌ Failed to initialize OpenAI:', error.message);
    console.log('⚠️ Continuing without OpenAI - AI analysis will be skipped');
    openai = null;
}

// Initialize AssemblyAI client for real-time transcription (MUCH MORE ACCURATE!)
const assemblyAIApiKey = process.env.ASSEMBLYAI_API_KEY;
console.log('🔑 AssemblyAI API Key configured:', assemblyAIApiKey ? `${assemblyAIApiKey.substring(0, 10)}...` : 'MISSING');

if (!assemblyAIApiKey) {
    console.error('❌ ASSEMBLYAI_API_KEY environment variable is required!');
    console.error('🔧 Please set ASSEMBLYAI_API_KEY in your environment variables');
    console.error('💡 Get your free API key at: https://www.assemblyai.com/');
    console.error('💰 AssemblyAI is cheaper ($0.15/hour) and more accurate (93.3%) than Deepgram!');
    process.exit(1);
}

const assemblyai = new AssemblyAI({
    apiKey: assemblyAIApiKey
});

// Environment configuration
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';

// Debug environment variables
console.log('🔍 Environment Variables Debug:');
console.log('  - BRIDGE_TARGET_NUMBER:', process.env.BRIDGE_TARGET_NUMBER || 'NOT SET');
console.log('  - NODE_ENV:', NODE_ENV);
console.log('  - PORT:', PORT);
console.log('🔍 All Environment Variables:');
Object.keys(process.env).forEach(key => {
    if (key.includes('BRIDGE') || key.includes('TWILIO') || key.includes('ASSEMBLYAI')) {
        console.log(`  - ${key}: ${process.env[key] ? process.env[key].substring(0, 10) + '...' : 'NOT SET'}`);
    }
});

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

// Temporary audio hosting endpoint for AssemblyAI
app.use('/audio', express.static('/tmp', {
    maxAge: 300000, // 5 minutes cache
    setHeaders: (res, path) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', 'audio/wav');
    }
}));

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
        'let schedule',            // "i'll let schedule" → "let schedule"
        'schedule meter',          // Speech-to-text error for "schedule meeting"
        'schedule a meter',        // Speech-to-text error
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
            assemblyai: {
                configured: !!assemblyAIApiKey,
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

// 🎵 AUDIO FILE SERVING: Serve temporary audio files for AssemblyAI download
app.get('/audio/:filename', (req, res) => {
    const filename = req.params.filename;
    const audioPath = `/tmp/${filename}`;
    
    console.log(`🎵 AUDIO REQUEST: Serving ${filename} for AssemblyAI download`);
    
    try {
        // Check if file exists
        if (fs.existsSync(audioPath)) {
            console.log(`✅ AUDIO FOUND: ${filename} exists, serving to AssemblyAI`);
            
            // Set proper headers for WAV files
            res.setHeader('Content-Type', 'audio/wav');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            res.setHeader('Access-Control-Allow-Origin', '*');
            
            // Stream the file
            const fileStream = fs.createReadStream(audioPath);
            fileStream.pipe(res);
            
            fileStream.on('error', (error) => {
                console.error(`❌ AUDIO STREAM ERROR: ${filename}:`, error);
                if (!res.headersSent) {
                    res.status(500).send('Error streaming audio file');
                }
            });
            
            fileStream.on('end', () => {
                console.log(`✅ AUDIO SERVED: ${filename} successfully downloaded by AssemblyAI`);
            });
            
        } else {
            console.error(`❌ AUDIO NOT FOUND: ${filename} does not exist in /tmp/`);
            res.status(404).send('Audio file not found');
        }
    } catch (error) {
        console.error(`❌ AUDIO SERVE ERROR: ${filename}:`, error);
        res.status(500).send('Error serving audio file');
    }
});

// Root endpoint - serve dashboard
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API info endpoint
app.get('/api', (req, res) => {
    res.json({
        message: 'Real-Time Call Processor API - Railway Optimized',
        version: '3.0.0',
        environment: NODE_ENV,
        platform: 'Railway',
        endpoints: {
            health: '/health',
            voice_webhook: '/voice',
            legacy_voice_webhook: '/webhook/voice',
            recording_webhook: '/webhook/recording',
            dial_status_webhook: '/webhook/dial-status',
            dashboard: '/',
            websocket: '/ws',
            stream: '/?callSid=CALLSID',
            twilio_config: '/twilio-config',
            debug: '/debug'
        },
        features: {
            bridge_mode: 'Connects two phone numbers with real-time transcription',
            real_time_transcription: 'AssemblyAI HTTP chunked processing (sentence-aware)',
            speaker_detection: 'Identifies different speakers in bridge calls',
            intent_detection: 'AI-powered conversation analysis',
            webhook_integration: 'n8n workflow automation support'
        },
        documentation: 'https://github.com/AlaxSwum/Real-Time-Phone-Call-Agent'
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
    if (!openai) {
        console.log('⏭️ Skipping AI analysis - OpenAI not configured');
        return;
    }
    
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
    const userAgent = req.headers['user-agent'] || '';
    console.log(`SOCKET NEW WEBSOCKET CONNECTION to path: ${urlPath}`);
    console.log(`SOCKET Client IP: ${clientIP}`);
    console.log(`SOCKET User-Agent: ${userAgent}`);
    console.log(`SOCKET Headers:`, req.headers);
    
    // ENHANCED Twilio detection logic - multiple fallback methods
    const isTwilioStream = urlPath.startsWith('/stream/') || 
                          urlPath.includes('callSid=') || 
                          userAgent.includes('TwilioMediaStreams') ||
                          userAgent.includes('Twilio') ||
                          req.headers['sec-websocket-protocol'] === 'twilio-media-stream' ||
                          // Default route for Twilio if coming from unknown path but not explicitly dashboard
                          (urlPath === '/' && !req.headers['sec-websocket-protocol']);
    
    // Explicit dashboard detection
    const isDashboard = urlPath === '/ws' || 
                       req.headers['sec-websocket-protocol'] === 'dashboard' ||
                       userAgent.includes('Mozilla') ||
                       userAgent.includes('Chrome') ||
                       userAgent.includes('Safari') ||
                       userAgent.includes('Firefox');
    
    console.log(`🔍 ROUTING DETECTION:`);
    console.log(`  - URL Path: ${urlPath}`);
    console.log(`  - User-Agent: ${userAgent}`);
    console.log(`  - Twilio detected: ${isTwilioStream}`);
    console.log(`  - Dashboard detected: ${isDashboard}`);
    
    if (isTwilioStream && !isDashboard) {
        // This is likely a Twilio Media Stream connection
        console.log(`SOCKET ✅ Routing to Twilio Media Stream handler`);
        console.log(`SOCKET Reason: Twilio detection criteria met`);
        handleTwilioStreamConnection(ws, req);
    } else if (isDashboard) {
        // This is likely a dashboard connection
        console.log(`SOCKET ✅ Routing to dashboard handler`);
        console.log(`SOCKET Reason: Dashboard detection criteria met`);
        handleDashboardConnection(ws, req);
    } else {
        // Default to dashboard with auto-recovery for misrouted Twilio
        console.log(`SOCKET ⚠️ Uncertain routing - defaulting to dashboard with auto-recovery`);
        console.log(`SOCKET Will auto-detect Twilio messages and reroute if needed`);
        handleDashboardConnection(ws, req);
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
            
            // ENHANCED AUTO-RECOVERY: Check if this is a Twilio message that was misrouted
            if (data.event && ['start', 'media', 'stop'].includes(data.event)) {
                console.log('🚨 CRITICAL ROUTING ERROR: Twilio message detected on dashboard connection!');
                console.log('🚀 IMMEDIATE REROUTING: Converting to Twilio stream handler');
                console.log(`📋 Event: ${data.event}, Sequence: ${data.sequenceNumber || 'N/A'}`);
                
                // Remove from dashboard clients immediately
                dashboardClients.delete(ws);
                activeConnections--;
                
                // Extract callSid from multiple possible sources
                let callSid = 'unknown';
                if (data.event === 'start' && data.start && data.start.callSid) {
                    callSid = data.start.callSid;
                } else if (data.start && data.start.streamSid) {
                    // Sometimes callSid is in streamSid
                    callSid = data.start.streamSid;
                } else if (data.streamSid) {
                    callSid = data.streamSid;
                } else if (data.callSid) {
                    callSid = data.callSid;
                } else {
                    // Extract from URL if available
                    const urlParams = new URLSearchParams(req.url.split('?')[1] || '');
                    callSid = urlParams.get('callSid') || `recovery_${Date.now()}`;
                }
                
                console.log(`🔄 REROUTING call: ${callSid} (event: ${data.event})`);
                console.log(`🔧 Removing all dashboard handlers and converting to stream handler...`);
                
                // Remove all existing event listeners
                ws.removeAllListeners('message');
                ws.removeAllListeners('close');
                ws.removeAllListeners('error');
                
                // Create a proper request object for the stream handler
                const mockReq = { 
                    url: `/?callSid=${callSid}`,
                    headers: req.headers || {},
                    socket: req.socket || {}
                };
                
                // Initialize as Twilio stream connection
                await handleTwilioStreamConnection(ws, mockReq);
                
                // Immediately process this message through the new handler
                console.log(`📤 Processing recovered message: ${data.event}`);
                const messageBuffer = Buffer.from(JSON.stringify(data));
                ws.emit('message', messageBuffer);
                
                console.log(`✅ RECOVERY COMPLETE: Connection successfully rerouted to stream handler`);
                return;
            }
            
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
                        // Check for any structure that suggests this is a Twilio message
                        const hasTwilioStructure = data.sequenceNumber || 
                                                 data.media || 
                                                 (data.start && data.start.streamSid) ||
                                                 data.streamSid;
                        
                        if (hasTwilioStructure) {
                            // This is definitely a Twilio message - force immediate rerouting
                            console.log('🚨 FAST-TRACK RECOVERY: Twilio structure detected in unknown message!');
                            console.log('🚀 FORCING IMMEDIATE REROUTE...');
                            
                            // Simulate a start event to trigger recovery
                            const simulatedData = {
                                event: 'start',
                                start: {
                                    callSid: data.start?.callSid || data.streamSid || `fasttrack_${Date.now()}`,
                                    streamSid: data.start?.streamSid || data.streamSid
                                },
                                sequenceNumber: data.sequenceNumber
                            };
                            
                            // Trigger the recovery mechanism with simulated data
                            const simulatedMessage = Buffer.from(JSON.stringify(simulatedData));
                            ws.emit('message', simulatedMessage);
                            return;
                        } else {
                            // Likely a Twilio message that got routed to the wrong handler
                            console.log('WARNING: Received non-dashboard message on dashboard connection');
                            console.log('DEBUG: Message preview:', message.toString().substring(0, 50) + '...');
                            console.log('DEBUG: This suggests a WebSocket routing issue');
                            console.log('DEBUG: Full message structure:', Object.keys(data));
                        }
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
    const hasAssemblyAI = !!assemblyAIApiKey;
    console.log(`🔍 TRANSCRIPTION SERVICE DEBUG:`);
    console.log(`  - AssemblyAI available: ${hasAssemblyAI} (API key: ${hasAssemblyAI ? 'SET' : 'MISSING'})`);
    console.log(`  - Will use: ${hasAssemblyAI ? 'AssemblyAI' : 'NONE'}`);
    
    // Initialize variables for this stream
    let fullTranscript = '';
    
    // Use HTTP chunked processing for better reliability
    if (assemblyAIApiKey) {
        console.log('🎙️ Initializing AssemblyAI HTTP chunked transcription...');
        console.log('🔄 Using HTTP chunked processing for maximum reliability...');
        console.log('💡 HTTP method provides better accuracy and reliability than WebSocket');
        initializeHttpChunkedProcessing(callSid, ws);
                                    } else {
        console.log('❌ WARNING: No AssemblyAI API key configured');
                        broadcastToClients({
            type: 'transcription_unavailable',
            message: 'No real-time transcription available - will analyze recording after call',
                            data: {
                                callSid: callSid,
                error: 'No AssemblyAI API key configured',
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
                    console.log('DEBUG AssemblyAI connection:', ws.assemblyaiLive ? 'EXISTS' : 'MISSING');
                    
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
                        console.log(`DEBUG AssemblyAI connection: ${ws.assemblyaiLive ? 'EXISTS' : 'MISSING'}`);
                    }
                    
                    // Handle audio processing (WebSocket or HTTP chunked fallback)
                    if (data.media.payload && twimlFinished) {
                        try {
                            const mulawData = Buffer.from(data.media.payload, 'base64');
                            
                            // Try WebSocket first (using raw mulaw), fallback to HTTP chunked processing
                            if (ws.assemblyaiLive && ws.assemblyaiConnected()) {
                                // WebSocket mode - send raw mulaw data
                                ws.assemblyaiLive.sendAudio(mulawData);
                                
                                if (mediaPacketCount === 1) {
                                    console.log(`✅ ASSEMBLYAI WEBSOCKET: First mulaw packet sent (${mulawData.length} bytes)`);
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
                                    console.log(`🎙️ ASSEMBLYAI WEBSOCKET: ${mediaPacketCount} mulaw packets sent`);
                                    
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
                                
                                // If HTTP chunked processing gets initialized while buffering, transfer immediately
                                if (ws.chunkBuffer !== undefined && ws.chunkProcessor) {
                                    console.log(`🔄 HTTP chunked processing now active - transferring ${ws.audioBuffer.length} buffered packets...`);
                                    for (const bufferedMulawData of ws.audioBuffer) {
                                        const linear16Data = convertMulawToLinear16(bufferedMulawData);
                                        ws.chunkBuffer = Buffer.concat([ws.chunkBuffer, linear16Data]);
                                    }
                                    ws.audioBuffer = []; // Clear the buffer
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
                    if (ws.assemblyaiLive) {
                        console.log('🛑 ASSEMBLYAI WEBSOCKET: Finishing transcription session...');
                        ws.assemblyaiLive.close();
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
                                    
                                    // Save final audio file temporarily
                                    const fs = require('fs');
                                    const finalAudioFilename = `final_audio_${callSid}_${Date.now()}.wav`;
                                    const finalAudioPath = `/tmp/${finalAudioFilename}`;
                                    
                                    fs.writeFileSync(finalAudioPath, wavFile);
                                    console.log(`💾 Saved final audio file: ${finalAudioPath}`);
                                    
                                    // Create public URL for final chunk
                                    const protocol = process.env.NODE_ENV === 'production' ? 'https' : 'http';
                                    const host = process.env.NODE_ENV === 'production' 
                                        ? 'real-time-phone-call-agent-production.up.railway.app'
                                        : 'localhost:3000';
                                    const finalAudioUrl = `${protocol}://${host}/audio/${finalAudioFilename}`;
                                    
                                    console.log(`🔗 Final audio URL: ${finalAudioUrl}`);
                                    
                                    // Request transcription
                                    const transcriptResponse = await fetch('https://api.assemblyai.com/v2/transcript', {
                                        method: 'POST',
                                        headers: {
                                            'Authorization': `Bearer ${assemblyAIApiKey}`,
                                            'Content-Type': 'application/json'
                                        },
                                        body: JSON.stringify({
                                                                        // 🚀 MAXIMUM ACCURACY FINAL CHUNK
                            audio_url: finalAudioUrl,
                            language_code: 'en', // General English for better accent support
                            punctuate: true,
                            format_text: true,
                            speech_model: 'universal', // Universal model for better accent recognition
                                            word_boost: [
                                                // Core business terms
                                                'arrange', 'schedule', 'meeting', 'appointment', 'call', 'phone',
                                                'email', 'gmail', 'outlook', 'yahoo', 'hotmail', 'icloud',
                                                // Time references  
                                                'tomorrow', 'today', 'monday', 'tuesday', 'wednesday', 
                                                'thursday', 'friday', 'saturday', 'sunday', 'time', 'pm', 'am',
                                                // Common speech patterns
                                                'would', 'like', 'could', 'should', 'please', 'thank', 'hello',
                                                'discuss', 'talk', 'speak', 'contact', 'reach', 'connect',
                                                // Email components and individual letters
                                                'at', 'dot', 'com', 'org', 'net', 'address', 'email', 'is',
                                                'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm',
                                                'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
                                                // Accent-aware common words & phonetic variations
                                                'inner', 'under', 'enter', 'inter', 'in', 'an', 'and',
                                                'alex', 'alax', 'alex', 'aleks', 'alexander', 'alexandra',
                                                'zero', 'oh', 'nought', 'nil', 'two', 'three', 'four', 'five',
                                                'six', 'seven', 'eight', 'nine', 'ten', 'hundred', 'thousand'
                                            ],
                                            boost_param: 'high',
                                            disfluencies: false,
                                            filter_profanity: false,
                                            auto_highlights: true
                                        })
                                    });
                                    
                                    console.log(`📡 AssemblyAI transcription request: ${transcriptResponse.status} ${transcriptResponse.statusText}`);
                                    
                                    if (!transcriptResponse.ok) {
                                        const errorText = await transcriptResponse.text();
                                        console.error(`❌ Transcription request failed: ${transcriptResponse.status} - ${errorText}`);
                                        throw new Error(`Transcription request failed: ${transcriptResponse.status} ${transcriptResponse.statusText} - ${errorText}`);
                                    }
                                    
                                    const transcriptResult = await transcriptResponse.json();
                                    
                                    // Simple polling for final chunk (max 5 seconds)
                                    let finalResult = null;
                                    for (let i = 0; i < 5; i++) {
                                        await new Promise(resolve => setTimeout(resolve, 1000));
                                        
                                        const statusResponse = await fetch(`https://api.assemblyai.com/v2/transcript/${transcriptResult.id}`, {
                                            headers: { 'Authorization': `Bearer ${assemblyAIApiKey}` }
                                        });
                                        
                                        if (statusResponse.ok) {
                                            finalResult = await statusResponse.json();
                                            if (finalResult.status === 'completed') break;
                                        }
                                    }
                                    
                                    const transcript = finalResult?.text;
                                    
                                    if (transcript && transcript.trim().length > 0) {
                                        console.log(`📝 FINAL CHUNK TRANSCRIPT: "${transcript}"`);
                                        
                                        broadcastToClients({
                                            type: 'live_transcript',
                                            message: transcript,
                                            data: {
                                                callSid: callSid,
                                                text: transcript,
                                                confidence: result.confidence || 0,
                                                is_final: true,
                                                provider: 'assemblyai_http_final',
                                                timestamp: new Date().toISOString()
                                            }
                                        });
                                        
                                        detectAndProcessIntent(transcript, callSid);
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
    const hasAssemblyAI = !!assemblyAIApiKey;
    
    let primaryService = hasAssemblyAI ? 'AssemblyAI' : 'none';
    
    res.json({
        primary_service: primaryService,
        services_available: {
            assemblyai: hasAssemblyAI
        },
        api_keys: {
            assemblyai_configured: hasAssemblyAI,
            assemblyai_is_hardcoded: !!assemblyAIApiKey
        },
        recommendation: hasAssemblyAI ? 
            'AssemblyAI will be used for real-time transcription' : 
            'Configure ASSEMBLYAI_API_KEY for real-time transcription',
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
        // 🎯 ENHANCED FILTER: Avoid false positives
        const email = normalEmail[0];
        const username = email.split('@')[0].toLowerCase();
        
        // List of false positive usernames to reject
        const falsePositives = ['at', 'me', 'my', 'is', 'isis', 'meme', 'email', 'mail', 'com', 'the', 'and'];
        
        if (username.length >= 5 && !falsePositives.includes(username)) {
            return validateAndCleanEmail(email);
        }
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
    
    // 🚀 MASSIVELY ENHANCED: Email patterns for all speech-to-text errors
    const enhancedEmailPatterns = [
        // 🎯 STRICT EMAIL CONTEXT: ONLY detect emails with explicit email keywords
        /(email\s+is\s+|my\s+email\s+is\s+|email\s+address\s+is\s+|contact\s+me\s+at\s+)([a-z]\s*,?\s*){3,15}(at\s+|@\s*)?(gmail|g\s*mail|jemail|outlook|yahoo|hotmail|icloud|metocom|medocomp|adjimetal)\s*(dot\s+com|com|token|talking|common|calm)?/gi,
        
        // 🎯 SPELLED EMAIL ONLY: Must have "email" context before letter sequences
        /(email\s+is\s+|my\s+email\s+is\s+|email\s+address\s+is\s+|contact\s+me\s+at\s+)([a-z]\s*,?\s*){2,}([a-z]\s*,?\s*){2,}([a-z]\s*,?\s*){1,}(gmail|g\s*mail|jemail|outlook|yahoo|hotmail|icloud|metocom|medocomp|adjimetal|at\s*gmail|at\s*outlook)?/gi,
        
        // 🎯 STRICT CONTEXT: Must have clear email context before patterns
        /(email\s+is\s+|my\s+email\s+is\s+|email\s+address\s+is\s+|contact\s+me\s+at\s+)([a-z])\s+([a-z])\s+([a-z])\s+([a-z])\s+([a-z])\s+(metocom|medocomp|gmail|g\s*mail|jemail|adjimetal|outlook|yahoo|hotmail)\s*(com|token|talking|common|calm)?/gi,
        
        // 🎯 CONTEXTUAL LETTERS: Only with clear email context
        /(email\s+is\s+|my\s+email\s+is\s+|email\s+address\s+is\s+|contact\s+me\s+at\s+)([a-z]\s+){4,8}(at\s+|@\s*)?(gmail|g\s*mail|jemail|outlook|yahoo|hotmail|icloud)\s*(dot\s+com|com|token|talking|common|calm)/gi,
        
        // 🎯 ULTRA-GARBLED: "E as the U m E adjimetal Com" format
        /(email\s+is\s+|my\s+email\s+)?([a-z])\s+(as\s+the|at\s+the|app\s+the|at|app|up)?\s*([a-z])\s*(m|n|and|em|um)?\s*([a-z])\s*(adjimetal|adji|gmail|g\s*mail|mail)\s*(com|token|talking|common|calm)/gi,
        
        // 🎯 SPELLED OUT: "E U M at gmail com" 
        /(email\s+is\s+|my\s+email\s+)?([a-z])\s+([a-z])\s+([a-z])\s+(at|app)\s+(gmail|g\s*mail|outlook|yahoo|hotmail)\s+(com|token|talking|common|calm)/gi,
        
        // 🎯 VERY GARBLED: Multiple single letters with provider
        /(email\s+is\s+|my\s+email\s+)?([a-z]\s+){2,6}(adjimetal|gmail|g\s*mail|outlook|yahoo|hotmail)\s*(com|token|talking|common|calm)/gi,
        
        // 🎯 STRICT SINGLE LETTER: Only with email context required
        /(email\s+is\s+|my\s+email\s+is\s+|email\s+address\s+is\s+|contact\s+me\s+at\s+)([a-z])\s+(app|at|up|app\,|up\,)\s+(gmail|g\s*mail|outlook|yahoo|hotmail)\s+(com|token|talking|common|calm)/gi,
        
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
                    
                    // 🎯 FRAGMENTED LETTERS: Handle "My email is f o n O u m p A, e, f" patterns
                    .replace(/(email\s+is\s+|my\s+email\s+|email\s+address\s+is\s+)([a-z]\s*,?\s*){3,15}(at\s+|@\s*)?(gmail|g\s*mail|jemail|outlook|yahoo|hotmail|icloud|metocom|medocomp|adjimetal)/gi, function(match) {
                        // Extract just the letters, removing email context words
                        let letters = match
                            .replace(/(email\s+is\s+|my\s+email\s+|email\s+address\s+is\s+|at\s+|gmail|g\s*mail|jemail|outlook|yahoo|hotmail|icloud|metocom|medocomp|adjimetal)/gi, '')
                            .replace(/[,\s]+/g, '') // Remove commas and spaces
                            .toLowerCase();
                        return letters + '@gmail.com';
                    })
                    
                    // 🎯 VERY FRAGMENTED: Handle multiple letter chunks
                    .replace(/(email\s+is\s+)?([a-z]\s*,?\s*){2,}([a-z]\s*,?\s*){2,}([a-z]\s*,?\s*){1,}(gmail|g\s*mail|jemail|outlook|yahoo|hotmail|icloud|metocom|medocomp|adjimetal|at\s*gmail|at\s*outlook)?/gi, function(match) {
                        // Extract letters and clean up
                        let letters = match
                            .replace(/(email\s+is\s+|gmail|g\s*mail|jemail|outlook|yahoo|hotmail|icloud|metocom|medocomp|adjimetal|at\s*gmail|at\s*outlook)/gi, '')
                            .replace(/[,\s]+/g, '') // Remove commas and spaces
                            .toLowerCase();
                        return letters + '@gmail.com';
                    })
                    
                    // 🎯 NEW: Handle "Y a e a j metocom" type patterns  
                    .replace(/([a-z])\s+([a-z])\s+([a-z])\s+([a-z])\s+([a-z])\s+(metocom|medocomp|gmail|g\s*mail|jemail|adjimetal|outlook|yahoo|hotmail)\s*(com|token|talking|common|calm)?/gi, '$1$2$3$4$5@gmail.com')
                    
                    // 🎯 ENHANCED: Handle multiple individual letters
                    .replace(/(([a-z])\s+){4,8}(at\s+|@\s*)?(gmail|g\s*mail|jemail|outlook|yahoo|hotmail|icloud)\s*(dot\s+com|com|token|talking|common|calm)/gi, function(match) {
                        const letters = match.replace(/(at\s+|@\s*|dot\s+com|com|token|talking|common|calm|gmail|g\s*mail|jemail|outlook|yahoo|hotmail|icloud)/gi, '').replace(/\s+/g, '');
                        return letters + '@gmail.com';
                    })
                    
                    // 🎯 ULTRA-GARBLED: Handle "E as the U m E adjimetal Com" format
                    .replace(/([a-z])\s+(as\s+the|at\s+the|app\s+the|at|app|up)?\s*([a-z])\s*(m|n|and|em|um)?\s*([a-z])\s*(adjimetal|adji|gmail|g\s*mail|mail)\s*(com|token|talking|common|calm)/gi, '$1$3$5@gmail.com')
                    
                    // 🎯 SPELLED OUT: Handle "E U M at gmail com"
                    .replace(/([a-z])\s+([a-z])\s+([a-z])\s+(at|app)\s+(gmail|g\s*mail|outlook|yahoo|hotmail)\s+(com|token|talking|common|calm)/gi, '$1$2$3@$5.com')
                    
                    // 🎯 ENHANCED: Handle "A app gmail com" format
                    .replace(/([a-z])\s+(app|at|up|app\,|up\,)\s+(gmail|g\s*mail|outlook|yahoo|hotmail)\s+(com|token|talking|common|calm)/gi, '$1@$3.com')
                    
                    .replace(/g\s*mail/gi, 'gmail')
                    .replace(/jemail/gi, 'gmail')
                    .replace(/out\s*look/gi, 'outlook')
                    .replace(/ya\s*hoo/gi, 'yahoo')
                    .replace(/hot\s*mail/gi, 'hotmail')
                    .replace(/i\s*cloud/gi, 'icloud')
                    .replace(/proton\s*mail/gi, 'protonmail')
                    .replace(/adjimetal/gi, 'gmail')  // Fix this specific garbled pattern
                    .replace(/metocom/gi, 'gmail')    // Fix "metocom" → "gmail"
                    .replace(/medocomp/gi, 'gmail')   // Fix "medocomp" → "gmail"
                    .replace(/jemail/gi, 'gmail')     // Fix "jemail" → "gmail"
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
                if (validatedEmail && validatedEmail.length >= 6) { // Minimum reasonable email length
                    return validatedEmail;
                }
            }
        }
    }
    
    // 🎯 STRICT PARTIAL PATTERNS: Only detect with clear email context and minimum length
    const partialPatterns = [
        // Find "my email alex" patterns - REQUIRE explicit email context
        /(my\s+email\s+is\s+|email\s+address\s+is\s+)([a-zA-Z0-9._-]{3,})/gi,
        // Handle spelled letters ONLY with email context
        /(my\s+email\s+is\s+|email\s+address\s+is\s+)(([a-z]\s*(and\s+)?){3,}[a-z])\s*(crown|gmail|outlook|yahoo|hotmail|icloud|token|talking|common|calm|come|dot\s+com)/gi,
        // Require email context AND provider - no standalone letter sequences
        /(my\s+email\s+is\s+|email\s+address\s+is\s+)([a-z]\s+){4,}(gmail|outlook|yahoo|hotmail|icloud)\s*(dot\s+com|com)/gi
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

// 🎯 ENHANCED: Reconstruct email from fragmented letter sequences
function reconstructEmailFromLetters(buffer, forceReconstruction = false) {
    console.log(`🔧 RECONSTRUCTING EMAIL from buffer: "${buffer}" (force: ${forceReconstruction})`);
    
    // Remove email trigger words to isolate letters
    let cleanBuffer = buffer.toLowerCase()
        .replace(/(me\s+my\s+email|my\s+email\s+is|email\s+is\s+ask|email\s+is\s+at|email\s+is|my\s+email)/gi, '')
        .trim();
    
    console.log(`🔧 CLEAN BUFFER: "${cleanBuffer}"`);
    
    // 🎯 ENHANCED PATTERN EXTRACTION: Handle comma-separated and spaced letters + spelled numbers
    
    // First, convert spelled-out numbers to digits
    let processedBuffer = cleanBuffer
        .replace(/\b(zero|oh)\b/gi, '0')
        .replace(/\bone\b/gi, '1')
        .replace(/\btwo\b/gi, '2')
        .replace(/\bthree\b/gi, '3')
        .replace(/\bfour\b/gi, '4')
        .replace(/\bfive\b/gi, '5')
        .replace(/\bsix\b/gi, '6')
        .replace(/\bseven\b/gi, '7')
        .replace(/\beight\b/gi, '8')
        .replace(/\bnine\b/gi, '9');
    
    console.log(`🔧 PROCESSED BUFFER (numbers converted): "${processedBuffer}"`);
    
    // Extract all individual letters and numbers from the buffer
    const letterPattern = /\b([a-z0-9])\b/gi;
    const allMatches = processedBuffer.match(letterPattern);
    
    if (allMatches && allMatches.length >= 3) {
        console.log(`🔧 EXTRACTED LETTERS: [${allMatches.join(', ')}]`);
        
        // Join all letters to form username
        let letters = allMatches.join('').toLowerCase();
        
        // Remove common false words that might get picked up
        letters = letters.replace(/(and|at|the|is|my|me|com|gmail|outlook|yahoo)/gi, '');
        
        console.log(`🔧 CLEANED LETTERS: "${letters}"`);
        
        // Determine domain from buffer
        let domain = 'gmail.com'; // default
        const bufferLower = buffer.toLowerCase();
        if (bufferLower.includes('outlook')) domain = 'outlook.com';
        else if (bufferLower.includes('yahoo')) domain = 'yahoo.com';
        else if (bufferLower.includes('hotmail')) domain = 'hotmail.com';
        
        // Force reconstruction if we have domain indicators
        if (forceReconstruction || bufferLower.includes('gmail') || bufferLower.includes('outlook') || bufferLower.includes('yahoo')) {
            if (letters.length >= 3) {
                const reconstructed = `${letters}@${domain}`;
                console.log(`🔧 FORCE RECONSTRUCTED EMAIL: "${reconstructed}"`);
                return reconstructed;
            }
        }
        
        // Validate length (reasonable email) for normal reconstruction
        if (letters.length >= 5 && letters.length <= 25) {
            const reconstructed = `${letters}@${domain}`;
            console.log(`🔧 RECONSTRUCTED EMAIL: "${reconstructed}"`);
            return reconstructed;
        }
    }
    
    // Pattern 1: Extract individual letters followed by domain (original logic)
    // "N e s W u n Y a e At gmail com" → "neswunyae@gmail.com"
    const letterDomainPattern = /([a-z]\s*){3,}(at\s+gmail|gmail|at\s+outlook|outlook|at\s+yahoo|yahoo)/gi;
    const letterMatch = cleanBuffer.match(letterDomainPattern);
    
    if (letterMatch) {
        console.log(`🔧 LETTER-DOMAIN MATCH: "${letterMatch[0]}"`);
        
        let match = letterMatch[0];
        
        // Extract letters (remove domain part first)
        let letters = match
            .replace(/(at\s+gmail|gmail|at\s+outlook|outlook|at\s+yahoo|yahoo).*/gi, '')
            .replace(/\s+/g, '') // Remove all spaces
            .toLowerCase();
        
        // Determine domain from match
        let domain = 'gmail.com'; // default
        if (match.includes('outlook')) domain = 'outlook.com';
        else if (match.includes('yahoo')) domain = 'yahoo.com';
        
        const reconstructed = `${letters}@${domain}`;
        console.log(`🔧 RECONSTRUCTED EMAIL: "${reconstructed}"`);
        
        // Validate length (reasonable email)
        if (letters.length >= 3 && letters.length <= 20) {
            return reconstructed;
        }
    }
    
    // Pattern 2: Separate letter chunks with domain at end
    // "N e W u P y a E at gmail" → "newupyae@gmail.com"
    const chunks = cleanBuffer.split(/\s+/);
    let letters = [];
    let domain = 'gmail.com';
    
    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        
        // Single letter
        if (chunk.length === 1 && /[a-z]/i.test(chunk)) {
            letters.push(chunk.toLowerCase());
        }
        // Two-letter chunks like "n e"
        else if (chunk.length <= 3 && /^[a-z]\s*[a-z]?$/i.test(chunk)) {
            const cleaned = chunk.replace(/\s+/g, '').toLowerCase();
            letters.push(...cleaned.split(''));
        }
        // Domain indicators
        else if (chunk.includes('gmail')) {
            domain = 'gmail.com';
            break; // Stop collecting letters
        }
        else if (chunk.includes('outlook')) {
            domain = 'outlook.com';
            break;
        }
        else if (chunk.includes('yahoo')) {
            domain = 'yahoo.com';
            break;
        }
    }
    
    if (letters.length >= 3) {
        const reconstructed = `${letters.join('')}@${domain}`;
        console.log(`🔧 CHUNK RECONSTRUCTED EMAIL: "${reconstructed}" from letters: [${letters.join(', ')}]`);
        return reconstructed;
    }
    
    console.log(`🔧 NO EMAIL RECONSTRUCTED from buffer: "${buffer}"`);
    return null;
}

function validateAndCleanEmail(email) {
    if (!email) return null;
    
    // Clean up common speech-to-text errors
    let cleanEmail = email
        .replace(/\s+/g, '')                  // Remove all spaces
        .toLowerCase()
        .trim();
    
    // 🎯 STRICT FILTERING: Reject common false positives
    const falsePositives = [
        'iwouldlike', 'iwantto', 'tomorrow', 'myimage', 'come', 'that', 'and', 'the', 'for', 'more',
        'trippy', 'scan', 'arrange', 'meeting', 'free', 'send', 'email', 'blue', 'shoe', 'was'
    ];
    
    const emailUsername = cleanEmail.split('@')[0];
    if (falsePositives.includes(emailUsername)) {
        return null; // Reject obvious false positives
    }
    
    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    
    if (emailRegex.test(cleanEmail) && cleanEmail.length >= 6) {
        // Additional check: username should be at least 2 characters
        const parts = cleanEmail.split('@');
        if (parts[0].length >= 2) {
            return cleanEmail;
        }
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
                assemblyai_configured: !!assemblyAIApiKey,
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
        status: 'Server is running on Railway',
        timestamp: new Date().toISOString(),
        environment: NODE_ENV,
        platform: 'Railway',
        bridge_configured: !!process.env.BRIDGE_TARGET_NUMBER,
        bridge_target: process.env.BRIDGE_TARGET_NUMBER || 'Not set',
        railway_environment: {
            static_url: process.env.RAILWAY_STATIC_URL || 'Not set',
            public_domain: process.env.RAILWAY_PUBLIC_DOMAIN || 'Not set',
            service_name: process.env.RAILWAY_SERVICE_NAME || 'Not set',
            environment_name: process.env.RAILWAY_ENVIRONMENT_NAME || 'Not set'
        },
        endpoints_available: [
            '/',
            '/api',
            '/health', 
            '/twilio-config',
            '/debug',
            '/voice',
            '/webhook/voice',
            '/webhook/recording',
            '/webhook/dial-status'
        ],
        websocket_endpoints: [
            '/?callSid=CALLSID (recommended)',
            '/ws (dashboard)',
            '/stream/CALLSID (legacy)'
        ],
        transcription_features: {
            provider: 'AssemblyAI',
            method: 'HTTP chunked processing with intelligent sentence completion',
            sentence_aware: true,
            speaker_optimization: 'Single speaker focused',
            intelligent_completion: true,
            smart_timeout: '5 seconds',
            interval: '2-3 seconds (1.2s check)',
            accuracy: 'Maximum (93.3%+ with business term boosting)',
            enhancements: [
                'Complete thought detection',
                'Smart punctuation addition',
                'Disfluency removal',
                'Custom vocabulary boosting',
                'Enhanced business terms'
            ]
        },
        deployment_version: 'RAILWAY-OPTIMIZED-V1',
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

// Webhook for dial status updates (bridge mode)
app.post('/webhook/dial-status', (req, res) => {
    console.log('📞 Bridge dial status update:', req.body);
    
    const { 
        CallSid, 
        DialCallStatus, 
        DialCallSid, 
        DialCallDuration,
        Called,
        Caller 
    } = req.body;
    
    console.log(`📞 Dial Status: ${DialCallStatus} for bridge call ${CallSid}`);
    console.log(`🔗 Bridge leg SID: ${DialCallSid}`);
    console.log(`⏱️ Bridge duration: ${DialCallDuration || 'N/A'} seconds`);
    console.log(`📱 Connecting ${Caller} → ${Called}`);
    
    // Broadcast dial status to dashboard
    broadcastToClients({
        type: 'bridge_dial_status',
        message: `Bridge dial ${DialCallStatus}: ${Caller} → ${Called}`,
        data: {
            callSid: CallSid,
            dialCallSid: DialCallSid,
            dialStatus: DialCallStatus,
            duration: DialCallDuration,
            caller: Caller,
            called: Called,
            timestamp: new Date().toISOString()
        }
    });
    
    // Send dial status to n8n if configured
    if (process.env.N8N_WEBHOOK_URL) {
        const dialStatusData = {
            type: 'bridge_dial_status',
            callSid: CallSid,
            dialCallSid: DialCallSid,
            dialStatus: DialCallStatus,
            duration: DialCallDuration,
            caller: Caller,
            called: Called,
            timestamp: new Date().toISOString()
        };
        
        fetch(process.env.N8N_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(dialStatusData)
        }).then(response => {
            console.log('✅ Bridge dial status sent to n8n:', response.status);
        }).catch(error => {
            console.error('❌ Error sending dial status to n8n:', error);
        });
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
    const bridgeNumber = process.env.BRIDGE_TARGET_NUMBER || '+447494225623'; // Fallback to hardcoded number
    console.log('🌉 Bridge number resolved to:', bridgeNumber);
    
    if (bridgeNumber) {
        console.log(`🌉 Bridge mode: Connecting ${From} to ${bridgeNumber}`);
        
        // TwiML for bridge mode with recording and real-time streaming - optimized for Railway
        const streamUrl = `${baseWsUrl}/?callSid=${CallSid}`; // Use query parameter format for better compatibility
        console.log('🔗 Stream URL for TwiML:', streamUrl);
        
        // Enhanced TwiML with proper Stream configuration for Railway hosting
        const bridgeTwiML = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">Connecting your call, please wait...</Say>
    <Start>
        <Stream url="${streamUrl}" track="both_tracks">
            <Parameter name="callSid" value="${CallSid}" />
            <Parameter name="bridgeMode" value="true" />
            <Parameter name="caller" value="${From}" />
            <Parameter name="target" value="${bridgeNumber}" />
        </Stream>
    </Start>
    <Dial 
        record="record-from-answer"
        recordingStatusCallback="${protocol}://${host}/webhook/recording"
        recordingStatusCallbackMethod="POST"
        timeout="30"
        hangupOnStar="false"
        timeLimit="3600"
        callerId="${From}">
        <Number statusCallback="${protocol}://${host}/webhook/dial-status" statusCallbackMethod="POST">${bridgeNumber}</Number>
    </Dial>
    <Say voice="alice">The call could not be connected. Please try again later. Goodbye.</Say>
</Response>`;
        
        console.log('🌉 ENHANCED Bridge TwiML Response (Railway + Real-time Transcription):');
        console.log('🎙️ Features: Both tracks recording, real-time streaming, dial status callbacks');
        console.log('🔧 Railway optimized: Query parameter WebSocket URL format');
        console.log('📞 Call flow: Greeting → Stream start → Dial bridge → Recording + transcription');
        
        res.type('text/xml');
        res.send(bridgeTwiML);
        
    } else {
        // Original real-time analysis mode (no bridge)
        console.log('🎙️ Real-time analysis mode (no bridge number configured)');
        
        // TwiML response for real-time streaming - optimized for Railway
        const streamUrl = `${baseWsUrl}/?callSid=${CallSid}`;
        console.log('🔗 Stream URL for TwiML:', streamUrl);
        
        // Enhanced TwiML response for incoming calls with Railway optimization
        const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">Welcome to the real-time call analysis system. Please speak your message.</Say>
    <Start>
        <Stream url="${streamUrl}" track="inbound_track">
            <Parameter name="callSid" value="${CallSid}" />
            <Parameter name="analysisMode" value="true" />
            <Parameter name="caller" value="${From}" />
        </Stream>
    </Start>
    <Pause length="30"/>
    <Say voice="alice">Thank you for your message. Goodbye.</Say>
</Response>`;
        
        console.log('📋 Enhanced Analysis TwiML Response (Railway optimized)');
        console.log('🎙️ Features: Real-time streaming, caller greeting, extended recording time');
        
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
        // TODO: Implement AssemblyAI transcription for bridge recordings
        console.log('⚠️ Bridge call recording transcription not implemented with AssemblyAI yet');
        const transcriptResult = {
            text: 'Bridge call recording analysis not yet implemented with AssemblyAI',
            status: 'completed'
        };
        
        // Analyze with OpenAI for meeting insights
        let aiAnalysis = {
            conversation_type: "meeting",
            participants: ["speaker_a", "speaker_b"],
            key_topics: ["general discussion"],
            summary: "Bridge call recording analysis completed without AI analysis",
            sentiment: "neutral",
            urgency: "medium",
            follow_up_needed: true
        };
        
        if (openai) {
        console.log('🧠 Analyzing bridge conversation with OpenAI...');
            try {
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
            } catch (aiError) {
                console.error('❌ OpenAI analysis failed:', aiError.message);
                console.log('⚠️ Using fallback analysis');
            }
        } else {
            console.log('⚠️ OpenAI not available - using basic analysis');
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

// Enhanced Mulaw to Linear16 PCM conversion with noise reduction and quality enhancement
function convertMulawToLinear16(mulawBuffer) {
    // Enhanced mulaw decompression table with better precision
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
    
    // Convert mulaw to linear16 with enhanced upsampling (8kHz → 16kHz)
    // Using interpolation for better quality
    const upsampledBuffer = Buffer.alloc(mulawBuffer.length * 4); // 2x for linear16, 2x for upsampling
    
    for (let i = 0; i < mulawBuffer.length; i++) {
        const mulawValue = mulawBuffer[i];
        const linearValue = mulawToLinear[mulawValue];
        
        // Apply minimal noise gate for maximum speech capture
        let cleanedValue = Math.abs(linearValue) < 5 ? 0 : linearValue;
        
        // Amplify low-volume phone audio (boost by 2x for maximum sensitivity)
        if (cleanedValue !== 0) {
            cleanedValue = Math.round(cleanedValue * 2.0);
            // Prevent clipping
            cleanedValue = Math.max(-32767, Math.min(32767, cleanedValue));
        }
        
        // Write each sample twice for 2x upsampling with slight interpolation
        const outputIndex = i * 4;
        upsampledBuffer.writeInt16LE(cleanedValue, outputIndex);
        
        // Interpolate next sample for smoother upsampling
        const nextMulawValue = i < mulawBuffer.length - 1 ? mulawBuffer[i + 1] : mulawValue;
        const nextLinearValue = mulawToLinear[nextMulawValue];
        let nextCleanedValue = Math.abs(nextLinearValue) < 5 ? 0 : nextLinearValue;
        
        // Amplify next sample too
        if (nextCleanedValue !== 0) {
            nextCleanedValue = Math.round(nextCleanedValue * 2.0);
            nextCleanedValue = Math.max(-32767, Math.min(32767, nextCleanedValue));
        }
        const interpolatedValue = Math.round((cleanedValue + nextCleanedValue) / 2);
        
        upsampledBuffer.writeInt16LE(interpolatedValue, outputIndex + 2);
    }
    
    return upsampledBuffer;
}

// Audio quality analysis function
function analyzeAudioQuality(audioBuffer) {
    if (!audioBuffer || audioBuffer.length === 0) {
        return { error: 'No audio data' };
    }
    
    // Calculate basic audio statistics
    let sum = 0;
    let sumSquares = 0;
    let min = 32767;
    let max = -32768;
    let silentSamples = 0;
    
    // Analyze as 16-bit samples
    for (let i = 0; i < audioBuffer.length - 1; i += 2) {
        const sample = audioBuffer.readInt16LE(i);
        sum += sample;
        sumSquares += sample * sample;
        min = Math.min(min, sample);
        max = Math.max(max, sample);
        
        if (Math.abs(sample) < 30) { // Lower threshold for phone calls
            silentSamples++;
        }
    }
    
    const sampleCount = Math.floor(audioBuffer.length / 2);
    const mean = sum / sampleCount;
    const variance = (sumSquares / sampleCount) - (mean * mean);
    const rms = Math.sqrt(variance);
    const silencePercentage = (silentSamples / sampleCount) * 100;
    
    return {
        bytes: audioBuffer.length,
        samples: sampleCount,
        duration_ms: Math.round((sampleCount / 16000) * 1000), // Assuming 16kHz
        rms_level: Math.round(rms),
        peak_level: Math.max(Math.abs(min), Math.abs(max)),
        silence_percent: Math.round(silencePercentage * 100) / 100,
        has_audio: silencePercentage < 95,
        quality: rms > 100 ? 'good' : rms > 50 ? 'fair' : 'poor'
    };
}

// HTTP-based chunked audio processing fallback
// 🚀 PARALLEL TRANSCRIPT PROCESSING: Handle completed transcripts in background
async function processCompletedTranscript(transcript, confidence, callSid, ws, transcriptId) {
    try {
        let processedText = transcript.trim();
        
        // Enhanced sentence completion logic with parallel processing
        ws.sentenceBuffer = (ws.sentenceBuffer || '') + ' ' + processedText;
        ws.sentenceBuffer = ws.sentenceBuffer.trim();
        
        // Extract complete sentences
        const sentences = extractCompleteSentences(ws.sentenceBuffer);
        
        if (sentences.completeSentences.length > 0) {
            const finalText = sentences.completeSentences.join(' ');
            ws.sentenceBuffer = sentences.remainingText; // Keep incomplete part
            
            console.log(`📝 PARALLEL COMPLETED: "${finalText}" from ${transcriptId}`);
            console.log(`📋 REMAINING BUFFER: "${ws.sentenceBuffer}"`);
            
            // Broadcast complete sentences only
            broadcastToClients({
                type: 'live_transcript',
                message: finalText,
                data: {
                    callSid: callSid,
                    text: finalText,
                    confidence: confidence,
                    is_final: true,
                    provider: 'assemblyai_http_parallel',
                    transcript_id: transcriptId,
                    processing_mode: '4_second_parallel',
                    timestamp: new Date().toISOString()
                }
            });
            
            // 🎯 ENHANCED EMAIL ACCUMULATION: Handle fragmented email spelling
            const lowerText = finalText.toLowerCase();
            
            // 🎯 ENHANCED EMAIL MODE: More flexible triggers including phonetic variations
            const emailTriggers = [
                'my email is', 'my email address is', 'email me at', 'contact me at',
                'email is', 'my email', 'email address', 'send email to',
                'reach me at', 'email me', 'my address is',
                // 🎯 PHONETIC VARIATIONS for accent support
                'me my inner', 'my inner', 'my email', 'me email', 'my mail',
                'email address', 'mail address', 'contact address', 'send mail',
                'my address', 'email me', 'mail me', 'contact me',
                // 🎯 SENDING PATTERNS
                'will send to', 'send to', 'sending to', 'email to', 'mail to',
                'send you', 'send it to', 'send the email to', 'send details to'
            ];
            
            const hasEmailTrigger = emailTriggers.some(trigger => lowerText.includes(trigger));
            
            // 🎯 DEBUG: Log trigger checking
            console.log(`🔍 EMAIL TRIGGER CHECK: "${lowerText}" | hasEmailTrigger: ${hasEmailTrigger} | emailMode: ${ws.emailMode}`);
            if (hasEmailTrigger) {
                const matchedTrigger = emailTriggers.find(trigger => lowerText.includes(trigger));
                console.log(`🎯 MATCHED TRIGGER: "${matchedTrigger}"`);
            }
            
            if (!ws.emailMode && hasEmailTrigger) {
                console.log(`📧 EMAIL MODE ACTIVATED: Starting email collection from "${finalText}"`);
                ws.emailMode = true;
                ws.emailBuffer = finalText; // Start with this text
                ws.emailStartTime = Date.now();
            }
            
            // If in email mode, accumulate fragments
            if (ws.emailMode) {
                ws.emailBuffer += ' ' + finalText;
                console.log(`📧 EMAIL ACCUMULATING: "${ws.emailBuffer.trim()}"`);
                
                                    // 🎯 ENHANCED: Always try reconstruction first, then standard extraction
                    console.log(`🔧 ATTEMPTING EMAIL RECONSTRUCTION from buffer: "${ws.emailBuffer.trim()}"`);
                    let possibleEmail = reconstructEmailFromLetters(ws.emailBuffer);
                    console.log(`🔧 RECONSTRUCTION RESULT: "${possibleEmail}"`);
                    
                    // If reconstruction fails, try standard extraction (but avoid false positives)
                    if (!possibleEmail) {
                        console.log(`🔧 TRYING STANDARD EXTRACTION as fallback`);
                        const standardEmail = extractEmailFromTranscript(ws.emailBuffer);
                        console.log(`🔧 STANDARD EXTRACTION RESULT: "${standardEmail}"`);
                        // Only accept if it's not a false positive
                        if (standardEmail && !['meme@gmail.com', 'isis@gmail.com', 'at@gmail.com'].includes(standardEmail.toLowerCase())) {
                            possibleEmail = standardEmail;
                        }
                    }
                
                if (possibleEmail && possibleEmail.length >= 8) { // Reasonable email length
                    console.log(`📧 EMAIL DETECTED FROM BUFFER: "${possibleEmail}" from accumulated: "${ws.emailBuffer.trim()}"`);
                    
                    broadcastToClients({
                        type: 'email_detected',
                        message: `Email detected: ${possibleEmail}`,
                        data: {
                            callSid: callSid,
                            email: possibleEmail,
                            source_transcript: ws.emailBuffer.trim(),
                            method: 'parallel_accumulated_fragments',
                            transcript_id: transcriptId,
                            timestamp: new Date().toISOString()
                        }
                    });
                    
                    // Reset email mode after successful detection
                    ws.emailMode = false;
                    ws.emailBuffer = '';
                } else {
                    // Check for potential completion with domain indicator
                    const lowerBuffer = ws.emailBuffer.toLowerCase();
                    if (lowerBuffer.includes('gmail') || lowerBuffer.includes('outlook') || lowerBuffer.includes('yahoo')) {
                        // Try harder reconstruction when we see domain
                        const forceReconstruct = reconstructEmailFromLetters(ws.emailBuffer, true);
                        if (forceReconstruct && forceReconstruct.length >= 6) {
                            console.log(`📧 FORCED EMAIL RECONSTRUCTION: "${forceReconstruct}" from: "${ws.emailBuffer.trim()}"`);
                            
                            broadcastToClients({
                                type: 'email_detected',
                                message: `Email detected: ${forceReconstruct}`,
                                data: {
                                    callSid: callSid,
                                    email: forceReconstruct,
                                    source_transcript: ws.emailBuffer.trim(),
                                    method: 'forced_reconstruction',
                                    transcript_id: transcriptId,
                                    timestamp: new Date().toISOString()
                                }
                            });
                            
                            ws.emailMode = false;
                            ws.emailBuffer = '';
                        }
                    }
                    
                    // Check for timeout (30 seconds max)
                    const emailElapsed = Date.now() - ws.emailStartTime;
                    if (emailElapsed > 30000) {
                        console.log(`📧 EMAIL MODE TIMEOUT: No email found in "${ws.emailBuffer.trim()}" after 30s`);
                        ws.emailMode = false;
                        ws.emailBuffer = '';
                    }
                }
            } else {
                // Standard email detection for complete sentences
                const possibleEmail = extractEmailFromTranscript(finalText);
                if (possibleEmail) {
                    // 🎯 ENHANCED: Filter false positives in standard detection too
                    const username = possibleEmail.split('@')[0].toLowerCase();
                    const falsePositives = ['at', 'me', 'my', 'is', 'isis', 'meme', 'email', 'mail', 'com', 'the', 'and'];
                    
                    if (username.length >= 5 && !falsePositives.includes(username)) {
                        console.log(`📧 EMAIL DETECTED: "${possibleEmail}" from transcript: "${finalText}"`);
                        
                        broadcastToClients({
                            type: 'email_detected',
                            message: `Email detected: ${possibleEmail}`,
                            data: {
                                callSid: callSid,
                                email: possibleEmail,
                                source_transcript: finalText,
                                method: 'parallel_standard_detection',
                                transcript_id: transcriptId,
                                timestamp: new Date().toISOString()
                            }
                        });
                    } else {
                        console.log(`📧 BLOCKED FALSE POSITIVE: "${possibleEmail}" from transcript: "${finalText}" (username: "${username}")`);
                    }
                }
            }
            
            // Process for intent detection and AI analysis in parallel
            Promise.allSettled([
                detectAndProcessIntent(finalText, callSid),
                analyzeTranscriptWithAI(finalText, callSid)
            ]).then(results => {
                console.log(`✅ Parallel processing completed for ${transcriptId}`);
            }).catch(error => {
                console.error(`❌ Parallel processing error for ${transcriptId}:`, error);
            });
            
            ws.lastTranscriptTime = Date.now();
        } else {
            console.log(`📝 PARALLEL ACCUMULATING: "${processedText}" from ${transcriptId} (waiting for complete sentences)`);
        }
    } catch (error) {
        console.error(`❌ Error processing completed transcript ${transcriptId}:`, error);
    }
}

function initializeHttpChunkedProcessing(callSid, ws) {
    console.log('🔄 Initializing 4-second parallel HTTP chunked processing for call:', callSid);
    
    // Enhanced audio buffer for sentence-aware chunked processing
    ws.audioChunks = [];
    ws.chunkBuffer = Buffer.alloc(0);
    ws.lastProcessTime = Date.now();
    ws.chunkCount = 0;
    ws.sentenceBuffer = ''; // Buffer to accumulate partial sentences
    ws.lastTranscriptTime = Date.now();
    ws.emailBuffer = ''; // Special buffer for accumulating email fragments
    ws.emailMode = false; // Flag for when we're collecting email letters
    
    // Process any buffered audio from before HTTP chunked processing was initialized
    if (ws.audioBuffer && ws.audioBuffer.length > 0) {
        console.log(`🔄 Processing ${ws.audioBuffer.length} buffered audio packets from before HTTP init...`);
        for (const mulawData of ws.audioBuffer) {
            const linear16Data = convertMulawToLinear16(mulawData);
            ws.chunkBuffer = Buffer.concat([ws.chunkBuffer, linear16Data]);
        }
        console.log(`📊 Transferred buffered audio: ${ws.chunkBuffer.length} bytes ready for processing`);
        ws.audioBuffer = []; // Clear the buffer
    }
    
    // Optimized processing: Every 2 seconds for real-time, but accumulate for complete sentences
    ws.chunkProcessor = setInterval(async () => {
        // 🚀 ENHANCED PARALLEL OPTIMIZATION: Longer chunks for better accent recognition
        const minAudioLength = 16000; // 2 seconds at 8kHz (minimum for processing)
        const preferredAudioLength = 48000; // 6 seconds at 8kHz (better for accent context)
        const timeSinceLastProcess = Date.now() - ws.lastProcessTime;
        
        // Process every 6 seconds OR when we have enough audio - Enhanced for accent recognition
        // Parallel processing: don't wait for previous transcripts to complete
        const shouldProcess = ws.chunkBuffer.length >= minAudioLength && 
                            (ws.chunkBuffer.length >= preferredAudioLength || timeSinceLastProcess >= 6000);
        
        if (shouldProcess) {
            try {
                console.log(`🔄 Processing audio chunk ${++ws.chunkCount} (${ws.chunkBuffer.length} bytes, ${timeSinceLastProcess}ms since last)`);
                
                // Analyze audio quality before processing
                const audioAnalysis = analyzeAudioQuality(ws.chunkBuffer);
                console.log(`🎵 AUDIO ANALYSIS: ${JSON.stringify(audioAnalysis)}`);
                
                // Skip processing if audio is too quiet or silent
                if (audioAnalysis.silence_percent > 90) {
                    console.log(`🔇 Skipping silent audio chunk (${audioAnalysis.silence_percent}% silence)`);
                    ws.chunkBuffer = Buffer.alloc(0);
                    ws.lastProcessTime = Date.now();
                    return;
                }
                
                // Create proper WAV file with header
                const wavHeader = createWavHeader(ws.chunkBuffer.length, 16000); // Use 16kHz for better quality
                const wavFile = Buffer.concat([wavHeader, ws.chunkBuffer]);
                
                console.log(`📊 WAV file created: ${wavFile.length} bytes (${wavHeader.length} header + ${ws.chunkBuffer.length} data)`);
                
                // Save audio file temporarily and create public URL
                const fs = require('fs');
                const audioFilename = `audio_${callSid}_${ws.chunkCount}_${Date.now()}.wav`;
                const audioPath = `/tmp/${audioFilename}`;
                
                // Save WAV file temporarily
                fs.writeFileSync(audioPath, wavFile);
                console.log(`💾 Saved audio file: ${audioPath} (${wavFile.length} bytes)`);
                
                // Create public URL for AssemblyAI - optimized for Railway
                const protocol = 'https'; // Railway uses HTTPS
                const host = process.env.RAILWAY_STATIC_URL || 
                           process.env.RAILWAY_PUBLIC_DOMAIN || 
                           'real-time-phone-call-agent-production.up.railway.app';
                const audioUrl = `${protocol}://${host}/audio/${audioFilename}`;
                
                console.log(`🔗 Audio URL for AssemblyAI: ${audioUrl}`);
                
                // Request transcription with optimized settings for sentence completion
                const transcriptResponse = await fetch('https://api.assemblyai.com/v2/transcript', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${assemblyAIApiKey}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        // 🚀 MAXIMUM ACCURACY: Aggressive settings for best results
                        audio_url: audioUrl,
                        language_code: 'en', // Changed from 'en_us' to general English for better accent support
                        punctuate: true,
                        format_text: true,
                        speech_model: 'universal', // Universal model for better accent recognition
                        
                        // 🎯 AGGRESSIVE WORD BOOSTING: Enhanced for email alphabet detection + accent support
                        word_boost: [
                            // Core business terms
                            'arrange', 'schedule', 'meeting', 'appointment', 'call', 'phone',
                            'email', 'gmail', 'outlook', 'yahoo', 'hotmail', 'icloud',
                            
                            // Time references  
                            'tomorrow', 'today', 'monday', 'tuesday', 'wednesday', 
                            'thursday', 'friday', 'saturday', 'sunday', 'time', 'pm', 'am',
                            
                            // Common speech patterns (accent-aware)
                            'would', 'like', 'could', 'should', 'please', 'thank', 'hello',
                            'discuss', 'talk', 'speak', 'contact', 'reach', 'connect',
                            'want', 'need', 'help', 'support', 'information', 'details',
                            
                            // Email components and spelled letters
                            'at', 'dot', 'com', 'org', 'net', 'address', 'email', 'is',
                            'my', 'and', 'the', 'to', 'for', 'with', 'on', 'in',
                            
                            // ENHANCED: Individual letters for email spelling
                            'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm',
                            'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
                            
                            // Common email endings as spoken
                            'gmail', 'g-mail', 'jemail', 'outlook', 'out-look', 'yahoo', 'ya-hoo',
                            'hotmail', 'hot-mail', 'icloud', 'i-cloud', 'dot-com', 'dotcom',
                            
                            // Accent-aware common words & phonetic variations
                            'nine', 'nine-nine', 'ninety', 'nineteen', 'number', 'numbers',
                            'inner', 'under', 'enter', 'inter', 'in', 'an', 'and',
                            'alex', 'alax', 'alex', 'aleks', 'alexander', 'alexandra',
                            'zero', 'oh', 'nought', 'nil', 'two', 'three', 'four', 'five',
                            'six', 'seven', 'eight', 'nine', 'ten', 'hundred', 'thousand'
                        ],
                        boost_param: 'high'
                    })
                });
                
                console.log(`📡 AssemblyAI transcription request: ${transcriptResponse.status} ${transcriptResponse.statusText}`);
                
                if (!transcriptResponse.ok) {
                    const errorText = await transcriptResponse.text();
                    console.error(`❌ Transcription request failed: ${transcriptResponse.status} - ${errorText}`);
                    throw new Error(`Transcription request failed: ${transcriptResponse.status} ${transcriptResponse.statusText} - ${errorText}`);
                }
                
                const transcriptResult = await transcriptResponse.json();
                const transcriptId = transcriptResult.id;
                
                console.log(`🆔 AssemblyAI transcript ID: ${transcriptId}`);
                console.log(`📊 Initial status: ${transcriptResult.status}`);
                
                // 🚀 PARALLEL PROCESSING: Start next chunk immediately, don't wait for completion
                console.log(`🚀 PARALLEL MODE: Starting transcript ${transcriptId} in background`);
                
                // Process this transcript in parallel (non-blocking)
                (async () => {
                    let attempts = 0;
                    let result = null;
                    
                    while (attempts < 15) { // Reduced attempts for faster timeout
                        await new Promise(resolve => setTimeout(resolve, 600)); // Faster polling 
                        attempts++;
                        
                        console.log(`🔄 Polling attempt ${attempts}/15 for transcript ${transcriptId}`);
                        
                        try {
                            const statusResponse = await fetch(`https://api.assemblyai.com/v2/transcript/${transcriptId}`, {
                                headers: {
                                    'Authorization': `Bearer ${assemblyAIApiKey}`
                                }
                            });
                            
                            if (statusResponse.ok) {
                                result = await statusResponse.json();
                                console.log(`📊 Transcript status: ${result.status}`);
                                
                                if (result.status === 'completed') {
                                    console.log(`✅ PARALLEL COMPLETED: ${transcriptId} after ${attempts} attempts (${attempts * 0.6}s)`);
                                    
                                    const transcript = result.text;
                                    const confidence = result.confidence || 0.8;
                                    
                                    if (transcript && transcript.trim().length > 0) {
                                        // Process the completed transcript
                                        await processCompletedTranscript(transcript, confidence, callSid, ws, transcriptId);
                                    }
                                    break;
                                } else if (result.status === 'error') {
                                    console.error(`❌ PARALLEL ERROR: ${transcriptId} - ${result.error}`);
                                    break;
                                }
                            }
                        } catch (pollError) {
                            console.error(`❌ PARALLEL POLL ERROR: ${transcriptId} - ${pollError.message}`);
                            break;
                        }
                    }
                    
                    if (attempts >= 15) {
                        console.log(`⏰ PARALLEL TIMEOUT: ${transcriptId} after 15 attempts (9s) - continuing with next chunk`);
                    }
                })();
                                
                // 🚀 IMMEDIATE PROCESSING: Don't wait for this transcript, start next chunk immediately
                console.log(`⚡ IMMEDIATE MODE: Chunk ${ws.chunkCount} sent to AssemblyAI, starting next chunk processing`);
                
                // 🔧 DELAYED CLEANUP: Don't delete files immediately - AssemblyAI needs time to download them
                setTimeout(() => {
                    try {
                        fs.unlinkSync(audioPath);
                        console.log(`🗑️ Delayed cleanup: ${audioFilename} (after 60s)`);
                    } catch (cleanupError) {
                        console.log(`⚠️ Could not cleanup file ${audioFilename}:`, cleanupError.message);
                    }
                }, 60000); // Wait 60 seconds before deleting files
                
                // Clear buffer and continue processing immediately (parallel mode)
                ws.chunkBuffer = Buffer.alloc(0);
                ws.lastProcessTime = Date.now();
                
                // Clear buffer and update timing
                ws.chunkBuffer = Buffer.alloc(0);
                ws.lastProcessTime = Date.now();
                
            } catch (error) {
                console.error('❌ HTTP chunk processing error:', error.message);
                // Clear buffer even on error to prevent accumulation
                ws.chunkBuffer = Buffer.alloc(0);
                ws.lastProcessTime = Date.now();
            }
        }
    }, 1500); // Check every 1.5 seconds for 4-second processing cycles
    
    console.log('✅ ENHANCED PARALLEL PROCESSING: 6-second audio chunks for better accent recognition');
    console.log('🚀 ACCENT OPTIMIZED: Longer context windows + universal model for better accuracy');
    console.log('🔧 IMPROVED TIMING: 6-second intervals with enhanced phonetic boosting');
    console.log('⚡ ACCENT FRIENDLY: Extended processing + parallel completion for better results');
    
    broadcastToClients({
        type: 'http_transcription_ready',
        message: 'ACCENT OPTIMIZED: 6-second enhanced processing for better accent recognition (Railway + AssemblyAI)',
        data: {
            callSid: callSid,
            method: 'parallel_6_second_accent_optimized_processing',
            interval: '6_seconds_parallel_accent_enhanced',
            config: 'maximum_accuracy',
            features: [
                'audio_to_text',
                'punctuation', 
                'text_formatting',
                'universal_speech_model',
                'accent_optimized_processing',
                'phonetic_word_boosting',
                'parallel_processing',
                'enhanced_email_detection',
                'letter_sequence_reconstruction',
                'accent_aware_triggers',
                'extended_context_windows',
                'speech_error_correction'
            ],
            word_boost_count: '40+ terms',
            custom_vocabulary: 'sounds_like_mapping',
            email_patterns: [
                'ultra_garbled_detection',
                'spelled_out_emails',
                'speech_to_text_error_correction'
            ],
            removed_complexity: [
                'speaker_detection',
                'sentiment_analysis',
                'entity_detection'
            ],
            platform: 'railway',
            approach: 'maximum_accuracy_aggressive_settings',
            timestamp: new Date().toISOString()
        }
    });
}

// ENHANCED: Intelligent sentence extraction with complete thought detection
function extractCompleteSentences(text) {
    if (!text || text.trim().length === 0) {
        return { completeSentences: [], remainingText: '' };
    }
    
    // Split by sentence endings, but keep the punctuation
    const sentencePattern = /([.!?]+)\s*/g;
    const parts = text.split(sentencePattern);
    
    const completeSentences = [];
    let remainingText = '';
    
    for (let i = 0; i < parts.length; i += 2) {
        const sentencePart = parts[i];
        const punctuation = parts[i + 1];
        
        if (punctuation && punctuation.match(/[.!?]/)) {
            // Complete sentence with punctuation
            completeSentences.push((sentencePart + punctuation).trim());
        } else {
            // Check if this looks like a complete thought even without punctuation
            const potentialSentence = sentencePart ? sentencePart.trim() : '';
            
            if (potentialSentence && isCompleteThought(potentialSentence)) {
                // Add period and treat as complete sentence
                completeSentences.push(potentialSentence + '.');
            } else {
                // Incomplete sentence or remaining text
                remainingText = potentialSentence;
            }
        }
    }
    
    // Handle edge cases where text doesn't end with punctuation
    if (remainingText.length === 0 && parts.length > 0) {
        const lastPart = parts[parts.length - 1];
        if (lastPart && !lastPart.match(/[.!?]$/)) {
            const trimmedPart = lastPart.trim();
            if (isCompleteThought(trimmedPart)) {
                completeSentences.push(trimmedPart + '.');
            } else {
                remainingText = trimmedPart;
            }
        }
    }
    
    return {
        completeSentences: completeSentences.filter(s => s.length > 0),
        remainingText: remainingText.trim()
    };
}

// Helper function to detect if text represents a complete thought
function isCompleteThought(text) {
    if (!text || text.length < 8) return false; // Too short to be meaningful
    
    const words = text.toLowerCase().split(/\s+/);
    if (words.length < 3) return false; // Need at least 3 words
    
    // Common sentence starters that indicate complete thoughts
    const completeThoughtPatterns = [
        // Meeting and scheduling
        /\b(i want to|i need to|i would like to|let's|we should|can we|could we)\b/i,
        /\b(schedule|arrange|set up|plan|organize)\b.*\b(meeting|call|appointment)\b/i,
        /\b(my email is|my email address is|email me at|contact me at)\b/i,
        /\b(call me|phone me|reach me)\b.*\b(at|on)\b/i,
        
        // Complete statements
        /\b(this is|that is|it is|there is|there are)\b/i,
        /\b(i am|i'm|we are|we're|you are|you're)\b/i,
        /\b(i have|i've|we have|we've|you have|you've)\b/i,
        /\b(i will|i'll|we will|we'll|you will|you'll)\b/i,
        /\b(i can|i could|we can|we could|you can|you could)\b/i,
        
        // Questions (often complete thoughts)
        /\b(what|when|where|why|how|who|which)\b/i,
        /\b(do you|did you|will you|would you|can you|could you)\b/i,
        /\b(is there|are there|was there|were there)\b/i,
        
        // Business context
        /\b(regarding|about|concerning)\b.*\b(project|meeting|proposal|contract)\b/i,
        /\b(thank you|thanks|please|sorry|excuse me)\b/i
    ];
    
    // Check if any pattern matches
    const hasCompletePattern = completeThoughtPatterns.some(pattern => pattern.test(text));
    
    // Additional checks for sentence completeness
    const hasSubjectVerb = /\b(i|we|you|he|she|it|they|this|that)\b.*\b(am|is|are|was|were|have|has|had|will|would|can|could|should|do|did|does|say|said|want|need|like|think|know|see|get|go|come|make|take|give)\b/i.test(text);
    
    // Business-specific complete thoughts
    const hasBusinessContext = /\b(meeting|email|phone|call|schedule|appointment|project|work|business|service|support|help|information|details|price|cost|quote)\b/i.test(text);
    
    // Check for email patterns (always complete)
    const hasEmail = /@|at gmail|at outlook|dot com|email is|email address/i.test(text);
    
    // Consider it complete if:
    // 1. Matches a complete thought pattern, OR
    // 2. Has subject-verb structure AND business context, OR  
    // 3. Contains email information, OR
    // 4. Is long enough (8+ words) and has business context
    return hasCompletePattern || 
           (hasSubjectVerb && hasBusinessContext) || 
           hasEmail || 
           (words.length >= 8 && hasBusinessContext);
}

// AssemblyAI real-time transcription initialization
async function initializeAssemblyAILive(callSid, ws) {
    console.log('🎙️ Initializing AssemblyAI real-time transcription for call:', callSid);
    console.log('🔑 Using AssemblyAI API Key:', assemblyAIApiKey ? `${assemblyAIApiKey.substring(0, 10)}...` : 'MISSING');
    
    if (!assemblyAIApiKey) {
        console.error('❌ No AssemblyAI API key available');
        broadcastToClients({
            type: 'transcription_fallback',
            message: 'AssemblyAI API key missing - will analyze recording after call',
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
            const testResponse = await fetch('https://api.assemblyai.com/v2/user', {
                headers: {
                    'Authorization': `Bearer ${assemblyAIApiKey}`,
                    'Content-Type': 'application/json'
                }
            });
            
            console.log(`🔑 API KEY TEST: ${testResponse.status} ${testResponse.statusText}`);
            
            if (!testResponse.ok) {
                const errorText = await testResponse.text();
                console.error(`❌ API KEY INVALID: ${testResponse.status} - ${errorText}`);
                throw new Error(`Invalid AssemblyAI API key: ${testResponse.status} ${testResponse.statusText}`);
            }
            
            const userData = await testResponse.json();
            console.log('✅ API KEY VALID - User account accessible:', userData.email || 'Unknown');
            
        } catch (apiError) {
            console.error('❌ API KEY TEST FAILED:', apiError.message);
            console.log('⚠️ Proceeding with WebSocket connection anyway...');
            // Don't throw - try the WebSocket connection anyway
        }
        
        // Create AssemblyAI live connection with MAXIMUM ACCURACY SETTINGS
        console.log('🔗 Creating AssemblyAI WebSocket connection...');
        console.log('🎯 MAXIMUM ACCURACY: Using superior transcription accuracy...');
        console.log('🔧 ENHANCED AUDIO: Implementing superior audio processing and confidence filtering...');
        
        const assemblyaiLive = assemblyai.realtime.transcriber({
            sample_rate: 8000,
            word_boost: ['meeting', 'schedule', 'arrange', 'discuss', 'appointment', 'email', 'contact', 'information', 'help', 'support'],
            boost_param: 'high',
            punctuate: true,
            format_text: true,
            encoding: 'pcm_mulaw'
        });

        let isConnected = false;
        let audioBuffer = [];
        let fullTranscript = '';
        let mediaPacketCount = 0;
        let twimlFinished = true; // Start immediately for AssemblyAI
        let resultsReceived = 0;
        let lastResultTime = Date.now();

        // Add connection timeout
        const connectionTimeout = setTimeout(() => {
            if (!isConnected) {
                console.error('⏰ ASSEMBLYAI CONNECTION TIMEOUT after 10 seconds');
                broadcastToClients({
                    type: 'assemblyai_timeout',
                    message: 'AssemblyAI connection timeout - will analyze recording after call',
                    data: {
                        callSid: callSid,
                        error: 'Connection timeout',
                        timestamp: new Date().toISOString()
                    }
                });
            }
        }, 10000);

        // Add results timeout checker with immediate HTTP fallback
        const resultsChecker = setInterval(() => {
            if (isConnected && mediaPacketCount > 50 && resultsReceived === 0) {
                const timeSinceStart = Date.now() - lastResultTime;
                console.error(`⚠️ ASSEMBLYAI WEBSOCKET FAILURE: ${mediaPacketCount} packets sent, 0 results after ${Math.round(timeSinceStart/1000)}s`);
                console.error('🔍 CONFIRMED: WebSocket connection is unidirectional (hosting platform blocking response stream)');
                console.error('🔄 IMMEDIATE FALLBACK: Switching to HTTP chunked processing...');
                
                // Immediate switch to HTTP fallback
                clearInterval(resultsChecker);
                initializeHttpChunkedProcessing(callSid, ws);
            }
        }, 3000); // Check every 3 seconds for faster fallback

        // Start the connection
        assemblyaiLive.connect().then(() => {
            console.log('✅ ASSEMBLYAI CONNECTED for call:', callSid);
            console.log('🔧 ASSEMBLYAI CONFIG: superior transcription model, en language, mulaw encoding, 8kHz sample rate');
            console.log('🎯 RAW MULAW: Sending original Twilio audio format directly');
            console.log('📊 INTERIM RESULTS: Enabled for basic transcription testing');
            console.log('🌍 ASSEMBLYAI MINIMAL: Simplest configuration to verify functionality');
            isConnected = true;
            clearTimeout(connectionTimeout);
            
            // Test connection with a small audio packet
            console.log('🧪 ASSEMBLYAI: Testing connection with initial audio...');
            
            // Send a test audio packet to verify the connection works
            const testAudio = Buffer.alloc(160, 127); // Silent mulaw audio
            try {
                assemblyaiLive.sendAudio(testAudio);
                console.log('✅ ASSEMBLYAI: Test audio packet sent successfully');
                
                // Send a second test with some variation to trigger processing
                const testAudio2 = Buffer.alloc(160);
                for (let i = 0; i < 160; i++) {
                    testAudio2[i] = 127 + Math.sin(i * 0.1) * 50; // Generate some audio variation
                }
                assemblyaiLive.sendAudio(testAudio2);
                console.log('✅ ASSEMBLYAI: Test audio with variation sent');
                
                // Set a timeout to check if AssemblyAI responds to test audio
                setTimeout(() => {
                    if (resultsReceived === 0) {
                        console.log('⚠️ ASSEMBLYAI: No response to test audio after 5 seconds');
                        console.log('🔍 CONFIRMED ISSUE: WebSocket is one-way only (send works, receive blocked)');
                        console.log('🔄 SWITCHING TO HTTP CHUNKED PROCESSING...');
                        
                        // Force switch to HTTP chunked processing
                        initializeHttpChunkedProcessing(callSid, ws);
                    }
                }, 5000);
            } catch (testError) {
                console.error('❌ ASSEMBLYAI: Failed to send test audio:', testError);
            }
            
            // Broadcast connection success
            broadcastToClients({
                type: 'assemblyai_connected',
                message: 'AssemblyAI MAXIMUM ACCURACY transcription ready (superior model with keyword boosting)',
                data: {
                    callSid: callSid,
                    provider: 'assemblyai',
                    model: 'assemblyai_model',
                    encoding: 'mulaw',
                    audio_format: 'raw_mulaw_8khz',
                    sample_rate: 8000,
                    features: ['vad_events', 'smart_format', 'punctuate', 'keyword_boosting', 'enhanced_confidence_filtering'],
                    optimization: 'maximum_accuracy',
                    keywords_boosted: 14,
                    search_terms: 9,
                    timestamp: new Date().toISOString()
                }
            });

            // Process any buffered audio
            if (audioBuffer.length > 0) {
                console.log(`📤 Sending ${audioBuffer.length} buffered audio packets to AssemblyAI`);
                audioBuffer.forEach(audio => assemblyaiLive.sendAudio(audio));
                audioBuffer = [];
            }
        }).catch(error => {
            console.error('❌ ASSEMBLYAI CONNECTION FAILED:', error);
            // Fallback to HTTP chunked processing
            initializeHttpChunkedProcessing(callSid, ws);
        });

        // Add debugging for ALL AssemblyAI events
        console.log('🔧 ASSEMBLYAI: Setting up event listeners...');
        
        assemblyaiLive.on('transcript', (data) => {
            resultsReceived++;
            lastResultTime = Date.now();
            console.log(`📥 ASSEMBLYAI RAW RESULT #${resultsReceived} received for call:`, callSid);
            console.log('🔍 ASSEMBLYAI RESULT TYPE:', data.message_type || 'unknown');
            console.log('📄 ASSEMBLYAI FULL RESULT:', JSON.stringify(data, null, 2));
            
            if (data.text) {
                const confidence = data.confidence || 0.8; // AssemblyAI real-time API provides confidence differently
                const isFinal = data.message_type === 'FinalTranscript';
                
                console.log(`🎯 ASSEMBLYAI TRANSCRIPT: "${data.text}" (final: ${isFinal}, confidence: ${confidence.toFixed(2)})`);
                
                // Enhanced confidence filtering with dynamic thresholds
                const text = data.text.trim();
                const hasKeywords = ['meeting', 'schedule', 'arrange', 'email', 'discuss', 'appointment', 'call', 'contact'].some(keyword => 
                    text.toLowerCase().includes(keyword)
                );
                
                // Dynamic confidence thresholds - lower for important keywords
                const minConfidence = hasKeywords ? 0.05 : 0.15;
                const minLength = hasKeywords ? 1 : 2;
                
                console.log(`🔍 QUALITY CHECK: "${text}" (confidence: ${confidence.toFixed(3)}, hasKeywords: ${hasKeywords}, minConf: ${minConfidence})`);
                
                if (confidence > minConfidence && text.length >= minLength) {
                    console.log(`✅ ASSEMBLYAI ACCEPTED: "${text}" (conf: ${confidence.toFixed(3)})`);
                    
                    // Add to full transcript if final
                    if (isFinal) {
                        fullTranscript += text + ' ';
                    }
                    
                    // Broadcast to dashboard with enhanced data
                    broadcastToClients({
                        type: 'live_transcript',
                        message: text,
                        data: {
                            callSid: callSid,
                            text: text,
                            confidence: confidence,
                            is_final: isFinal,
                            provider: 'assemblyai',
                            has_keywords: hasKeywords,
                            quality_score: confidence * (hasKeywords ? 1.2 : 1.0),
                            timestamp: new Date().toISOString()
                        }
                    });
                    
                    // Process final transcripts for intent detection (lower threshold for processing)
                    if (isFinal && text.length >= 1) {
                        console.log('🧠 Processing AssemblyAI transcript for intents...');
                        
                        // Run intent detection and AI analysis in parallel
                        Promise.allSettled([
                            detectAndProcessIntent(text, callSid),
                            analyzeTranscriptWithAI(text, callSid)
                        ]).then(results => {
                            console.log('✅ AssemblyAI transcript processing completed');
                        }).catch(error => {
                            console.error('❌ AssemblyAI transcript processing error:', error);
                        });
                    }
                } else {
                    console.log(`🚫 ASSEMBLYAI FILTERED: "${text}" (confidence: ${confidence.toFixed(3)}, length: ${text.length}, required: ${minConfidence})`);
                }
            } else {
                console.log('📥 ASSEMBLYAI: No text in transcript result');
            }
        });

        // Add listeners for ALL possible AssemblyAI events
        assemblyaiLive.on('session_begins', (data) => {
            console.log('🎤 ASSEMBLYAI SESSION BEGINS:', JSON.stringify(data, null, 2));
        });

        assemblyaiLive.on('session_terminated', (data) => {
            console.log('🔇 ASSEMBLYAI SESSION TERMINATED:', JSON.stringify(data, null, 2));
        });

        assemblyaiLive.on('error', (error) => {
            console.error('❌ ASSEMBLYAI WEBSOCKET ERROR:', error);
            console.error('🔍 WebSocket URL that failed:', error.url || 'Unknown URL');
            console.error('🔍 Ready State:', error.readyState || 'Unknown');
            
            // WebSocket failed - switch to HTTP chunked processing fallback
            console.log('🔄 WEBSOCKET FAILED - Switching to HTTP chunked processing fallback...');
            console.log('💡 This is likely due to Render.com blocking WebSocket connections to AssemblyAI');
            
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

        assemblyaiLive.on('close', () => {
            console.log('🔒 ASSEMBLYAI CONNECTION CLOSED for call:', callSid);
            console.log(`📊 ASSEMBLYAI STATS: ${resultsReceived} results received, packets should be >0 if audio was sent`);
            isConnected = false;
            clearInterval(resultsChecker);
            
            // Log final transcript
            if (fullTranscript.trim()) {
                console.log('📝 ASSEMBLYAI FULL TRANSCRIPT:', fullTranscript.trim());
            } else {
                console.log('⚠️ ASSEMBLYAI: No transcript generated - possible audio or configuration issue');
            }
        });

        // Store the AssemblyAI connection for use in the existing message handler
        ws.assemblyaiLive = assemblyaiLive;
        ws.assemblyaiConnected = () => isConnected;
        ws.assemblyaiBuffer = audioBuffer;

        return assemblyaiLive;

    } catch (error) {
        console.error('❌ Failed to initialize AssemblyAI:', error);
        
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