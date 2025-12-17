import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { OpenAI } from 'openai';
import { createServer } from 'http';
import { Server } from 'socket.io';

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

// Generate room code
function generateRoomCode() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// AI API using Hugging Face via OpenAI SDK
app.post('/chat', async (req, res) => {
    try {
        const { message } = req.body;
        
        console.log('[Message Received]:', message);
        
        if (!message) {
            return res.status(400).json({ error: 'Message is required' });
        }

        const HF_API_KEY = process.env.HF_API_KEY;
        
        if (!HF_API_KEY) {
            return res.status(500).json({ 
                error: 'API key not configured. Please add HF_API_KEY to .env file' 
            });
        }
        
        // Using Llama 3.2 model via Hugging Face router
        console.log('[Game] Generating question...');
        
        const chatCompletion = await client.chat.completions.create({
            model: AI_MODEL,
            messages: [
                {
                    role: "user",
                    content: message,
                },
            ],
            max_tokens: 500,
            temperature: 0.7,
        });

        const aiResponse = chatCompletion.choices[0].message.content;
        console.log('[Original AI Response - Singleplayer]:', aiResponse);
        console.log('[Response Length]:', aiResponse.length);
        
        // Parse and log the question
        const parsedData = parseQuizJSON(aiResponse);
        if (parsedData) {
            console.log('[Game] Question generated:', parsedData.question);
            console.log('[Game] Response length:', aiResponse?.length || 0);
            
            // Verify correct answer with AI (check all options one by one)
            console.log('[Game] Verifying correct answer with AI...');
            const correctAnswerIndex = await findCorrectAnswerWithAI(parsedData.question, parsedData.options);
            parsedData.answer = correctAnswerIndex;
            console.log(`[Game] AI determined correct answer: Option ${correctAnswerIndex + 1}`);
            
            // Return both the raw response and parsed data with verified answer
            res.json({ 
                response: aiResponse,
                correctAnswer: correctAnswerIndex 
            });
        } else {
            console.log('[Game] Warning: Could not parse JSON from response');
            console.log('[Game] Response length:', aiResponse?.length || 0);
            console.log('[Game] Response preview:', aiResponse.substring(0, 200));
            
            res.json({ response: aiResponse });
        }

    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ 
            error: 'Failed to get AI response',
            details: error.message 
        });
    }
});

// WebSocket connection handling
// Helper function to parse quiz JSON (matches client-side logic)
function parseQuizJSON(text) {
    try {
        console.log('[Original AI Response]:', text);
        console.log('[Response Length]:', text.length);
        
        let jsonText = null;
        
        // First, check for XML format
        const xmlMatch = text.match(/<question>[\s\S]*?<\/question>/);
        if (xmlMatch) {
            console.log('[XML Format Detected] Parsing XML format...');
            const xmlText = xmlMatch[0];
            console.log('[XML Content]:', xmlText);
            
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
                console.log('[XML Parsed Successfully]:', { question: question.substring(0, 60) + '...', optionsCount: options.length, answer });
                return {
                    question: question,
                    options: options,
                    answer: answer
                };
            } else {
                console.log('[XML Parse Failed] Missing question or options');
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
                console.log('No JSON found in response');
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
            console.log('Detected malformed options array format, fixing...');
            
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
                console.log('Fixed options array format');
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
            console.log('First parse attempt failed:', e.message);
            console.log('JSON text causing error:', jsonText.substring(0, 300));
            // Additional cleanup for Python-style syntax
            jsonText = jsonText.replace(/'/g, '"'); // Replace single quotes with double quotes
            try {
                data = JSON.parse(jsonText);
            } catch (e2) {
                console.log('Second parse attempt also failed:', e2.message);
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
        const prompt = `Is "${question}" answer is "${answer}". Only answer yes or no with no additional text`;
        
        console.log(`[AI Checking] Question: "${question.substring(0, 60)}..."`);        console.log(`[AI Checking] Testing answer: "${answer.substring(0, 60)}..."`);        
        const chatCompletion = await client.chat.completions.create({
            model: AI_MODEL,
            messages: [{ role: "user", content: prompt }],
            max_tokens: 10,
            temperature: 0.3,
        });

        const aiResponse = chatCompletion.choices[0].message.content.toLowerCase().trim();        console.log('[Original AI Response - Answer Verification]:', aiResponse);        
        console.log(`[AI Response] AI says: "${aiResponse}"`);        
        // Check for various yes/no variations
        const yesVariations = ['yes', 'yeah', 'yep', 'yup', 'correct', 'true', 'right', 'affirmative'];
        const noVariations = ['no', 'nope', 'nah', 'incorrect', 'false', 'wrong', 'negative'];
        
        for (const variation of yesVariations) {
            if (aiResponse.includes(variation)) {
                console.log(`[AI Checking] Result: CORRECT (matched "${variation}")`);                return true;
            }
        }
        
        for (const variation of noVariations) {
            if (aiResponse.includes(variation)) {
                console.log(`[AI Checking] Result: INCORRECT (matched "${variation}")`);                return false;
            }
        }
        
        console.log('[AI Checking] Result: UNCERTAIN (defaulting to false)');        return false;
    } catch (error) {
        console.error('[AI Checking] Error verifying answer with AI:', error);
        return false;
    }
}

// Helper function to find correct answer by checking all options
async function findCorrectAnswerWithAI(question, options) {
    console.log(`Verifying all options for question: "${question.substring(0, 60)}..."`);
    
    for (let i = 0; i < options.length; i++) {
        const isCorrect = await verifyAnswerWithAI(question, options[i]);
        console.log(`  Option ${i + 1} (${options[i].substring(0, 40)}...): ${isCorrect ? '✓ CORRECT' : '✗ Wrong'}`);
        
        if (isCorrect) {
            return i;
        }
    }
    
    console.log('  Warning: No correct answer found, defaulting to option 0');
    return 0; // Default to first option if none verified as correct
}

// Helper function to calculate text similarity
function calculateSimilarity(str1, str2) {
    if (!str1 || !str2) return 0;
    
    // Normalize strings
    const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
    const s1 = normalize(str1);
    const s2 = normalize(str2);
    
    // Check exact match first
    if (s1 === s2) return 1.0;
    
    // Word-based similarity check
    const words1 = s1.split(/\s+/).filter(w => w.length > 2);
    const words2 = s2.split(/\s+/).filter(w => w.length > 2);
    
    if (words1.length === 0 || words2.length === 0) return 0;
    
    // Calculate Jaccard similarity (intersection over union)
    const set1 = new Set(words1);
    const set2 = new Set(words2);
    const intersection = [...set1].filter(w => set2.has(w)).length;
    const union = new Set([...set1, ...set2]).size;
    
    return union > 0 ? intersection / union : 0;
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
            console.log(`[Collab] Game over in room ${roomCode} due to wrong answer by ${playerName}`);
        });
    console.log('Player connected:', socket.id);

    // Create or join room
    socket.on('createRoom', ({ playerName, mode, subject }) => {
        const roomCode = generateRoomCode();
        rooms.set(roomCode, {
            players: [{ id: socket.id, name: playerName, score: 0 }],
            currentQuestion: null,
            correctAnswer: null,
            mode: mode, // 'collab' or 'compete'
            subject: subject,
            answers: new Map(), // playerId -> answer
            answerTimer: null,
            conversationHistory: [], // Track Q&A for AI memory
            askedQuestions: [] // Track asked questions to prevent duplicates
        });
        playerRooms.set(socket.id, roomCode);
        socket.join(roomCode);
        
        socket.emit('roomCreated', { roomCode, playerName });
        console.log(`Room ${roomCode} created by ${playerName}`);
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

        io.to(roomCode).emit('playerJoined', {
            playerName,
            players: room.players
        });
        console.log(`${playerName} joined room ${roomCode}`);
    });

    // Request new question
    socket.on('requestQuestion', async ({ roomCode, conversationHistory }) => {
        const room = rooms.get(roomCode);
        if (!room || room.gameOver) return;

        try {
            // Update room conversation history if provided
            if (conversationHistory && Array.isArray(conversationHistory)) {
                room.conversationHistory = conversationHistory;
            }
            
            let attempts = 0;
            let isDuplicate = true;
            let aiResponse = '';
            let isValidJSON = false;
            
            // Try up to 5 times to get a unique, valid question
            while ((isDuplicate || !isValidJSON) && attempts < 5) {
                attempts++;
                
                const baseMessage = `Generate a ${room.subject.toLowerCase()} multiple choice question with 4 options.

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
</question>

Generate the question now using ONLY the XML format above:`;
                
                // Build messages array with conversation history for context
                const messages = [];
                
                // Add conversation history for context (last 5 Q&A pairs to avoid token limits)
                if (room.conversationHistory.length > 0) {
                    const recentHistory = room.conversationHistory.slice(-10); // Last 10 messages (5 Q&A pairs)
                    messages.push(...recentHistory);
                }
                
                // Add instruction to avoid duplicates or fix format if this is a retry
                if (attempts > 1) {
                    if (!isValidJSON) {
                        messages.push({ 
                            role: "system", 
                            content: "The previous response was invalid. Generate VALID XML format with all tags properly closed."
                        });
                    } else {
                        messages.push({ 
                            role: "system", 
                            content: "Generate a completely different question than before. Avoid similar topics or phrasing."
                        });
                    }
                }
                
                // Add current question request
                messages.push({ role: "user", content: baseMessage });

                const chatCompletion = await client.chat.completions.create({
                    model: AI_MODEL,
                    messages: messages,
                    max_tokens: 500,
                    temperature: 0.7 + (attempts * 0.1), // Increase temperature on retries for more variation
                });

                aiResponse = chatCompletion.choices[0].message.content;
                console.log(`[Original AI Response - Multiplayer Q${attempts}]:`, aiResponse);
                console.log('[Response Length]:', aiResponse.length);
                
                // Use shared parsing function that handles multiple JSON formats
                const parsedData = parseQuizJSON(aiResponse);
                
                if (!parsedData) {
                    isValidJSON = false;
                    continue;
                }
                
                // Valid JSON!
                isValidJSON = true;
                const newQuestion = parsedData.question.toLowerCase().trim();
                
                // Check if this question was asked before
                let maxSimilarity = 0;
                let mostSimilarQuestion = '';
                
                isDuplicate = room.askedQuestions.some(asked => {
                    const similarity = calculateSimilarity(asked, newQuestion);
                    if (similarity > maxSimilarity) {
                        maxSimilarity = similarity;
                        mostSimilarQuestion = asked;
                    }
                    return similarity > 0.5; // 50% similarity threshold (stricter)
                });
                
                if (!isDuplicate) {
                    // Store the question text and parsed data for later verification
                    room.askedQuestions.push(parsedData.question);
                    room.parsedQuestionData = parsedData; // Store for AI verification later
                    console.log(`✓ Attempt ${attempts}: Unique question accepted (max similarity: ${(maxSimilarity * 100).toFixed(1)}%)`);
                    console.log(`  Total questions in round: ${room.askedQuestions.length}`);
                } else {
                    console.log(`✗ Attempt ${attempts}: Duplicate detected (${(maxSimilarity * 100).toFixed(1)}% similar)`);
                    console.log(`  New: "${newQuestion.substring(0, 60)}..."`);
                    console.log(`  Old: "${mostSimilarQuestion.substring(0, 60)}..."`);
                }
            }
            
            if (attempts >= 5) {
                if (!isValidJSON) {
                    console.log('Warning: Could not generate valid question after 5 attempts');
                    console.log('Last response:', aiResponse.substring(0, 200));
                } else if (isDuplicate) {
                    console.log('Warning: Could not generate unique question after 5 attempts, using last attempt');
                }
            }
            
            // Ensure we have a response
            if (!aiResponse || aiResponse.trim().length === 0) {
                console.error('ERROR: AI response is empty!');
                aiResponse = JSON.stringify({
                    question: "Error generating question. Please try again.",
                    options: {A: "Try again", B: "Retry", C: "Refresh", D: "Continue"},
                    answer: "A"
                });
            }
            
            room.currentQuestion = aiResponse;
            room.answers.clear();
            
            console.log('Emitting question, length:', aiResponse?.length || 0);
            io.to(roomCode).emit('newQuestion', { question: aiResponse });
            
            // Timer will start when client emits 'questionReady' after rendering buttons
        } catch (error) {
            console.error('Error generating question:', error);
            socket.emit('error', { message: 'Failed to generate question' });
        }
    });

    // Set subject (real-time sync)
    socket.on('setSubject', ({ roomCode, subject }) => {
        const room = rooms.get(roomCode);
        if (!room) return;

        const player = room.players.find(p => p.id === socket.id);
        if (!player) return;

        room.subject = subject;

        // Notify all other players in the room
        socket.to(roomCode).emit('subjectChanged', {
            subject,
            playerName: player.name
        });
    });

    // Start game (broadcast to all players)
    socket.on('startGame', async ({ roomCode }) => {
        console.log('startGame event received for room:', roomCode);
        const room = rooms.get(roomCode);
        if (!room) {
            console.log('Room not found:', roomCode);
            socket.emit('error', { message: 'Room not found' });
            return;
        }

        const player = room.players.find(p => p.id === socket.id);
        if (!player) {
            console.log('Player not found in room');
            return;
        }
        
        if (!room.subject) {
            console.log('No subject selected');
            socket.emit('error', { message: 'Please select a subject first' });
            return;
        }

        console.log(`Starting game for room ${roomCode}, subject: ${room.subject}`);
        
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
            console.log('Collab mode: Skipping automatic first question generation');
            return;
        }

        // In compete mode, generate first question immediately
        console.log('Compete mode: Generating first question automatically');
        
        // Generate first question with retry for valid JSON
        try {
            let attempts = 0;
            let isValidJSON = false;
            let aiResponse = '';
            
            while (!isValidJSON && attempts < 5) {
                attempts++;
                
                const message = `Generate a ${room.subject.toLowerCase()} multiple choice question with 4 options.

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
</question>

Generate the question now using ONLY the XML format above:`;
                
                const messages = [{ role: "user", content: message }];
                
                // Add instruction to fix JSON if this is a retry
                if (attempts > 1) {
                    messages.unshift({ 
                        role: "system", 
                        content: "The previous response had invalid JSON. Generate VALID JSON with all brackets properly closed."
                    });
                }

                const chatCompletion = await client.chat.completions.create({
                    model: AI_MODEL,
                    messages: messages,
                    max_tokens: 500,
                    temperature: 0.7 + (attempts * 0.1),
                });

                aiResponse = chatCompletion.choices[0].message.content;
                console.log(`[Original AI Response - First Question Attempt ${attempts}]:`, aiResponse);
                console.log('[Response Length]:', aiResponse.length);
                
                // Use shared parsing function
                const parsedData = parseQuizJSON(aiResponse);
                
                if (!parsedData) {
                    console.log(`First question attempt ${attempts}: Failed to parse JSON`);
                    continue;
                }
                
                // Valid JSON!
                isValidJSON = true;
                room.currentQuestion = aiResponse;
                
                // Store first question in askedQuestions and parsed data for later verification
                room.askedQuestions.push(parsedData.question);
                room.parsedQuestionData = parsedData; // Store for AI verification later
                
                console.log(`First question attempt ${attempts}: Valid question generated`);
            }
            
            if (!isValidJSON) {
                console.log('Warning: Could not generate valid JSON for first question after 5 attempts');
            }
            
            room.answers.clear();
            
            // Emit the first question to all players
            io.to(roomCode).emit('newQuestion', { question: room.currentQuestion });
            
            // Timer will start when client emits 'questionReady' after rendering buttons

        } catch (error) {
            console.error('Error generating question:', error);
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
        
        console.log('[Timer] Question UI ready, starting 30-second timer');
        // Start 30-second timer now that buttons are clickable
        room.answerTimer = setTimeout(async () => {
            console.log('[Timer] Time expired! Checking answers with AI...');
            
            // Only process if not all players have answered (which would have been handled already)
            if (room.answers.size < room.players.length) {
                // Show AI checking overlay to all players
                io.to(roomCode).emit('aiCheckingStart');
                
                // Verify correct answer with AI when time runs out
                if (room.parsedQuestionData) {
                    room.correctAnswer = await findCorrectAnswerWithAI(room.parsedQuestionData.question, room.parsedQuestionData.options);
                }
                
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
        console.log('submitAnswer received:', { roomCode, answer, socketId: socket.id });
        const room = rooms.get(roomCode);
        if (!room) {
            console.log('Room not found:', roomCode);
            return;
        }

        const player = room.players.find(p => p.id === socket.id);
        if (!player) {
            console.log('Player not found in room');
            return;
        }

        // Store answer without isCorrect - will be determined after AI verification
        room.answers.set(socket.id, { answer, playerName: player.name, selectedIndex: answer });
        console.log(`Player ${player.name} answered. Total answers: ${room.answers.size}/${room.players.length}`);

        // In collab mode, reveal immediately when first player answers
        if (room.mode === 'collab' && room.answers.size === 1) {
            console.log('Collab mode: First answer received, syncing selection');
            
            // Broadcast the selection to all other players
            socket.to(roomCode).emit('collabAnswerSelected', {
                playerName: player.name,
                selectedIndex: answer
            });
            
            // Stop the timer
            console.log('[Timer] Stopping timer - all players answered in collab mode');
            if (room.answerTimer) {
                clearTimeout(room.answerTimer);
                room.answerTimer = null;
            }
            
            // Show AI checking overlay to all players
            io.to(roomCode).emit('aiCheckingStart');
            
            // Do AI verification now that all players answered
            console.log('[AI Verification] Starting answer verification...');
            if (room.parsedQuestionData) {
                room.correctAnswer = await findCorrectAnswerWithAI(room.parsedQuestionData.question, room.parsedQuestionData.options);
            }
            
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
            console.log('All players answered!');
            // Stop the timer since all answered
            console.log('[Timer] Stopping timer - all players answered');
            if (room.answerTimer) {
                clearTimeout(room.answerTimer);
                room.answerTimer = null;
            }
            
            // Show AI checking overlay to all players
            io.to(roomCode).emit('aiCheckingStart');
            
            // Do AI verification now that all players answered
            console.log('[AI Verification] Starting answer verification...');
            if (room.parsedQuestionData) {
                room.correctAnswer = await findCorrectAnswerWithAI(room.parsedQuestionData.question, room.parsedQuestionData.options);
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
            
            console.log('Emitting revealAnswers:', { correctAnswer: room.correctAnswer, playerAnswers });
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

    // Player clicked continue button
    socket.on('playerContinue', ({ roomCode, action, scores }) => {
        const room = rooms.get(roomCode);
        if (!room) return;

        const player = room.players.find(p => p.id === socket.id);
        if (!player) return;

        console.log(`${player.name} clicked continue with action: ${action}`);
        
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
                    console.log(`Room ${roomCode} deleted (empty)`);
                } else {
                    io.to(roomCode).emit('playerLeft', {
                        players: room.players
                    });
                }
            }
            playerRooms.delete(socket.id);
        }
        console.log('Player disconnected:', socket.id);
    });
});

// Function to verify AI model at startup
async function verifyAIModel() {
    try {
        console.log('Model checking');
        const testCompletion = await client.chat.completions.create({
            model: AI_MODEL,
            messages: [{ role: "user", content: "test" }],
            max_tokens: 10,
        });
        
        const modelUsed = testCompletion.model;
        console.log(`✓ AI Model verified: ${modelUsed}`);
        return modelUsed;
    } catch (error) {
        console.error('✗ Failed to verify AI model:', error.message);
        return null;
    }
}

httpServer.listen(PORT, '0.0.0.0', async () => {
    console.log(`Server running on port ${PORT}`);
    console.log('');
    await verifyAIModel();
});
