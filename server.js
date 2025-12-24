import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { OpenAI } from 'openai';
import { createServer } from 'http';
import { Server } from 'socket.io';
import ServerLogger from './script/server_log.js';

dotenv.config();

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());
app.use(express.static('.'));

// Initialize server logger
const serverLogger = new ServerLogger();
serverLogger.addLog('🚀 Server started', 'success');

// Initialize client logs storage
const clientLogs = new Map(); // playerId -> { logs: [], lastUpdated: timestamp }

// Initialize OpenAI client with Hugging Face router
const client = new OpenAI({
    baseURL: "https://router.huggingface.co/v1",
    apiKey: process.env.HF_API_KEY,
});

// AI Model configuration
const AI_MODEL = "deepseek-ai/DeepSeek-V3.2";

// Multiplayer game state
const rooms = new Map(); // roomId -> { players: [], currentQuestion: {}, scores: {}, mode: 'collab'/'compete' }
const playerRooms = new Map(); // playerId -> roomId

// Wrapper function for server logs
function broadcastLog(message, type = 'log') {
    const logMessage = typeof message === 'string' ? message : JSON.stringify(message);
    serverLogger.addLog(logMessage, type);
    
    // Broadcast to all connected clients via Socket.io
    if (io) {
        io.emit('serverLog', {
            message: logMessage,
            level: type,
            timestamp: new Date()
        });
    }
}

// Generate room code
function generateRoomCode() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// ============================================================================
// TRANSLATION FUNCTION using LibreTranslate
// ============================================================================
async function translateText(text, targetLanguage) {
    // Only translate if target language is not English
    if (targetLanguage === 'en') {
        return text;
    }

    try {
        // Map language codes to LibreTranslate codes
        const languageMap = {
            'zh': 'zh'  // Chinese (simplified)
        };
        
        const targetLang = languageMap[targetLanguage] || targetLanguage;
        
        // Use a simple, reliable translation approach
        // LibreTranslate public API
        const response = await fetch('https://libretranslate.com/translate', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify({
                q: text.substring(0, 500),  // Limit text length
                source: 'en',
                target: targetLang
            })
        });

        if (response.ok) {
            const data = await response.json();
            if (data.translatedText) {
                broadcastLog(`[Translation] Successfully translated to ${targetLang}`);
                return data.translatedText;
            }
        } else {
            broadcastLog(`[Translation] Server returned ${response.status}, trying alternative...`, 'warn');
        }

        // Fallback: Use MyMemory API (completely free, no key needed)
        broadcastLog(`[Translation] Falling back to MyMemory API`);
        const fallbackResponse = await fetch(
            `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text.substring(0, 500))}&langpair=en|${targetLang}`
        );
        
        if (fallbackResponse.ok) {
            const fallbackData = await fallbackResponse.json();
            if (fallbackData.responseData && fallbackData.responseData.translatedText) {
                broadcastLog(`[Translation] MyMemory fallback successful`);
                return fallbackData.responseData.translatedText;
            }
        }

        broadcastLog('[Translation] All translation services failed, returning original text', 'warn');
        return text;
    } catch (error) {
        broadcastLog('[Translation] Error translating text: ' + error.message, 'error');
        return text; // Return original text if translation fails
    }
}

// ============================================================================
// UNIFIED GAME SEQUENCE (SINGLEPLAYER & MULTIPLAYER):
// STEP 1: Game starts
// STEP 2: AI generates question with 4 options
// STEP 3: AI verifies the answer (checks if any option is correct)
// STEP 4: If no correct answer found => regenerate question (go to STEP 2)
// STEP 5: If correct answer found => send question to player(s)
// STEP 6: Start timer (30 seconds)
// STEP 7: Player(s) answer (or timer expires)
// STEP 8: AI checks answer(s) and reveals result
// ============================================================================

// AI API using Hugging Face via OpenAI SDK
// UNIFIED SINGLEPLAYER ENDPOINT using the unified question generation function
app.post('/chat', async (req, res) => {
    try {
        const { message, subject, language } = req.body;
        
        broadcastLog('[ROUND] Game start - Initiating unified game sequence');
        
        // Get subject
        let currentSubject = subject;
        let targetLanguage = language || 'en';
        broadcastLog(`[ROUND] STEP 1: Game started for subject: ${currentSubject}, language: ${targetLanguage}`);
        
        // Use unified function to generate and validate question with 10-second retry delay
        // STEP 2 & 3: Generate question and verify answer
        const result = await generateAndValidateQuestion(
            currentSubject,
            [], // No conversation history for singleplayer initial question
            [], // No askedQuestions tracking for singleplayer
            'singleplayer',
            targetLanguage,  // Pass target language to translation function
            true // Enable 10-second retry delay
        );
        
        if (!result.parsedData || result.correctAnswerIndex === -1) {
            broadcastLog('[ROUND] Failed to generate valid question after multiple attempts', 'error');
            return res.status(500).json({ 
                error: 'Failed to generate valid question',
                attempts: result.attempts
            });
        }
        
        broadcastLog(`[ROUND] STEP 5: Valid question ready (after ${result.attempts} attempts)`);
        broadcastLog('[ROUND] STEP 6: Timer will start on client side after UI render');
        
        // Return both the raw response and verified answer
        res.json({ 
            response: result.aiResponse,
            correctAnswer: result.correctAnswerIndex 
        });

    } catch (error) {
        broadcastLog('[ROUND] Error in unified game sequence: ' + error.message, 'error');
        res.status(500).json({ 
            error: 'Failed to initiate game',
            details: error.message 
        });
    }
});

// ============================================================================
// STEP 7-8: SINGLEPLAYER ANSWER CHECK WITH AI
// Verifies player answer and reveals result
// ============================================================================
app.post('/checkAnswer', async (req, res) => {
    try {
        const { question, selectedAnswer, allOptions, correctAnswerIndex } = req.body;
        
        if (!question || !selectedAnswer || !allOptions || correctAnswerIndex === undefined) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        
        broadcastLog('[ROUND] STEP 7-8: Checking answer...');
        broadcastLog(`Question: "${question.substring(0, 60)}..."`);
        broadcastLog(`Selected: "${selectedAnswer}" (Index: ${allOptions.indexOf(selectedAnswer)})`);
        broadcastLog(`Correct: "${allOptions[correctAnswerIndex]}" (Index: ${correctAnswerIndex})`);
        
        // STEP 7-8: Compare indices directly (answer already verified during question generation)
        const selectedIndex = allOptions.indexOf(selectedAnswer);
        const isCorrect = (selectedIndex === correctAnswerIndex);
        
        broadcastLog(`Result: ${isCorrect ? '✓ CORRECT' : '✗ INCORRECT'}`);
        
        // Return verification result
        res.json({ 
            isCorrect: isCorrect,
            correctAnswerIndex: correctAnswerIndex,
            selectedIndex: selectedIndex
        });
        
    } catch (error) {
        broadcastLog('[ROUND] Error checking answer: ' + error.message, 'error');
        res.status(500).json({ 
            error: 'Failed to check answer',
            details: error.message 
        });
    }
});

// ============================================================================
// SERVE LOGS ENDPOINT - Returns generated HTML with all logs
// ============================================================================
app.get('/api/logs-html', (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(serverLogger.getLogsHtml());
});

// ============================================================================
// SERVE LOGS ENDPOINT - Returns logs as JSON
// ============================================================================
app.get('/api/logs', (req, res) => {
    const logs = serverLogger.logs || [];
    const since = req.query.since ? parseInt(req.query.since) : 0;
    
    // Filter logs by timestamp if 'since' parameter provided
    const filteredLogs = since > 0 
        ? logs.filter(log => new Date(log.timestamp).getTime() > since)
        : logs;
    
    res.json(filteredLogs);
});

// ============================================================================
// CLIENT LOGS ENDPOINTS - For client.html to fetch and store player logs
// ============================================================================
app.post('/api/client-logs', (req, res) => {
    const { playerName, logs } = req.body;
    if (!playerName) {
        return res.status(400).json({ error: 'Missing playerName' });
    }
    
    // Store or update client logs
    clientLogs.set(playerName, {
        logs: logs || [],
        lastUpdated: new Date().toISOString()
    });
    
    res.json({ success: true, stored: logs ? logs.length : 0 });
});

app.get('/api/client-logs/:playerName', (req, res) => {
    const { playerName } = req.params;
    const playerData = clientLogs.get(playerName);
    
    if (!playerData) {
        return res.json({ logs: [], playerName: playerName, count: 0 });
    }
    
    const limit = req.query.limit ? parseInt(req.query.limit) : 500;
    const logs = playerData.logs.slice(-limit);
    
    res.json({
        playerName: playerName,
        logs: logs,
        count: logs.length,
        total: playerData.logs.length,
        lastUpdated: playerData.lastUpdated
    });
});

app.get('/api/client-logs-list', (req, res) => {
    const players = Array.from(clientLogs.entries()).map(([playerName, data]) => ({
        playerName: playerName,
        logCount: data.logs.length,
        lastUpdated: data.lastUpdated
    }));
    
    res.json({
        players: players,
        total: players.length
    });
});

// WebSocket connection handling
// Helper function to parse quiz JSON (matches client-side logic)
function parseQuizJSON(text) {
    try {
        broadcastLog('[Original AI Response]: ' + text.substring(0, 100));
        broadcastLog('[Response Length]: ' + text.length);
        
        let jsonText = null;
        
        // First, check for XML format
        const xmlMatch = text.match(/<question>[\s\S]*?<\/question>/);
        if (xmlMatch) {
            broadcastLog('[XML Format Detected] Parsing XML format...');
            const xmlText = xmlMatch[0];
            broadcastLog('[XML Content]: ' + xmlText.substring(0, 100));
            
            // Extract question text
            const questionMatch = xmlText.match(/<text>([\s\S]*?)<\/text>/);
            const question = questionMatch ? questionMatch[1].trim() : '';
            
            // Extract options
            const optionsMatch = xmlText.match(/<options>([\s\S]*?)<\/options>/);
            const options = [];
            if (optionsMatch) {
                const optionMatches = optionsMatch[1].matchAll(/<option>([\s\S]*?)<\/option>/g);
                for (const match of optionMatches) {
                    options.push(match[1].trim());
                }
            }
            
            // Extract answer if present (could be index or text)
            const answerMatch = xmlText.match(/<answer>([\s\S]*?)<\/answer>/);
            let answer = 0; // Default to first option
            if (answerMatch) {
                const answerText = answerMatch[1].trim();
                // Check if it's a number (index)
                if (!isNaN(answerText)) {
                    answer = parseInt(answerText);
                } else {
                    // Try to find matching option
                    const answerIndex = options.findIndex(opt => 
                        opt.toLowerCase() === answerText.toLowerCase()
                    );
                    if (answerIndex >= 0) answer = answerIndex;
                }
            }
            
            if (question && options.length > 0) {
                broadcastLog('[XML Parsed Successfully]: question length=' + question.length + ', options=' + options.length + ', answer=' + answer);
                return {
                    question: question,
                    options: options,
                    answer: answer
                };
            } else {
                broadcastLog('[XML Parse Failed] Missing question or options');
            }
        }
        
        // Try to extract JSON from code blocks (```json ... ```)
        const jsonBlockMatch = text.match(/```json\s*([\s\S]*?)```/);
        if (jsonBlockMatch) {
            jsonText = jsonBlockMatch[1].trim();
        }
        
        // If no JSON block found, try to find raw JSON object
        if (!jsonText) {
            // Remove Python code blocks first
            let cleanedText = text.replace(/```python[\s\S]*?```/g, '');
            cleanedText = cleanedText.replace(/```[\s\S]*?```/g, '');
            cleanedText = cleanedText.replace(/#.*$/gm, ''); // Remove Python comments
            
            // Find JSON object - use greedy matching to get the complete object
            const jsonObjectMatch = cleanedText.match(/\{[\s\S]*"question"[\s\S]*\}/);
            
            if (!jsonObjectMatch) {
                broadcastLog('No JSON found in response');
                return null;
            }
            
            jsonText = jsonObjectMatch[0];
        }
        
        // Remove JavaScript comments
        jsonText = jsonText.replace(/\/\*[\s\S]*?\*\//g, '');
        jsonText = jsonText.replace(/\/\/.*/g, '');
        
        // Fix malformed options array: ["A": "text", "B": "text"] to [{"A": "text"}, {"B": "text"}]
        // First, detect if we have this malformed format
        if (/"options"\s*:\s*\[\s*"[A-F]"\s*:/.test(jsonText)) {
            broadcastLog('Detected malformed options array format, fixing...');
            
            // Extract the options array
            const optionsMatch = jsonText.match(/"options"\s*:\s*\[([^\]]+)\]/);
            if (optionsMatch) {
                const originalOptions = optionsMatch[0];
                // Split by comma that's followed by a letter option
                let fixedOptions = originalOptions;
                
                // Replace "options": ["A": with "options": [{"A":
                fixedOptions = fixedOptions.replace(/"options"\s*:\s*\[\s*"([A-F])"\s*:/g, '"options": [{"$1":');
                
                // Replace , "B": with }, {"B":
                fixedOptions = fixedOptions.replace(/,\s*"([A-F])"\s*:/g, '}, {"$1":');
                
                // Close the last object before the closing bracket ]
                // Find the last quote before ]
                fixedOptions = fixedOptions.replace(/("\s*)\]$/, '$1}]');
                
                jsonText = jsonText.replace(originalOptions, fixedOptions);
                broadcastLog('Fixed options array format');
            }
        }
        
        // Try to fix missing closing braces
        const openBraces = (jsonText.match(/\{/g) || []).length;
        const closeBraces = (jsonText.match(/\}/g) || []).length;
        if (openBraces > closeBraces) {
            jsonText += '}'.repeat(openBraces - closeBraces);
        }
        
        // Try parsing
        let data;
        try {
            data = JSON.parse(jsonText);
        } catch (e) {
            broadcastLog('First parse attempt failed: ' + e.message);
            broadcastLog('JSON text causing error: ' + jsonText.substring(0, 300));
            // Additional cleanup for Python-style syntax
            jsonText = jsonText.replace(/'/g, '"'); // Replace single quotes with double quotes
            try {
                data = JSON.parse(jsonText);
            } catch (e2) {
                broadcastLog('Second parse attempt also failed: ' + e2.message);
                return null;
            }
        }
        
        // Handle format: { question, options: [], answer }
        if (data.question && Array.isArray(data.options) && data.options.length > 0) {
            const options = data.options.map(opt => {
                if (typeof opt === 'object' && opt !== null) {
                    // Extract value from objects like {"A": "text"}
                    const keys = Object.keys(opt);
                    if (keys.length > 0) {
                        const value = opt[keys[0]];
                        return String(value);
                    }
                }
                return String(opt);
            });
            
            return {
                question: data.question,
                options: options,
                answer: data.answer
            };
        }
        
        // Handle format: { question, options: {A, B, C, D}, answer: "B" }
        if (data.question && data.options && typeof data.options === 'object' && !Array.isArray(data.options)) {
            const options = [];
            const keys = ['A', 'B', 'C', 'D', 'E', 'F'];
            let correctIndex = -1;
            
            for (let i = 0; i < keys.length; i++) {
                const key = keys[i];
                const lowerKey = key.toLowerCase();
                
                if (data.options[key] || data.options[lowerKey]) {
                    const optionValue = data.options[key] || data.options[lowerKey];
                    const optionText = String(optionValue);
                    options.push(optionText);
                    
                    if (data.answer === key || data.answer === lowerKey || data.answer === i) {
                        correctIndex = i;
                    }
                } else {
                    break;
                }
            }
            
            if (options.length > 0) {
                return {
                    question: data.question,
                    options: options,
                    answer: correctIndex >= 0 ? correctIndex : data.answer
                };
            }
        }
        
        // Handle format: { question, A, B, C, D, answer: "A" }
        if (data.question && (data.A || data.a)) {
            const options = [];
            const keys = ['A', 'B', 'C', 'D', 'E', 'F'];
            let correctIndex = -1;
            
            for (let i = 0; i < keys.length; i++) {
                const key = keys[i];
                const lowerKey = key.toLowerCase();
                
                if (data[key] || data[lowerKey]) {
                    const optionValue = data[key] || data[lowerKey];
                    const optionText = String(optionValue);
                    options.push(optionText);
                    
                    if (data.answer === key || data.answer === lowerKey) {
                        correctIndex = i;
                    }
                } else {
                    break;
                }
            }
            
            if (options.length > 0) {
                return {
                    question: data.question,
                    options: options,
                    answer: correctIndex >= 0 ? correctIndex : 0
                };
            }
        }
        
        return null;
    } catch (e) {
        return null;
    }
}

// Helper function to verify answer with AI
async function verifyAnswerWithAI(question, answer) {
    try {
        // More detailed and accurate verification prompt
        const prompt = `Question: "${question}"

Proposed Answer: "${answer}"

Is the proposed answer CORRECT and ACCURATE for this question? 

Consider:
- Is this answer factually correct?
- Does it directly answer the question?
- Is it the best/most accurate answer?

Respond with ONLY one word: "YES" if correct, "NO" if incorrect or inaccurate.`;
        
        broadcastLog(`[AI Checking] Question: "${question.substring(0, 60)}..."`);
        broadcastLog(`[AI Checking] Testing answer: "${answer.substring(0, 60)}..."`);
        
        const chatCompletion = await client.chat.completions.create({
            model: AI_MODEL,
            messages: [{ role: "user", content: prompt }],
            max_tokens: 20,
            temperature: 0.1, // Very low temperature for more consistent/accurate responses
        });

        const aiResponse = chatCompletion.choices[0].message.content.toLowerCase().trim();
        broadcastLog('[Original AI Response - Answer Verification]: ' + chatCompletion.choices[0].message.content);
        broadcastLog(`[AI Response] AI says: "${aiResponse}`);
        
        // Check for various yes/no variations
        const yesVariations = ['yes', 'yeah', 'yep', 'yup', 'correct', 'true', 'right', 'affirmative'];
        const noVariations = ['no', 'nope', 'nah', 'incorrect', 'false', 'wrong', 'negative'];
        
        for (const variation of yesVariations) {
            if (aiResponse.includes(variation)) {
                broadcastLog(`[AI Checking] Result: CORRECT (matched "${variation}")`);
                return true;
            }
        }
        
        for (const variation of noVariations) {
            if (aiResponse.includes(variation)) {
                broadcastLog(`[AI Checking] Result: INCORRECT (matched "${variation}")`);
                return false;
            }
        }
        
        broadcastLog('[AI Checking] Result: UNCERTAIN (defaulting to false)');
        return false;
    } catch (error) {
        broadcastLog('[AI Checking] Error verifying answer with AI: ' + error.message, 'error');
        return false;
    }
}

// Helper function to find correct answer by checking all options
async function findCorrectAnswerWithAI(question, options) {
    broadcastLog(`Verifying all options for question: "${question.substring(0, 60)}..."`);
    
    for (let i = 0; i < options.length; i++) {
        const isCorrect = await verifyAnswerWithAI(question, options[i]);
        broadcastLog(`  Option ${i + 1} (${options[i].substring(0, 40)}...): ${isCorrect ? '✓ CORRECT' : '✗ Wrong'}`);
        
        if (isCorrect) {
            return i;
        }
    }
    
    broadcastLog('  Warning: No correct answer found among all options');
    return -1; // Return -1 to indicate no correct answer found
}

// ============================================================================
// UNIFIED QUESTION GENERATION FUNCTION
// Applies to both singleplayer and multiplayer
// STEP 2 & 3: Generate question and verify answer
// ============================================================================
async function generateAndValidateQuestion(subject, conversationHistory = [], askedQuestions = [], mode = 'singleplayer', targetLanguage = 'en', enableRetryDelay = false) {
    let attempts = 0;
    let isDuplicate = true;
    let isValidJSON = false;
    let correctAnswerIndex = -1;
    let aiResponse = '';
    let parsedData = null;
    
    // Ensure subject is properly capitalized for display
    const displaySubject = subject.charAt(0).toUpperCase() + subject.slice(1).toLowerCase();
    
    // Unlimited retries until we get valid question with correct answer
    while (isDuplicate || !isValidJSON || correctAnswerIndex === -1) {
        attempts++;
        
        // Add 10-second delay before each retry attempt (except first attempt)
        if (enableRetryDelay && attempts > 1) {
            broadcastLog(`[${mode.toUpperCase()}] Attempt ${attempts}: Waiting 10 seconds before retry...`);
            await new Promise(resolve => setTimeout(resolve, 10000));
        }
        
        broadcastLog(`[${mode.toUpperCase()}] Attempt ${attempts}: Generating ${displaySubject} question...`);
        
        const baseMessage = `You MUST generate a multiple choice question ONLY about ${displaySubject}. Do NOT generate questions about other subjects.

Topic: ${displaySubject}
Generate a ${displaySubject.toLowerCase()} multiple choice question with 4 options.

CRITICAL: You MUST respond ONLY in XML format. Do NOT use JSON. Do NOT use any other format.

Required XML structure:
<question>
    <text>Your question here</text>
    <options>
        <option>First option</option>
        <option>Second option</option>
        <option>Third option</option>
        <option>Fourth option</option>
    </options>
    <answer>Index of correct option (0-based)</answer>
</question>

Generate the ${displaySubject} question now using ONLY the XML format above:`;
        
        // Build messages array with conversation history for context
        const messages = [];
        
        // Add conversation history for context (last 10 messages)
        if (conversationHistory && conversationHistory.length > 0) {
            const recentHistory = conversationHistory.slice(-10);
            messages.push(...recentHistory);
        }
        
        // Add instruction to avoid duplicates or fix format if this is a retry
        if (attempts > 1) {
            if (!isValidJSON) {
                messages.push({ 
                    role: "system", 
                    content: `The previous response was invalid. Generate VALID XML format with all tags properly closed. Remember: ONLY about ${displaySubject}.`
                });
            } else if (isDuplicate) {
                messages.push({ 
                    role: "system", 
                    content: `Generate a completely different ${displaySubject} question than before. Stay ONLY within the ${displaySubject} subject but use a different topic or concept.`
                });
            } else if (correctAnswerIndex === -1) {
                messages.push({ 
                    role: "system", 
                    content: `The previous question had no correct answer. Generate a ${displaySubject} question where ONE of the four options is DEFINITELY the correct answer. Make sure it's about ${displaySubject}.`
                });
            }
        }
        
        // Add current question request
        messages.push({ role: "user", content: baseMessage });
        
        try {
            const chatCompletion = await client.chat.completions.create({
                model: AI_MODEL,
                messages: messages,
                max_tokens: 500,
                temperature: Math.min(1.2, 0.7 + (attempts * 0.15)), // Increase temperature on retries
            });

            aiResponse = chatCompletion.choices[0].message.content;
            broadcastLog(`[${mode.toUpperCase()}] Response received, length: ${aiResponse.length}`);
            
            // STEP 1: Parse the XML response
            parsedData = parseQuizJSON(aiResponse);
            
            if (!parsedData) {
                broadcastLog(`[${mode.toUpperCase()}] Attempt ${attempts}: Failed to parse XML`);
                isValidJSON = false;
                isDuplicate = true;
                continue;
            }
            
            // Valid XML!
            isValidJSON = true;
            broadcastLog(`[${mode.toUpperCase()}] Attempt ${attempts}: Valid XML parsed for ${displaySubject}`);
            broadcastLog(`  Question: "${parsedData.question.substring(0, 80)}..."`);
            
            // Check for duplicates (only for multiplayer with askedQuestions)
            if (mode === 'multiplayer' && askedQuestions && askedQuestions.length > 0) {
                const newQuestion = parsedData.question.toLowerCase().trim();
                let maxSimilarity = 0;
                let mostSimilarQuestion = '';
                
                isDuplicate = askedQuestions.some(asked => {
                    const similarity = calculateSimilarity(asked, newQuestion);
                    if (similarity > maxSimilarity) {
                        maxSimilarity = similarity;
                        mostSimilarQuestion = asked;
                    }
                    return similarity > 0.75; // 75% similarity threshold (increased from 50% for stricter duplicate detection)
                });
                
                if (isDuplicate) {
                    broadcastLog(`[${mode.toUpperCase()}] Attempt ${attempts}: Duplicate detected (${(maxSimilarity * 100).toFixed(1)}% similar)`);
                    broadcastLog(`  New: "${newQuestion.substring(0, 60)}..."`);
                    broadcastLog(`  Old: "${mostSimilarQuestion.substring(0, 60)}..."`);
                    continue;
                }
            } else {
                isDuplicate = false; // Singleplayer doesn't check duplicates
            }
            
            broadcastLog(`[${mode.toUpperCase()}] Attempt ${attempts}: Question is valid, verifying answer...`);
            
            // STEP 3: Verify the answer provided in the XML
            // Use the answer index from the XML (AI already decided which is correct)
            correctAnswerIndex = parsedData.answer;
            
            // Just verify that the AI-provided answer is actually correct
            const aiProvidedAnswer = parsedData.options[correctAnswerIndex];
            const isAnswerCorrect = await verifyAnswerWithAI(parsedData.question, aiProvidedAnswer);
            
            broadcastLog(`[${mode.toUpperCase()}] Verifying AI-provided answer: Option ${correctAnswerIndex + 1} ("${aiProvidedAnswer.substring(0, 50)}...")`);
            
            if (!isAnswerCorrect) {
                broadcastLog(`[${mode.toUpperCase()}] Attempt ${attempts}: AI-provided answer is WRONG! Regenerating...`);
                isValidJSON = false;
            } else {
                broadcastLog(`[${mode.toUpperCase()}] Attempt ${attempts}: ✓ Valid ${displaySubject} question with correct answer: Option ${correctAnswerIndex + 1}`);
                
                // STEP 2: Translate parsed question and options AFTER verifying answer is correct
                if (targetLanguage && targetLanguage !== 'en') {
                    broadcastLog(`[${mode.toUpperCase()}] [Translation] Translating verified question to ${targetLanguage}...`);
                    
                    // Transform parsed data into quoted format for translation
                    // Format: "question"|"option1"|"option2"|"option3"|"option4" (using pipe delimiter to avoid conflicts with periods in question text)
                    const combinedText = `"${parsedData.question}"|"${parsedData.options[0]}"|"${parsedData.options[1]}"|"${parsedData.options[2]}"|"${parsedData.options[3]}"`;
                    broadcastLog(`[${mode.toUpperCase()}] [Translation] Combined text: ${combinedText.substring(0, 100)}...`);
                    
                    // Translate the combined text
                    const translatedCombined = await translateText(combinedText, targetLanguage);
                    broadcastLog(`[${mode.toUpperCase()}] [Translation] Translated: ${translatedCombined.substring(0, 100)}...`);
                    
                    // Parse translated text back
                    // Method: Split by pipe delimiter (won't appear in content) and clean up quotes
                    // Format after translation: "question"|"option1"|"option2"|"option3"|"option4"
                    const parts = translatedCombined.split('|').map(part => {
                        // Remove all types of quotes from the beginning and end
                        return part.trim().replace(/^["'"\"\"'?�«‟�??�『「\s]+/, '').replace(/["'"\"\"'?��??�】』」\s]+$/, '');
                    }).filter(part => part.length > 0);
                    
                    broadcastLog(`[${mode.toUpperCase()}] [Translation] Split into ${parts.length} parts`);
                    
                    if (parts.length === 5) {
                        // Successfully extracted all 5 parts
                        const translatedQuestion = parts[0];
                        const translatedOptions = parts.slice(1, 5);
                        
                        // Update parsedData with translated content
                        parsedData.question = translatedQuestion;
                        parsedData.options = translatedOptions;
                        
                        broadcastLog(`[${mode.toUpperCase()}] [Translation] ✓ Successfully translated`);
                        broadcastLog(`[${mode.toUpperCase()}] [Translation] Translated question: "${translatedQuestion.substring(0, 80)}..."`);
                        broadcastLog(`[${mode.toUpperCase()}] [Translation] Translated options: ${translatedOptions.slice(0, 2).join(' | ')}...`);
                    } else {
                        broadcastLog(`[${mode.toUpperCase()}] [Translation] Could only extract ${parts.length} parts (expected 5), keeping original`, 'warn');
                    }
                }
                
                // Store the question in askedQuestions for multiplayer
                if (mode === 'multiplayer' && askedQuestions) {
                    askedQuestions.push(parsedData.question);
                    broadcastLog(`  Total questions in round: ${askedQuestions.length}`);
                }
            }
        } catch (error) {
            broadcastLog(`[${mode.toUpperCase()}] Error generating question: ${error.message}`, 'error');
            isValidJSON = false;
        }
    }
    
    // Reconstruct XML with potentially translated content
    let finalXML = aiResponse;
    if (targetLanguage && targetLanguage !== 'en' && parsedData) {
        finalXML = `<question>
    <text>${parsedData.question}</text>
    <options>
        <option>${parsedData.options[0]}</option>
        <option>${parsedData.options[1]}</option>
        <option>${parsedData.options[2]}</option>
        <option>${parsedData.options[3]}</option>
    </options>
    <answer>${parsedData.answer}</answer>
</question>`;
    }
    
    // Return the generated question with validated answer
    return {
        aiResponse: finalXML,
        parsedData: parsedData,
        correctAnswerIndex: correctAnswerIndex,
        attempts: attempts
    };
}

// Helper function to calculate text similarity using Levenshtein distance
function calculateSimilarity(str1, str2) {
    if (!str1 || !str2) return 0;
    
    // Normalize strings - keep alphanumeric (including Unicode) and spaces
    // Remove only punctuation and special symbols, keep Chinese characters
    const normalize = (s) => s.toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, '') // Keep Unicode letters, numbers, and spaces
        .replace(/\s+/g, ' ')              // Normalize multiple spaces to single space
        .trim();
    
    const s1 = normalize(str1);
    const s2 = normalize(str2);
    
    // If either string is empty after normalization, return 0 (no similarity)
    if (!s1 || !s2) return 0;
    
    // Check exact match first
    if (s1 === s2) return 1.0;
    
    // Calculate Levenshtein distance (edit distance)
    const levenshteinDistance = (a, b) => {
        const matrix = [];
        
        for (let i = 0; i <= b.length; i++) {
            matrix[i] = [i];
        }
        
        for (let j = 0; j <= a.length; j++) {
            matrix[0][j] = j;
        }
        
        for (let i = 1; i <= b.length; i++) {
            for (let j = 1; j <= a.length; j++) {
                if (b.charAt(i - 1) === a.charAt(j - 1)) {
                    matrix[i][j] = matrix[i - 1][j - 1];
                } else {
                    matrix[i][j] = Math.min(
                        matrix[i - 1][j - 1] + 1, // substitution
                        matrix[i][j - 1] + 1,     // insertion
                        matrix[i - 1][j] + 1      // deletion
                    );
                }
            }
        }
        
        return matrix[b.length][a.length];
    };
    
    const distance = levenshteinDistance(s1, s2);
    const maxLength = Math.max(s1.length, s2.length);
    
    // Convert distance to similarity (0 to 1)
    // Similarity = 1 - (distance / maxLength)
    const similarity = 1 - (distance / maxLength);
    
    broadcastLog(`[Similarity Debug] S1 vs S2: distance=${distance}, similarity=${similarity.toFixed(3)}`);
    
    return Math.max(0, Math.min(1, similarity));
}

io.on('connection', (socket) => {
        // Collab mode: handle wrong answer and set game over
        socket.on('collabWrongAnswer', ({ roomCode, playerName, selectedIndex }) => {
            const room = rooms.get(roomCode);
            if (!room || room.mode !== 'collab') return;
            // Mark game as over
            room.gameOver = true;
            // Optionally clear timers
            if (room.answerTimer) {
                clearTimeout(room.answerTimer);
                room.answerTimer = null;
            }
            // Broadcast to all players (UI already handled on client)
            io.to(roomCode).emit('collabWrongAnswer', { playerName, selectedIndex });
            broadcastLog(`[Collab] Game over in room ${roomCode} due to wrong answer by ${playerName}`);
        });
    
    // Handle disconnect
    socket.once('disconnect', () => {
        // Clean up player rooms
    });
    
    broadcastLog('Player connected: ' + socket.id);

    // Create or join room
    socket.on('createRoom', ({ playerName, mode, subject }) => {
        const roomCode = generateRoomCode();
        rooms.set(roomCode, {
            players: [{ id: socket.id, name: playerName, score: 0 }],
            hostId: socket.id, // Track the host (room creator)
            currentQuestion: null,
            correctAnswer: null,
            mode: mode, // 'collab' or 'compete'
            subject: subject,
            answers: new Map(), // playerId -> answer
            answerTimer: null,
            conversationHistory: [], // Track Q&A for AI memory
            askedQuestions: [], // Track asked questions to prevent duplicates
            isGameActive: false, // Track if a game round is currently playing
            gameState: null, // Store game state for syncing joining players
            currentLevel: 0 // Track current question level (0-11)
        });
        playerRooms.set(socket.id, roomCode);
        socket.join(roomCode);
        
        socket.emit('roomCreated', { roomCode, playerName });
        broadcastLog(`Room ${roomCode} created by ${playerName}`);
    });

    socket.on('joinRoom', ({ roomCode, playerName }) => {
        const room = rooms.get(roomCode);
        if (!room) {
            socket.emit('error', { message: 'Room not found' });
            return;
        }

        room.players.push({ id: socket.id, name: playerName, score: 0 });
        playerRooms.set(socket.id, roomCode);
        socket.join(roomCode);

        // Notify all players (including the one joining) with current room state
        io.to(roomCode).emit('playerJoined', {
            playerName,
            players: room.players,
            subject: room.subject // Include current subject selection
        });
        
        // If a game round is currently active, sync the joining player with current game state
        if (room.isGameActive && room.gameState) {
            broadcastLog(`${playerName} joined during active game, syncing game state`);
            socket.emit('syncGameState', room.gameState);
        }
        
        broadcastLog(`${playerName} joined room ${roomCode}`);
    });

    // Request new question
    // Request new question - uses UNIFIED QUESTION GENERATION FUNCTION
    socket.on('requestQuestion', async ({ roomCode, conversationHistory }) => {
        const room = rooms.get(roomCode);
        if (!room || room.gameOver) return;

        try {
            // Update room conversation history if provided
            if (conversationHistory && Array.isArray(conversationHistory)) {
                room.conversationHistory = conversationHistory;
            }
            
            broadcastLog(`[MULTIPLAYER] STEP 2-3: Requesting new question for room ${roomCode}`);
            
            // Use unified function to generate and validate question with 10-second retry delay
            const result = await generateAndValidateQuestion(
                room.subject,
                room.conversationHistory,
                room.askedQuestions,
                'multiplayer',
                'en', // Default language
                true // Enable 10-second retry delay
            );
            
            if (!result.parsedData || result.correctAnswerIndex === -1) {
                broadcastLog('[MULTIPLAYER] Failed to generate valid question after multiple attempts', 'error');
                socket.emit('error', { message: 'Failed to generate question' });
                return;
            }
            
            broadcastLog(`[MULTIPLAYER] STEP 5: Valid question ready (after ${result.attempts} attempts)`);
            
            // Store the parsed data for answer verification later
            room.currentQuestion = result.aiResponse;
            room.parsedQuestionData = result.parsedData;
            room.correctAnswer = result.correctAnswerIndex;
            room.answers.clear();
            room.questionStartTime = Date.now(); // Track when question was sent
            
            // Store game state for new players joining during active round
            room.gameState = {
                currentQuestion: result.aiResponse,
                parsedQuestionData: result.parsedData,
                correctAnswer: result.correctAnswerIndex,
                currentLevelSynced: room.currentLevel,
                mode: room.mode,
                subject: room.subject,
                subjectTitle: room.subjectTitle || room.subject,
                questionStartTime: room.questionStartTime, // Track question send time
                timerDuration: 30 // Timer duration in seconds
            };
            
            // Emit question to all players
            broadcastLog('Emitting question to all players');
            io.to(roomCode).emit('newQuestion', { question: result.aiResponse });
            
            // STEP 6: Timer will start when client emits 'questionReady' after rendering buttons
        } catch (error) {
            broadcastLog('[MULTIPLAYER] Error generating question: ' + error.message, 'error');
            socket.emit('error', { message: 'Failed to generate question' });
        }
    });

    // Set subject (real-time sync) - ANYONE can change subject
    socket.on('setSubject', ({ roomCode, subject, subjectTitle }) => {
        const room = rooms.get(roomCode);
        if (!room) return;

        const player = room.players.find(p => p.id === socket.id);
        if (!player) return;

        room.subject = subject;

        // Notify all other players in the room - subject can be changed by anyone
        socket.to(roomCode).emit('subjectChanged', {
            subject,
            subjectTitle,
            playerName: player.name
        });
    });

    // Start game (broadcast to all players) - ONLY HOST CAN START
    socket.on('startGame', async ({ roomCode }) => {
        broadcastLog('startGame event received for room:', roomCode);
        const room = rooms.get(roomCode);
        if (!room) {
            broadcastLog('Room not found:', roomCode);
            socket.emit('error', { message: 'Room not found' });
            return;
        }

        const player = room.players.find(p => p.id === socket.id);
        if (!player) {
            broadcastLog('Player not found in room');
            return;
        }
        
        // Check if this player is the host
        if (socket.id !== room.hostId) {
            broadcastLog(`Player ${player.name} tried to start game but is not the host`);
            socket.emit('error', { message: 'Only the host can start the game' });
            return;
        }
        
        if (!room.subject) {
            broadcastLog('No subject selected');
            socket.emit('error', { message: 'Please select a subject first' });
            return;
        }
        
        // Mark game as active
        room.isGameActive = true;

        broadcastLog(`Starting game for room ${roomCode}, subject: ${room.subject}`);
        
        // Clear previous game data
        room.askedQuestions = []; // Reset asked questions for new game
        room.conversationHistory = []; // Reset conversation history
        
        // Notify all players to start the game
        io.to(roomCode).emit('gameStarted', {
            subject: room.subject,
            mode: room.mode,
            startedBy: player.name
        });

        // In collab mode, don't generate first question automatically
        // Question will be generated when client requests it after level progress screen
        if (room.mode === 'collab') {
            broadcastLog('Collab mode: Skipping automatic first question generation');
            return;
        }

        // In compete mode, generate first question immediately using UNIFIED FUNCTION
        broadcastLog('[MULTIPLAYER] STEP 1-3: Starting game and generating first question for compete mode');
        
        try {
            // Use unified function to generate and validate first question with 10-second retry delay
            const result = await generateAndValidateQuestion(
                room.subject,
                [], // No conversation history yet
                room.askedQuestions,
                'multiplayer',
                'en', // Default language
                true // Enable 10-second retry delay
            );
            
            if (!result.parsedData || result.correctAnswerIndex === -1) {
                broadcastLog('[MULTIPLAYER] Failed to generate first question after multiple attempts');
                socket.emit('error', { message: 'Failed to generate first question' });
                return;
            }
            
            broadcastLog(`[MULTIPLAYER] STEP 5: First question ready (after ${result.attempts} attempts)`);
            
            // Store question data in room
            room.currentQuestion = result.aiResponse;
            room.parsedQuestionData = result.parsedData;
            room.correctAnswer = result.correctAnswerIndex;
            room.answers.clear();
            room.questionStartTime = Date.now(); // Track when question was sent
            
            // Store game state for new players joining during active round
            room.gameState = {
                currentQuestion: result.aiResponse,
                parsedQuestionData: result.parsedData,
                correctAnswer: result.correctAnswerIndex,
                currentLevelSynced: room.currentLevel,
                mode: room.mode,
                subject: room.subject,
                subjectTitle: room.subjectTitle || room.subject,
                questionStartTime: room.questionStartTime, // Track question send time
                timerDuration: 30 // Timer duration in seconds
            };
            
            // Emit the first question to all players
            io.to(roomCode).emit('newQuestion', { question: room.currentQuestion });
            
            // STEP 6: Timer will start when client emits 'questionReady' after rendering buttons
        } catch (error) {
            broadcastLog('[MULTIPLAYER] Error generating first question:', error);
            socket.emit('error', { message: 'Failed to generate question' });
        }
    });

    // Client confirms question UI is ready (buttons rendered)
    socket.on('questionReady', ({ roomCode }) => {
        const room = rooms.get(roomCode);
        if (!room || room.gameOver) return;

        // Clear any existing timer
        if (room.answerTimer) {
            clearTimeout(room.answerTimer);
        }
        
        broadcastLog('[Timer] Question UI ready, starting 30-second timer');
        // Start 30-second timer now that buttons are clickable
        room.answerTimer = setTimeout(async () => {
            broadcastLog('[Timer] Time expired! Checking answers with AI...');
            
            // Signal all clients to stop visual timer
            io.to(roomCode).emit('stopTimer');
            
            // Only process if not all players have answered (which would have been handled already)
            if (room.answers.size < room.players.length) {
                // Show AI checking overlay to all players
                io.to(roomCode).emit('aiCheckingStart');
                
                let correctAnswerToUse = -1;
                
                // Check if current subject is Cantonese - skip verification and mark all answers as correct
                if (room.subject === '粵語') {
                    broadcastLog('[Timer] Cantonese category detected - skipping verification');
                    // For Cantonese, mark the first answer received as correct (or first player's answer if no answers yet)
                    if (room.answers.size > 0) {
                        const firstAnswer = Array.from(room.answers.values())[0];
                        correctAnswerToUse = firstAnswer.selectedIndex;
                    } else {
                        correctAnswerToUse = 0; // Default to first option if no answers
                    }
                } else {
                    // Use AI-verified answer from question generation (no additional AI call needed)
                    if (room.parsedQuestionData) {
                        correctAnswerToUse = room.parsedQuestionData.answer;
                        // If all options are wrong, default to first option
                        if (correctAnswerToUse === -1) {
                            broadcastLog('[Timer] Warning: All options are wrong, defaulting to option 0');
                            correctAnswerToUse = 0;
                        }
                    }
                }
                
                room.correctAnswer = correctAnswerToUse;
                
                // Calculate isCorrect for each answer and update scores
                const playerAnswers = Array.from(room.answers.values()).map(a => {
                    const isCorrect = a.selectedIndex === room.correctAnswer;
                    a.isCorrect = isCorrect;
                    
                    // Update player scores
                    if (isCorrect) {
                        if (room.mode === 'collab') {
                            // In collab, all players get the point
                            room.players.forEach(p => p.score += 1);
                        } else if (room.mode === 'compete') {
                            // In compete, only correct player gets point
                            const player = room.players.find(p => p.name === a.playerName);
                            if (player) {
                                player.score += 1;
                            }
                        }
                    }
                    
                    return {
                        playerName: a.playerName,
                        selectedIndex: a.selectedIndex,
                        isCorrect: isCorrect
                    };
                });
                
                // Include all players, even those who didn't answer
                const allPlayerAnswers = room.players.map(player => {
                    const answer = Array.from(room.answers.values()).find(a => a.playerName === player.name);
                    return {
                        playerName: player.name,
                        selectedIndex: answer ? answer.selectedIndex : null,
                        isCorrect: answer ? answer.isCorrect : false
                    };
                });
                
                io.to(roomCode).emit('revealAnswers', {
                    correctAnswer: room.correctAnswer,
                    playerAnswers: allPlayerAnswers,
                    scores: room.players.map(p => ({ name: p.name, score: p.score }))
                });
                
                setTimeout(() => {
                    if (rooms.has(roomCode)) {
                        room.answers.clear();
                    }
                }, 3000);
            }
        }, 30000); // 30 seconds
    });

    // Submit answer
    socket.on('submitAnswer', async ({ roomCode, answer }) => {
        broadcastLog('submitAnswer received:', { roomCode, answer, socketId: socket.id });
        const room = rooms.get(roomCode);
        if (!room) {
            broadcastLog('Room not found:', roomCode);
            return;
        }

        const player = room.players.find(p => p.id === socket.id);
        if (!player) {
            broadcastLog('Player not found in room');
            return;
        }

        // Store answer without isCorrect - will be determined after AI verification
        room.answers.set(socket.id, { answer, playerName: player.name, selectedIndex: answer });
        broadcastLog(`Player ${player.name} answered. Total answers: ${room.answers.size}/${room.players.length}`);

        // In collab mode, reveal immediately when first player answers
        if (room.mode === 'collab' && room.answers.size === 1) {
            broadcastLog('Collab mode: First answer received, syncing selection');
            
            // Broadcast the selection to all other players
            socket.to(roomCode).emit('collabAnswerSelected', {
                playerName: player.name,
                selectedIndex: answer
            });
            
            // Stop the timer
            broadcastLog('[Timer] Stopping timer - all players answered in collab mode');
            if (room.answerTimer) {
                clearTimeout(room.answerTimer);
                room.answerTimer = null;
            }
            
            // Show AI checking overlay to all players
            io.to(roomCode).emit('aiCheckingStart');
            
            // Use AI-verified answer from question generation (no additional AI call needed)
            broadcastLog('[AI Verification] Using pre-verified answer from question generation...');
            
            let correctAnswerToUse = -1;
            
            // Check if current subject is Cantonese - skip verification and use selected answer as correct
            if (room.subject === '粵語') {
                broadcastLog('[AI Verification] Cantonese category detected - skipping verification, marking answer as correct');
                correctAnswerToUse = answer;
            } else if (room.parsedQuestionData) {
                correctAnswerToUse = room.parsedQuestionData.answer;
            }
            
            room.correctAnswer = correctAnswerToUse;
            
            // Calculate isCorrect for each answer and update scores
            const playerAnswers = Array.from(room.answers.values()).map(a => {
                const isCorrect = a.selectedIndex === room.correctAnswer;
                a.isCorrect = isCorrect;
                
                // Update player score in collab mode (all get point if any correct)
                if (isCorrect) {
                    room.players.forEach(p => p.score += 1);
                }
                
                return {
                    playerName: a.playerName,
                    selectedIndex: a.selectedIndex,
                    isCorrect: isCorrect
                };
            });
            
            io.to(roomCode).emit('revealAnswers', {
                correctAnswer: room.correctAnswer,
                playerAnswers: playerAnswers,
                scores: room.players.map(p => ({ name: p.name, score: p.score }))
            });
            
            // Clear answers for next question
            setTimeout(() => {
                if (rooms.has(roomCode)) {
                    room.answers.clear();
                }
            }, 3000);
            
            return; // Don't continue to the compete mode logic
        }

        // Notify all players that someone answered (without revealing correctness)
        io.to(roomCode).emit('answerSubmitted', {
            playerName: player.name,
            selectedOption: answer,
            totalAnswers: room.answers.size,
            totalPlayers: room.players.length
        });
        
        // Check if all players have answered (compete mode)
        if (room.answers.size === room.players.length) {
            broadcastLog('All players answered!');
            // Stop the timer since all answered
            broadcastLog('[Timer] Stopping timer - all players answered');
            if (room.answerTimer) {
                clearTimeout(room.answerTimer);
                room.answerTimer = null;
            }
            
            // Signal all clients to stop visual timer
            io.to(roomCode).emit('stopTimer');
            
            // Show AI checking overlay to all players
            io.to(roomCode).emit('aiCheckingStart');
            
            // Use AI-verified answer from question generation (no additional AI call needed)
            broadcastLog('[AI Verification] Using pre-verified answer from question generation...');
            if (room.parsedQuestionData) {
                room.correctAnswer = room.parsedQuestionData.answer;
                // If all options are wrong, default to first option
                if (room.correctAnswer === -1) {
                    broadcastLog('[Compete] Warning: All options are wrong, defaulting to option 0');
                    room.correctAnswer = 0;
                }
            }
            
            // Calculate isCorrect for each answer and update scores
            const playerAnswers = Array.from(room.answers.values()).map(a => {
                const isCorrect = a.selectedIndex === room.correctAnswer;
                a.isCorrect = isCorrect;
                
                // Update player score in compete mode (individual scoring)
                if (isCorrect && room.mode === 'compete') {
                    const player = room.players.find(p => p.name === a.playerName);
                    if (player) {
                        player.score += 1;
                    }
                }
                
                return {
                    playerName: a.playerName,
                    selectedIndex: a.selectedIndex,
                    isCorrect: isCorrect
                };
            });
            
            broadcastLog('Emitting revealAnswers:', { correctAnswer: room.correctAnswer, playerAnswers });
            io.to(roomCode).emit('revealAnswers', {
                correctAnswer: room.correctAnswer,
                playerAnswers: playerAnswers,
                scores: room.players.map(p => ({ name: p.name, score: p.score }))
            });
            
            // Set a timer to clear answers for next question
            setTimeout(() => {
                if (rooms.has(roomCode)) {
                    room.answers.clear();
                }
            }, 3000);
        }
    });

    // Player clicked continue button - ONLY HOST CAN CONTINUE
    socket.on('playerContinue', ({ roomCode, action, scores }) => {
        const room = rooms.get(roomCode);
        if (!room) return;

        const player = room.players.find(p => p.id === socket.id);
        if (!player) return;
        
        // Check if this player is the host
        if (socket.id !== room.hostId) {
            broadcastLog(`Player ${player.name} tried to continue but is not the host`);
            socket.emit('error', { message: 'Only the host can click continue' });
            return;
        }

        broadcastLog(`${player.name} (host) clicked continue with action: ${action}`);
        
        // Increment level for level/nextQuestion actions
        if (action === 'levelScreen' || action === 'nextQuestion' || action === 'continueLevelScreen') {
            room.currentLevel++;
            broadcastLog(`[MULTIPLAYER] Level incremented to ${room.currentLevel}`);
        }
        
        // Broadcast to all OTHER players in the room (sender already handled locally)
        // This ensures proper sync when any player clicks continue
        socket.to(roomCode).emit('playerContinued', {
            action: action,
            playerName: player.name,
            scores: scores // Pass scores data if showing score screen
        });
    });

    // Disconnect handling
    socket.on('disconnect', () => {
        const roomCode = playerRooms.get(socket.id);
        if (roomCode) {
            const room = rooms.get(roomCode);
            if (room) {
                room.players = room.players.filter(p => p.id !== socket.id);
                
                if (room.players.length === 0) {
                    // Clear any timers before deleting room
                    if (room.answerTimer) {
                        clearTimeout(room.answerTimer);
                    }
                    rooms.delete(roomCode);
                    broadcastLog(`Room ${roomCode} deleted (empty)`);
                } else {
                    io.to(roomCode).emit('playerLeft', {
                        players: room.players
                    });
                }
            }
            playerRooms.delete(socket.id);
        }
        broadcastLog('Player disconnected:', socket.id);
    });
});

// Function to verify AI model at startup
async function verifyAIModel() {
    try {
        broadcastLog('Model checking');
        const testCompletion = await client.chat.completions.create({
            model: AI_MODEL,
            messages: [{ role: "user", content: "test" }],
            max_tokens: 10,
        });
        
        const modelUsed = testCompletion.model;
        broadcastLog(`✓ AI Model verified: ${modelUsed}`);
        return modelUsed;
    } catch (error) {
        broadcastLog(`✗ Failed to verify AI model: ${error.message}`, 'error');
        return null;
    }
}

httpServer.listen(PORT, '0.0.0.0', async () => {
    broadcastLog(`Server running on port ${PORT}`);
    broadcastLog('');

    await verifyAIModel();
});
