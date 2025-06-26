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

// Deepgram for real-time transcription
const { createClient } = require('@deepgram/sdk');

const app = express();
const server = http.createServer(app);

// Initialize AI clients
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const assemblyAI = new AssemblyAI({ apiKey: process.env.ASSEMBLYAI_API_KEY });

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
                connectSrc: ["'self'", "ws:", "wss:", "https://api.assemblyai.com", "https://api.openai.com"]
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

// Mulaw to PCM conversion function for AssemblyAI compatibility
function convertMulawToPcm(mulawBuffer) {
    // Mulaw decompression table (256 values)
    const mulawToPcm = [
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
    
    // Convert mulaw bytes to 16-bit PCM samples
    const pcmBuffer = Buffer.alloc(mulawBuffer.length * 2); // 16-bit = 2 bytes per sample
    
    for (let i = 0; i < mulawBuffer.length; i++) {
        const mulawValue = mulawBuffer[i];
        const pcmValue = mulawToPcm[mulawValue];
        
        // Write 16-bit PCM value in little-endian format
        pcmBuffer.writeInt16LE(pcmValue, i * 2);
    }
    
    return pcmBuffer;
}

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
            assemblyai: {
                configured: !!process.env.ASSEMBLYAI_API_KEY,
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
            test_assemblyai: '/test/assemblyai',
            test_assemblyai_ws: '/test/assemblyai-ws',
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
function handleTwilioStreamConnection(ws, req) {
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
    const hasAssemblyAI = !!process.env.ASSEMBLYAI_API_KEY;
    const hasDeepgram = !!(process.env.DEEPGRAM_API_KEY || deepgramApiKey);
    console.log(`🔍 TRANSCRIPTION SERVICE DEBUG:`);
    console.log(`  - AssemblyAI available: ${hasAssemblyAI} (API key: ${hasAssemblyAI ? 'SET' : 'MISSING'})`);
    console.log(`  - Deepgram available: ${hasDeepgram} (API key: ${hasDeepgram ? 'SET' : 'MISSING'})`);
    console.log(`  - Will use: ${hasDeepgram ? 'DEEPGRAM' : hasAssemblyAI ? 'ASSEMBLYAI' : 'NONE'}`);
    
    // Initialize variables for this stream
    let assemblyAISocket = null;
    let fullTranscript = '';
    let lastTranscriptTime = Date.now();
    let messageCount = 0;
    let transcriptTimeout = null;
    
    // Use Deepgram as primary real-time transcription service
    if (process.env.DEEPGRAM_API_KEY || deepgramApiKey) {
        console.log('🎙️ Using Deepgram as primary real-time transcription service...');
        initializeDeepgramRealtime(callSid, ws);
    } else if (false && process.env.ASSEMBLYAI_API_KEY) { // AssemblyAI disabled
        console.log('AI Creating AssemblyAI real-time session...');
        console.log('API Using API key:', process.env.ASSEMBLYAI_API_KEY ? 'SET' : 'NOT SET');
        try {
            // Create WebSocket connection to AssemblyAI real-time service with FIXED authentication
            const WS = require('ws');
            const assemblyAIWS = new WS('wss://api.assemblyai.com/v2/realtime/ws?sample_rate=8000', {
                headers: {
                    'Authorization': process.env.ASSEMBLYAI_API_KEY
                },
                handshakeTimeout: 25000,
                timeout: 60000,
                perMessageDeflate: false
            });
            
            assemblyAISocket = assemblyAIWS;
            console.log('BROADCAST AssemblyAI WebSocket connecting with PRO PLAN features...');
            console.log('CONFIG Pro plan parameters optimized for real-time streaming');
            
            assemblyAIWS.on('open', () => {
                console.log('SUCCESS ASSEMBLYAI REAL-TIME CONNECTED for call:', callSid);
                console.log('INTENT Optimized for Pro plan with word boost');
                console.log('🔑 API Key status:', process.env.ASSEMBLYAI_API_KEY ? 'PROVIDED' : 'MISSING');
                console.log('🔑 API Key length:', process.env.ASSEMBLYAI_API_KEY ? process.env.ASSEMBLYAI_API_KEY.length : 0);
                console.log('🔑 API Key prefix:', process.env.ASSEMBLYAI_API_KEY ? process.env.ASSEMBLYAI_API_KEY.substring(0, 8) + '...' : 'N/A');
                console.log('🔑 Expected prefix: 50257827...');
                console.log('🔑 Keys match:', process.env.ASSEMBLYAI_API_KEY ? process.env.ASSEMBLYAI_API_KEY.startsWith('50257827') : false);
                
                // Send OPTIMAL session configuration for phone call transcription
                try {
                    const sessionConfig = {
                        sample_rate: 8000,
                        encoding: "pcm_s16le", // Use standard PCM encoding for better compatibility
                        word_boost: [
                            // Meeting related
                            "meeting", "arrange", "schedule", "appointment", "consultation", "discuss", "conference",
                            // Email providers
                            "email", "gmail", "outlook", "yahoo", "hotmail", "icloud", "protonmail",
                            // Common business terms
                            "call", "phone", "contact", "reach", "connect", "business", "work", "office",
                            // Time references
                            "monday", "tuesday", "wednesday", "thursday", "friday", "today", "tomorrow", "week",
                            // Actions
                            "send", "follow", "up", "callback", "return", "later"
                        ],
                        format_text: true,
                        enable_extra_session_information: true,
                        speaker_labels: false, // Disable for single speaker optimization
                        filter_profanity: false,
                        redact_pii: false,
                        speech_threshold: 0.1, // Lower threshold for better speech detection
                        silence_threshold: 500, // Increased to reduce false positives
                        auto_highlights: false, // Disable for better performance
                        disfluencies: false // Remove ums, ahs for cleaner output
                    };
                    assemblyAIWS.send(JSON.stringify(sessionConfig));
                    console.log('📤 Sent OPTIMAL phone call session configuration to AssemblyAI');
                } catch (configError) {
                    console.error('❌ Failed to send session config:', configError);
                }
                
                // Broadcast connection success
                broadcastToClients({
                    type: 'assemblyai_connected',
                    message: 'High-accuracy real-time transcription ready',
                    data: {
                        callSid: callSid,
                        timestamp: new Date().toISOString(),
                        configuration: 'enhanced_accuracy_word_boost'
                    }
                });
            });
            
            assemblyAIWS.on('message', (data) => {
                lastTranscriptTime = Date.now(); // Update timestamp for timeout monitoring
                messageCount++;
                try {
                    const transcript = JSON.parse(data);
                    
                    if (transcript.message_type === 'SessionBegins') {
                        console.log('SESSION AssemblyAI session started for call:', callSid);
                        console.log('CONFIG Session configuration confirmed - enhanced accuracy mode');
                        
                        // Broadcast session start to dashboard
                        broadcastToClients({
                            type: 'transcription_ready',
                            message: 'Enhanced real-time transcription activated',
                            data: {
                                callSid: callSid,
                                timestamp: new Date().toISOString(),
                                accuracy_mode: 'enhanced'
                            }
                        });
                        
                    } else if (transcript.message_type === 'PartialTranscript' || transcript.message_type === 'FinalTranscript') {
                         const isPartial = transcript.message_type === 'PartialTranscript';
                         
                         // OPTIMIZED filtering for phone call transcription (reduced thresholds for better detection)
                         const minConfidence = 0.2; // Lower threshold to capture more speech
                         const minLength = 2; // Shorter minimum length to catch brief responses
                         
                         console.log(`📞 PHONE TRANSCRIPT DEBUG: "${transcript.text}" (${transcript.message_type}, confidence: ${transcript.confidence}, words: ${transcript.words ? transcript.words.length : 0})`);
                         
                         // Enhanced validation for phone call quality
                         const hasValidText = transcript.text && transcript.text.trim().length >= minLength;
                         const hasGoodConfidence = transcript.confidence >= minConfidence;
                         
                         // Advanced hallucination detection for phone calls
                         const isLikelyHallucination = transcript.text && (
                             transcript.text.trim().length < 3 ||
                             /^[a-z]{1,3}\.?$/i.test(transcript.text.trim()) || // Single letters
                             /^(um|uh|ah|oh|mm|hmm)\.?$/i.test(transcript.text.trim()) || // Filler words
                             /^[.,!?]+$/.test(transcript.text.trim()) || // Only punctuation
                             transcript.confidence < 0.3 ||
                             // Filter out common phone call artifacts
                             /^(static|noise|beep|ring|dial|tone)\.?$/i.test(transcript.text.trim())
                         );
                         
                         if (hasValidText && hasGoodConfidence && !isLikelyHallucination) {
                             console.log(`✅ ASSEMBLYAI VALID SPEECH: "${transcript.text}" (confidence: ${transcript.confidence})`);
                            
                            if (transcriptTimeout) {
                                clearInterval(transcriptTimeout);
                                transcriptTimeout = null;
                                console.log('SUCCESS AssemblyAI real-time transcription working successfully!');
                            }
                            
                            // Add to full transcript only for final transcripts with good confidence
                            if (transcript.message_type === 'FinalTranscript') {
                                fullTranscript += transcript.text + ' ';
                                console.log(`SUCCESS Added to enhanced transcript: "${transcript.text}"`);
                            }
                            
                            // Broadcast clean speech without technical details
                            broadcastToClients({
                                type: 'live_transcript',
                                message: transcript.text,
                                data: {
                                    callSid: callSid,
                                    text: transcript.text,
                                    confidence: transcript.confidence,
                                    is_final: transcript.message_type === 'FinalTranscript',
                                    timestamp: new Date().toISOString()
                                }
                            });
                            
                            // If final transcript, analyze with OpenAI and detect intents
                            if (transcript.message_type === 'FinalTranscript' && transcript.text.trim().length > 2) {
                                console.log('🧠 Analyzing transcript for intents...');
                                
                                // Run all operations in parallel for faster processing
                                const parallelOperations = [
                                    detectAndProcessIntent(transcript.text, callSid),
                                    analyzeTranscriptWithAI(transcript.text, callSid)
                                ];
                                
                                // Start all operations simultaneously
                                Promise.allSettled(parallelOperations).then(results => {
                                    const [intentResult, aiResult] = results;
                                    
                                    if (intentResult.status === 'rejected') {
                                        console.error('❌ Intent detection failed:', intentResult.reason);
                                    } else {
                                        console.log('✅ Intent detection completed');
                                    }
                                    
                                    if (aiResult.status === 'rejected') {
                                        console.error('❌ AI analysis failed:', aiResult.reason);
                                    } else {
                                        console.log('✅ AI analysis completed');
                                    }
                                    
                                    console.log('🚀 Parallel processing completed');
                                }).catch(error => {
                                    console.error('❌ Parallel processing error:', error);
                                });
                            }
                        } else {
                            if (isLikelyHallucination) {
                                console.log(`🚫 FILTERED HALLUCINATION: "${transcript.text}" (confidence: ${transcript.confidence})`);
                            } else if (!hasGoodConfidence) {
                                console.log(`🚫 FILTERED LOW CONFIDENCE: "${transcript.text}" (confidence: ${transcript.confidence})`);
                            } else if (!hasValidText) {
                                console.log(`🚫 FILTERED EMPTY/SHORT: "${transcript.text}"`);
                            }
                         }
                        
                    } else if (transcript.message_type === 'SessionTerminated') {
                        console.log('END AssemblyAI session terminated for call:', callSid);
                    } else if (transcript.message_type === 'Error') {
                        console.error('ERROR AssemblyAI Error:', transcript.error);
                        
                        // Broadcast error for debugging
                        broadcastToClients({
                            type: 'assemblyai_error',
                            message: `AssemblyAI Error: ${transcript.error}`,
                            data: {
                                callSid: callSid,
                                error: transcript.error,
                                timestamp: new Date().toISOString()
                            }
                        });
                    } else if (transcript.message_type) {
                        console.log(`BROADCAST AssemblyAI Enhanced: ${transcript.message_type}`);
                    }
                } catch (parseError) {
                    console.error('ERROR Error parsing enhanced AssemblyAI message:', parseError);
                }
            });
            
            assemblyAIWS.on('error', (error) => {
                console.error('ERROR ASSEMBLYAI ENHANCED ERROR:', error);
                console.error('DEBUG Error details:', error.message);
                console.error('DEBUG Error code:', error.code);
                
                // Enhanced error handling
                if (error.code === 'ECONNREFUSED') {
                    console.error('DEBUG Connection refused - check network connectivity');
                } else if (error.code === 'ENOTFOUND') {
                    console.error('DEBUG DNS resolution failed - check internet connection');
                } else if (error.message.includes('401') || error.message.includes('403')) {
                    console.error('DEBUG Authentication failed - check AssemblyAI API key');
                    console.error('API API Key status:', process.env.ASSEMBLYAI_API_KEY ? 'SET' : 'NOT SET');
                    console.error('API API Key length:', process.env.ASSEMBLYAI_API_KEY ? process.env.ASSEMBLYAI_API_KEY.length : 'N/A');
                    console.error('API API Key prefix:', process.env.ASSEMBLYAI_API_KEY ? process.env.ASSEMBLYAI_API_KEY.substring(0, 10) + '...' : 'N/A');
                }
                
                // Broadcast enhanced error to dashboard
                broadcastToClients({
                    type: 'assemblyai_error',
                    message: `Enhanced AssemblyAI Error: ${error.message}`,
                    data: {
                        callSid: callSid,
                        error: error.message,
                        code: error.code,
                        timestamp: new Date().toISOString(),
                        enhanced_mode: true
                    }
                });
            });
            
            assemblyAIWS.on('close', (code, reason) => {
                console.log('SOCKET Enhanced AssemblyAI WebSocket closed for call:', callSid);
                console.log('DEBUG Enhanced close code:', code, 'Reason:', reason.toString());
                
                // Enhanced close code handling with more specific errors
                let closeMessage = '';
                switch (code) {
                    case 1000:
                        closeMessage = 'Normal closure';
                        break;
                    case 1001:
                        closeMessage = 'Endpoint going away';
                        break;
                    case 1005:
                        closeMessage = 'No status code (likely authentication/configuration issue)';
                        console.error('DEBUG Code 1005: Check API key and connection parameters');
                        console.error('API Verify AssemblyAI API key is valid and has real-time permissions');
                        break;
                    case 1006:
                        closeMessage = 'Abnormal closure (connection lost)';
                        break;
                    case 1011:
                        closeMessage = 'Server error';
                        break;
                    case 4101:
                        closeMessage = 'AUTHENTICATION ERROR - Invalid API key or quota exceeded';
                        console.error('❌ CRITICAL: AssemblyAI API key is invalid or quota exceeded');
                        console.error('🔑 API Key provided:', process.env.ASSEMBLYAI_API_KEY ? 'YES (length: ' + process.env.ASSEMBLYAI_API_KEY.length + ')' : 'NO');
                        console.error('🔑 API Key prefix:', process.env.ASSEMBLYAI_API_KEY ? process.env.ASSEMBLYAI_API_KEY.substring(0, 8) + '...' : 'N/A');
                        console.error('💡 Solution: Check your AssemblyAI account at https://www.assemblyai.com/app');
                        console.error('💡 Note: Real-time transcription requires higher tier than basic transcription');
                        
                        // Broadcast helpful error message to dashboard with specific solution
                        broadcastToClients({
                            type: 'assemblyai_quota_error',
                            message: 'Real-time transcription requires upgraded AssemblyAI plan - recording analysis will work',
                            data: {
                                callSid: callSid,
                                error: 'Real-time streaming not available on current plan',
                                solution: 'Upgrade to Pro plan for real-time features or use post-call recording analysis',
                                fallback: 'Call recording will be analyzed after completion',
                                timestamp: new Date().toISOString()
                            }
                        });
                        break;
                    case 4102:
                        closeMessage = 'RATE LIMIT ERROR - Too many requests';
                        console.error('❌ CRITICAL: AssemblyAI rate limit exceeded');
                        break;
                    case 4103:
                        closeMessage = 'CONFIGURATION ERROR - Invalid parameters';
                        console.error('❌ CRITICAL: Invalid AssemblyAI configuration parameters');
                        break;
                    default:
                        closeMessage = `Unknown close code: ${code}`;
                        if (code >= 4000) {
                            console.error('❌ CRITICAL: AssemblyAI specific error code:', code);
                        }
                }
                
                console.log(`DEBUG Enhanced close analysis: ${closeMessage}`);
                
                // Broadcast enhanced close info to dashboard
                broadcastToClients({
                    type: 'assemblyai_closed',
                    message: `Enhanced AssemblyAI connection closed: ${closeMessage} (code: ${code})`,
                    data: {
                        callSid: callSid,
                        closeCode: code,
                        closeMessage: closeMessage,
                        reason: reason.toString(),
                        timestamp: new Date().toISOString(),
                        enhanced_mode: true
                    }
                });
            });
            
            // Add a timeout to detect if AssemblyAI is not responding
            let lastTranscriptTime = Date.now();
            let messageCount = 0;
            let transcriptTimeout = setInterval(() => {
                const timeSinceLastTranscript = Date.now() - lastTranscriptTime;
                if (timeSinceLastTranscript > 8000 && mediaPacketCount > 100) { // 8 seconds without any message
                    console.log(`WARNING No AssemblyAI messages for 8+ seconds (packets sent: ${mediaPacketCount}, messages received: ${messageCount})`);
                    console.log(`DEBUG Socket state: ${assemblyAIWS.readyState}, Time since last: ${Math.round(timeSinceLastTranscript/1000)}s`);
                }
            }, 4000);
            
            // Clear transcript timeout on close
            assemblyAIWS.on('close', () => {
                if (transcriptTimeout) {
                    clearInterval(transcriptTimeout);
                }
            });
            
        } catch (error) {
            console.error('ERROR FAILED TO CREATE ASSEMBLYAI SESSION:', error);
            console.error('DEBUG Error details:', error.message);
            console.error('DEBUG Error stack:', error.stack);
            
            // Fallback to Deepgram for real-time transcription
            console.log('🔄 FALLBACK: Switching to Deepgram for real-time transcription...');
            initializeDeepgramRealtime(callSid, ws);
        }
    } else {
        console.log('❌ WARNING: No transcription service available - neither AssemblyAI nor Deepgram configured');
        broadcastToClients({
            type: 'transcription_unavailable',
            message: 'No real-time transcription available - will analyze recording after call',
            data: {
                callSid: callSid,
                error: 'No API keys configured',
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
                    console.log('DEBUG AssemblyAI socket status:', assemblyAISocket ? 'EXISTS' : 'MISSING');
                    console.log('DEBUG AssemblyAI ready state:', assemblyAISocket ? assemblyAISocket.readyState : 'N/A');
                    
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
                        console.log(`DEBUG AssemblyAI socket state: ${assemblyAISocket ? assemblyAISocket.readyState : 'NO SOCKET'}`);
                        console.log(`DEBUG Deepgram connection: ${ws.deepgramLive ? 'EXISTS' : 'MISSING'}`);
                    }
                    
                    // Handle Deepgram audio forwarding
                    if (ws.deepgramLive && data.media.payload && twimlFinished) {
                        try {
                            const audioData = Buffer.from(data.media.payload, 'base64');
                            
                                                         if (ws.deepgramConnected()) {
                                 ws.deepgramLive.send(audioData);
                                 
                                 if (mediaPacketCount === 1) {
                                     console.log(`✅ DEEPGRAM: First audio packet sent (${audioData.length} bytes)`);
                                     
                                     // Analyze first audio packet for debugging
                                     let nonZeroBytes = 0;
                                     let maxValue = 0;
                                     for (let i = 0; i < Math.min(audioData.length, 50); i++) {
                                         if (audioData[i] !== 0 && audioData[i] !== 127 && audioData[i] !== 255) nonZeroBytes++;
                                         maxValue = Math.max(maxValue, audioData[i]);
                                     }
                                     console.log(`🔊 DEEPGRAM AUDIO ANALYSIS: ${nonZeroBytes}/50 meaningful bytes, max: ${maxValue}`);
                                     console.log(`🧪 DEEPGRAM: Expecting results within 2-3 seconds...`);
                                 }
                                 
                                 // Log progress every 300 packets and check for results
                                 if (mediaPacketCount % 300 === 0) {
                                     console.log(`🎙️ DEEPGRAM: ${mediaPacketCount} audio packets sent`);
                                     console.log(`⚠️ DEEPGRAM DEBUG: If no results received yet, there may be a connection issue`);
                                 }
                             } else {
                                // Buffer audio until connected
                                if (ws.deepgramBuffer) {
                                    ws.deepgramBuffer.push(audioData);
                                    if (ws.deepgramBuffer.length > 100) {
                                        ws.deepgramBuffer.shift(); // Keep only last 100 packets
                                    }
                                }
                            }
                        } catch (deepgramError) {
                            console.error('❌ Deepgram audio forwarding error:', deepgramError.message);
                        }
                    }
                    
                    
                    // Enhanced audio forwarding to AssemblyAI for maximum accuracy
                    if (assemblyAISocket && (assemblyAISocket.readyState === 1 || assemblyAISocket.readyState === 0) && data.media.payload && twimlFinished) {
                        try {
                            // Enhanced audio processing with quality optimization
                            const audioData = data.media.payload;
                            
                            // Enhanced audio validation to prevent garbage
                            if (audioData.length < 20) {
                                if (mediaPacketCount % 100 === 0) {
                                    console.log('FILTERED Skipping very small audio packet:', audioData.length);
                                }
                                return;
                            }
                            
                            // Additional validation: check for valid base64
                            try {
                                Buffer.from(audioData, 'base64');
                            } catch (base64Error) {
                                console.log('FILTERED Invalid base64 audio data');
                                return;
                            }
                            
                            // Send OPTIMIZED audio message to AssemblyAI for phone calls
                            if (assemblyAISocket.readyState === 1) {
                                // Enhanced mulaw audio processing for phone calls
                                const audioBuffer = Buffer.from(audioData, 'base64');
                                
                                // Advanced audio quality analysis for phone calls
                                if (mediaPacketCount === 1) {
                                    let nonZeroBytes = 0;
                                    let maxValue = 0;
                                    let avgValue = 0;
                                    let variation = 0;
                                    
                                    for (let i = 0; i < Math.min(audioBuffer.length, 50); i++) {
                                        if (audioBuffer[i] !== 0 && audioBuffer[i] !== 127 && audioBuffer[i] !== 255) nonZeroBytes++;
                                        maxValue = Math.max(maxValue, audioBuffer[i]);
                                        avgValue += audioBuffer[i];
                                    }
                                    avgValue /= Math.min(audioBuffer.length, 50);
                                    
                                    // Calculate variation for voice detection
                                    for (let i = 0; i < Math.min(audioBuffer.length, 50); i++) {
                                        variation += Math.abs(audioBuffer[i] - avgValue);
                                    }
                                    variation /= Math.min(audioBuffer.length, 50);
                                    
                                    console.log(`🔊 PHONE AUDIO ANALYSIS: ${nonZeroBytes}/50 meaningful bytes, max: ${maxValue}, avg: ${avgValue.toFixed(1)}, variation: ${variation.toFixed(1)}`);
                                    
                                    if (nonZeroBytes < 15 || variation < 5) {
                                        console.log(`⚠️ WARNING: Audio appears to be low quality or mostly silence`);
                                    } else {
                                        console.log(`✅ GOOD: Audio has sufficient variation for voice recognition`);
                                    }
                                }
                                
                                // Enhanced mulaw to PCM conversion with phone call optimization
                                const pcmBuffer = convertMulawToPcm(audioBuffer);
                                const pcmBase64 = pcmBuffer.toString('base64');
                                
                                // Enhanced debugging for phone call audio
                                if (mediaPacketCount === 1) {
                                    console.log(`🔊 PHONE PCM CONVERSION: ${audioBuffer.length} mulaw → ${pcmBuffer.length} PCM bytes`);
                                    const samples = [];
                                    for (let i = 0; i < Math.min(20, pcmBuffer.length); i += 2) {
                                        samples.push(pcmBuffer.readInt16LE(i));
                                    }
                                    console.log(`🔊 PCM sample range: [${Math.min(...samples)} to ${Math.max(...samples)}]`);
                                }
                                
                                // Optimized audio message for phone call transcription
                                const phoneOptimizedAudioMessage = {
                                    audio_data: pcmBase64
                                };
                                
                                assemblyAISocket.send(JSON.stringify(phoneOptimizedAudioMessage));
                                
                                if (mediaPacketCount === 1) {
                                    console.log(`SUCCESS ASSEMBLYAI: First audio packet sent (mulaw ${audioBuffer.length}→PCM ${pcmBuffer.length} bytes)`);
                                    console.log('CONFIG AssemblyAI format: mulaw→PCM converted, sample rate: 8000Hz, word boosted');
                                } else if (mediaPacketCount <= 5) {
                                    console.log(`ASSEMBLYAI: Packet ${mediaPacketCount} sent (${audioBuffer.length}→${pcmBuffer.length} bytes)`);
                                }
                                
                                // Enhanced monitoring every 300 packets (more frequent)
                                if (mediaPacketCount % 300 === 0) {
                                    console.log(`AUDIO Enhanced audio packets sent: ${mediaPacketCount} (mulaw→PCM converted stream active)`);
                                }
                            } else if (assemblyAISocket.readyState === 0) {
                                // Socket still connecting - we'll retry when it's ready
                                if (mediaPacketCount === 1) {
                                    console.log('WAITING AssemblyAI socket still connecting, audio will be sent when ready...');
                                }
                                // We could buffer audio here if needed, but for real-time it's better to start fresh when connected
                            }
                        } catch (audioError) {
                            console.error('ERROR Enhanced audio forwarding error:', audioError.message);
                            console.error('DEBUG AssemblyAI socket state:', assemblyAISocket ? assemblyAISocket.readyState : 'NO SOCKET');
                            
                            // Attempt to reconnect if socket is in bad state
                            if (assemblyAISocket && assemblyAISocket.readyState === 3) {
                                console.log('SHUTDOWN Attempting to reconnect enhanced AssemblyAI socket...');
                                // Note: In production, implement reconnection logic here
                            }
                        }
                    } else if (!twimlFinished) {
                        if (mediaPacketCount === 1) {
                            console.log('WAITING Enhanced mode: Waiting for TwiML to finish (avoiding echo)');
                        }
                    } else if (!assemblyAISocket) {
                        if (mediaPacketCount === 1) {
                            console.log('WARNING Enhanced mode: No AssemblyAI socket available');
                        }
                    } else if (assemblyAISocket.readyState !== 1 && assemblyAISocket.readyState !== 0) {
                        if (mediaPacketCount === 1) {
                            console.log(`WARNING Enhanced mode: AssemblyAI socket in bad state (state: ${assemblyAISocket.readyState})`);
                            console.log(`DEBUG Socket states: 0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED`);
                        }
                    } else if (!data.media.payload) {
                        if (mediaPacketCount === 1) {
                            console.log('WARNING Enhanced mode: No audio payload in media packet');
                        }
                    }
                    break;
                    
                case 'stop':
                    console.log('STREAM STREAM STOPPED for call:', callSid);
                    console.log(`STATS Total audio packets received: ${mediaPacketCount}`);
                    
                    if (assemblyAISocket) {
                        console.log('SOCKET Closing AssemblyAI session...');
                        assemblyAISocket.close();
                    }
                    
                    if (ws.deepgramLive) {
                        console.log('🛑 DEEPGRAM: Finishing transcription session...');
                        ws.deepgramLive.finish();
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
        if (assemblyAISocket) {
            assemblyAISocket.close();
        }
        activeStreams.delete(callSid);
    });
    
    ws.on('error', (error) => {
        console.error('ERROR Stream WebSocket error:', error);
    });
}

// Test current transcription service priority
app.get('/test/transcription-priority', (req, res) => {
    const hasAssemblyAI = !!process.env.ASSEMBLYAI_API_KEY;
    const hasDeepgram = !!(process.env.DEEPGRAM_API_KEY || deepgramApiKey);
    
    let primaryService = 'none';
    if (hasAssemblyAI) {
        primaryService = 'AssemblyAI';
    } else if (hasDeepgram) {
        primaryService = 'Deepgram';
    }
    
    res.json({
        primary_service: primaryService,
        services_available: {
            assemblyai: hasAssemblyAI,
            deepgram: hasDeepgram
        },
        api_keys: {
            assemblyai_configured: hasAssemblyAI,
            assemblyai_length: process.env.ASSEMBLYAI_API_KEY ? process.env.ASSEMBLYAI_API_KEY.length : 0,
            deepgram_configured: hasDeepgram,
            deepgram_is_hardcoded: !!deepgramApiKey
        },
        recommendation: hasAssemblyAI ? 
            'AssemblyAI will be used for real-time transcription' : 
            'Configure ASSEMBLYAI_API_KEY for better accuracy',
        timestamp: new Date().toISOString()
    });
});

// Test AssemblyAI connection endpoint
app.post('/test/assemblyai', async (req, res) => {
    console.log('🧪 Testing AssemblyAI connection...');
    
    if (!process.env.ASSEMBLYAI_API_KEY) {
        return res.json({
            success: false,
            error: 'No AssemblyAI API key configured'
        });
    }
    
    try {
        // Test the API key with a simple request
        const response = await fetch('https://api.assemblyai.com/v2/transcript', {
            method: 'POST',
            headers: {
                'Authorization': process.env.ASSEMBLYAI_API_KEY,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                audio_url: 'https://storage.googleapis.com/aai-docs-samples/nbc.wav'
            })
        });
        
        const data = await response.json();
        console.log('SUCCESS AssemblyAI API test response:', data);
        
        res.json({
            success: response.ok,
            status: response.status,
            api_key_valid: response.ok,
            api_key_length: process.env.ASSEMBLYAI_API_KEY ? process.env.ASSEMBLYAI_API_KEY.length : 0,
            api_key_prefix: process.env.ASSEMBLYAI_API_KEY ? process.env.ASSEMBLYAI_API_KEY.substring(0, 10) + '...' : 'N/A',
            response: data
        });
    } catch (error) {
        console.error('ERROR AssemblyAI API test failed:', error);
        res.json({
            success: false,
            error: error.message
        });
    }
});

// Test real-time WebSocket connection to AssemblyAI
app.get('/test/assemblyai-ws', (req, res) => {
    console.log('🧪 Testing AssemblyAI WebSocket connection...');
    
    if (!process.env.ASSEMBLYAI_API_KEY) {
        return res.json({
            success: false,
            error: 'No AssemblyAI API key configured'
        });
    }
    
    try {
        const WS = require('ws');
        const testSocket = new WS('wss://api.assemblyai.com/v2/realtime/ws?sample_rate=8000&disable_partial_transcripts=false&speech_threshold=0.2', {
            headers: {
                'Authorization': process.env.ASSEMBLYAI_API_KEY
            }
        });
        
        let result = { success: false, messages: [] };
        
        testSocket.on('open', () => {
            console.log('SUCCESS AssemblyAI WebSocket test connection opened');
            result.messages.push('WebSocket connection opened successfully');
            result.success = true;
            
            // Close test connection after 2 seconds
            setTimeout(() => {
                testSocket.close();
                res.json(result);
            }, 2000);
        });
        
        testSocket.on('message', (data) => {
            const message = JSON.parse(data);
            console.log('📥 AssemblyAI test message:', message);
            result.messages.push(`Received: ${message.message_type || 'unknown'}`);
        });
        
        testSocket.on('error', (error) => {
            console.error('ERROR AssemblyAI WebSocket test error:', error);
            result.success = false;
            result.error = error.message;
            res.json(result);
        });
        
        // Timeout after 5 seconds
        setTimeout(() => {
            if (!res.headersSent) {
                testSocket.close();
                result.success = false;
                result.error = 'Connection timeout';
                res.json(result);
            }
        }, 5000);
        
    } catch (error) {
        console.error('ERROR AssemblyAI WebSocket test failed:', error);
        res.json({
            success: false,
            error: error.message
        });
    }
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
                assemblyai_configured: !!process.env.ASSEMBLYAI_API_KEY,
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
        <Stream url="${streamUrl}" track="inbound_track" />
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
        
        // Upload to AssemblyAI for transcription
        console.log('📤 Uploading to AssemblyAI for transcription...');
        const uploadUrl = await assemblyAI.files.upload(audioBuffer);
        
        // Transcribe with speaker labels and advanced features
        const transcript = await assemblyAI.transcripts.create({
            audio_url: uploadUrl,
            language_detection: true,
            speaker_labels: true,
            speakers_expected: 2, // Expecting 2 speakers in bridge call
            sentiment_analysis: true,
            entity_detection: true,
            auto_chapters: true,
            summarization: true,
            summary_model: 'conversational',
            summary_type: 'bullets'
        });
        
        // Wait for transcription to complete
        let transcriptResult = transcript;
        while (transcriptResult.status !== 'completed' && transcriptResult.status !== 'error') {
            await new Promise(resolve => setTimeout(resolve, 2000));
            transcriptResult = await assemblyAI.transcripts.get(transcript.id);
            console.log('⏳ Transcription status:', transcriptResult.status);
        }
        
        if (transcriptResult.status === 'error') {
            throw new Error(`Transcription failed: ${transcriptResult.error}`);
        }
        
        console.log('✅ Bridge call transcription completed!');
        console.log('🗣️ CONVERSATION TRANSCRIPT:', transcriptResult.text);
        
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

// Deepgram real-time transcription initialization
function initializeDeepgramRealtime(callSid, ws) {
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
        // Create Deepgram live connection with UK-optimized phone call config
        console.log('🔗 Creating Deepgram connection with UK phone-optimized config...');
        const deepgramLive = deepgram.listen.live({
            model: 'nova-2',
            language: 'en-GB', // UK English for better accuracy
            smart_format: true,
            interim_results: true,
            utterance_end_ms: 1000,
            vad_events: true,
            punctuate: true,
            sample_rate: 8000,
            channels: 1,
            encoding: 'mulaw',
            filler_words: false,
            no_delay: true
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

        // Add results timeout checker
        const resultsChecker = setInterval(() => {
            if (isConnected && mediaPacketCount > 100 && resultsReceived === 0) {
                const timeSinceStart = Date.now() - lastResultTime;
                console.error(`⚠️ DEEPGRAM RESULTS TIMEOUT: ${mediaPacketCount} packets sent, 0 results received after ${Math.round(timeSinceStart/1000)}s`);
                console.error('🔍 POSSIBLE ISSUES:');
                console.error('  - Audio format incompatibility (mulaw encoding)');
                console.error('  - Deepgram API key permissions');
                console.error('  - Network connectivity to Deepgram servers');
                console.error('  - Audio quality too low for speech detection');
            }
        }, 5000);

        deepgramLive.on('open', () => {
            console.log('✅ DEEPGRAM CONNECTED for call:', callSid);
            console.log('🔧 DEEPGRAM CONFIG: nova-2 model, en-GB language, mulaw encoding, 8kHz sample rate');
            console.log('🌍 DEEPGRAM REGION: Optimized for UK phone calls');
            isConnected = true;
            clearTimeout(connectionTimeout);
            
            // Test connection with a small audio packet
            console.log('🧪 DEEPGRAM: Testing connection with initial audio...');
            
            // Broadcast connection success
            broadcastToClients({
                type: 'deepgram_connected',
                message: 'Deepgram real-time transcription ready (nova-2 model)',
                data: {
                    callSid: callSid,
                    provider: 'deepgram',
                    model: 'nova-2',
                    encoding: 'mulaw',
                    sample_rate: 8000,
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

        deepgramLive.on('utteranceEnd', (data) => {
            console.log('🗣️ DEEPGRAM UTTERANCE END:', JSON.stringify(data, null, 2));
        });

        deepgramLive.on('speechStarted', (data) => {
            console.log('🎤 DEEPGRAM SPEECH STARTED:', JSON.stringify(data, null, 2));
        });

        deepgramLive.on('speechEnded', (data) => {
            console.log('🔇 DEEPGRAM SPEECH ENDED:', JSON.stringify(data, null, 2));
        });

        deepgramLive.on('metadata', (data) => {
            console.log('📊 DEEPGRAM METADATA:', JSON.stringify(data, null, 2));
        });

        deepgramLive.on('error', (error) => {
            console.error('❌ DEEPGRAM ERROR:', error);
            console.error('🔍 Error type:', typeof error);
            console.error('🔍 Error details:', error);
            
            let errorMessage = error.message || 'Unknown Deepgram error';
            let solution = 'Check logs for details';
            
            // Provide specific solutions for common errors
            if (error.message && error.message.includes('network error')) {
                solution = 'Network connectivity issue - check internet connection';
            } else if (error.message && error.message.includes('401')) {
                solution = 'Invalid API key - check DEEPGRAM_API_KEY environment variable';
            } else if (error.message && error.message.includes('403')) {
                solution = 'Insufficient permissions - check Deepgram account settings';
            } else if (error.message && error.message.includes('non-101 status code')) {
                solution = 'WebSocket handshake failed - API key or configuration issue';
            }
            
            broadcastToClients({
                type: 'deepgram_error',
                message: `Deepgram error: ${errorMessage}`,
                data: {
                    callSid: callSid,
                    error: errorMessage,
                    solution: solution,
                    fallback: 'Call recording will be analyzed after completion',
                    timestamp: new Date().toISOString()
                }
            });
        });

        deepgramLive.on('close', () => {
            console.log('🔒 DEEPGRAM CONNECTION CLOSED for call:', callSid);
            console.log(`📊 DEEPGRAM STATS: ${resultsReceived} results received, ${mediaPacketCount} packets sent`);
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