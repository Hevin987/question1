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
        console.log('[Singleplayer] Generating question...');
        
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
        
        // Parse and log the question
        const parsedData = parseQuizJSON(aiResponse);
        if (parsedData) {
            console.log('[Singleplayer] Question generated:', parsedData.question);
            console.log('[Singleplayer] Response length:', aiResponse?.length || 0);
        } else {
            console.log('[Singleplayer] Warning: Could not parse JSON from response');
            console.log('[Singleplayer] Response length:', aiResponse?.length || 0);
            console.log('[Singleplayer] Response preview:', aiResponse.substring(0, 200));
        }
        
        res.json({ response: aiResponse });

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
        let jsonText = null;
        
        // First, check for XML format
        const xmlMatch = text.match(/<question>[\s\S]*?<\/question>/);
        if (xmlMatch) {
            console.log('Found XML format, parsing...');
            const xmlText = xmlMatch[0];
            
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
                return {
                    question: question,
                    options: options,
                    answer: answer
                };
            }
        }
        
        // Try to extract JSON from code blocks (```json ... ```)
        const jsonBlockMatch = text.match(/```json\s*([\s\S]*?)```/);
        if (jsonBlockMatch) {
            jsonText = jsonBlockMatch[1].trim();
            console.log('Found JSON in code block');
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
            
            console.log('Parsed array format, options:', options);
            
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
            
            console.log('Parsed object format, options:', options);
            
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
            
            console.log('Parsed flat format, options:', options);
            
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
        
        const chatCompletion = await client.chat.completions.create({
            model: AI_MODEL,
            messages: [{ role: "user", content: prompt }],
            max_tokens: 10,
            temperature: 0.3,
        });

        const aiResponse = chatCompletion.choices[0].message.content.toLowerCase().trim();
        
        // Check for various yes/no variations
        const yesVariations = ['yes', 'yeah', 'yep', 'yup', 'correct', 'true', 'right', 'affirmative'];
        const noVariations = ['no', 'nope', 'nah', 'incorrect', 'false', 'wrong', 'negative'];
        
        for (const variation of yesVariations) {
            if (aiResponse.includes(variation)) {
                return true;
            }
        }
        
        for (const variation of noVariations) {
            if (aiResponse.includes(variation)) {
                return false;
            }
        }
        
        return false;
    } catch (error) {
        console.error('Error verifying answer with AI:', error);
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
        if (!room) return;

        try {
            // Update room conversation history if provided
            if (conversationHistory && Array.isArray(conversationHistory)) {
                room.conversationHistory = conversationHistory;
            }
            
            let attempts = 0;
            let isDuplicate = true;
            let aiResponse = '';
            let isValidJSON = false;
            
            // Try up to 5 times to get a unique, valid JSON question
            while ((isDuplicate || !isValidJSON) && attempts < 5) {
                attempts++;
                
                const baseMessage = `Make a ${room.subject.toLowerCase()} question with 4 MC (Multiple Choice) options in VALID JSON format with only {
                    "question": "...",
                    "options": {"A": "", "B": "", "C": "", "D": ""},
                    "answer": ""
                } format. IMPORTANT: Ensure all brackets are closed properly.`;
                
                // Build messages array with conversation history for context
                const messages = [];
                
                // Add conversation history for context (last 5 Q&A pairs to avoid token limits)
                if (room.conversationHistory.length > 0) {
                    const recentHistory = room.conversationHistory.slice(-10); // Last 10 messages (5 Q&A pairs)
                    messages.push(...recentHistory);
                }
                
                // Add instruction to avoid duplicates or fix JSON if this is a retry
                if (attempts > 1) {
                    if (!isValidJSON) {
                        messages.push({ 
                            role: "system", 
                            content: "The previous response had invalid JSON. Generate VALID JSON with all brackets properly closed."
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
                
                // Use shared parsing function that handles multiple JSON formats
                const parsedData = parseQuizJSON(aiResponse);
                
                if (!parsedData) {
                    console.log(`Attempt ${attempts}: Failed to parse JSON from response`);
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
                    // Store the question text
                    room.askedQuestions.push(parsedData.question);
                    console.log(`✓ Attempt ${attempts}: Unique question accepted (max similarity: ${(maxSimilarity * 100).toFixed(1)}%)`);
                    console.log(`  Total questions in round: ${room.askedQuestions.length}`);
                } else {
                    console.log(`✗ Attempt ${attempts}: Duplicate detected (${(maxSimilarity * 100).toFixed(1)}% similar)`);
                    console.log(`  New: "${newQuestion.substring(0, 60)}..."`);
                    console.log(`  Old: "${mostSimilarQuestion.substring(0, 60)}..."`);
                }
                
                // Verify correct answer with AI by checking all options
                room.correctAnswer = await findCorrectAnswerWithAI(parsedData.question, parsedData.options);
            }
            
            if (attempts >= 5) {
                if (!isValidJSON) {
                    console.log('Warning: Could not generate valid JSON after 5 attempts');
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
            
            // Clear any existing timer
            if (room.answerTimer) {
                clearTimeout(room.answerTimer);
            }
            
            // Set 30-second timer to reveal answers
            room.answerTimer = setTimeout(() => {
                if (room.answers.size > 0 && room.answers.size < room.players.length) {
                    const playerAnswers = Array.from(room.answers.values()).map(a => ({
                        playerName: a.playerName,
                        selectedIndex: a.selectedIndex,
                        isCorrect: a.isCorrect
                    }));
                    
                    io.to(roomCode).emit('revealAnswers', {
                        correctAnswer: room.correctAnswer,
                        playerAnswers: playerAnswers,
                        scores: room.players.map(p => ({ name: p.name, score: p.score }))
                    });
                    
                    setTimeout(() => {
                        if (rooms.has(roomCode)) {
                            room.answers.clear();
                        }
                    }, 3000);
                }
            }, 30000); // 30 seconds
            console.log('Emitting question, length:', aiResponse?.length || 0);            io.to(roomCode).emit('newQuestion', { question: aiResponse });
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

        // Generate first question with retry for valid JSON
        try {
            let attempts = 0;
            let isValidJSON = false;
            let aiResponse = '';
            
            while (!isValidJSON && attempts < 5) {
                attempts++;
                
                const message = `Make a ${room.subject.toLowerCase()} question with 4 MC (Multiple Choice) options in VALID JSON format with only {
                    "question": "...",
                    "options": {"A": "", "B": "", "C": "", "D": ""},
                    "answer": ""
                } format. IMPORTANT: Ensure all brackets are closed properly.`;
                
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
                
                // Use shared parsing function
                const parsedData = parseQuizJSON(aiResponse);
                
                if (!parsedData) {
                    console.log(`First question attempt ${attempts}: Failed to parse JSON`);
                    continue;
                }
                
                // Valid JSON!
                isValidJSON = true;
                room.currentQuestion = aiResponse;
                
                // Store first question in askedQuestions
                room.askedQuestions.push(parsedData.question);
                
                // Verify correct answer with AI by checking all options
                room.correctAnswer = await findCorrectAnswerWithAI(parsedData.question, parsedData.options);
                
                console.log(`First question attempt ${attempts}: Valid question generated`);
            }
            
            if (!isValidJSON) {
                console.log('Warning: Could not generate valid JSON for first question after 5 attempts');
                room.correctAnswer = 0; // Default to first option
            }
            
            room.answers.clear();
            
            // Emit the first question to all players
            io.to(roomCode).emit('newQuestion', { question: room.currentQuestion });
            
            // Clear any existing timer
            if (room.answerTimer) {
                clearTimeout(room.answerTimer);
            }
            
            // Set 30-second timer to reveal answers
            room.answerTimer = setTimeout(() => {
                if (room.answers.size > 0 && room.answers.size < room.players.length) {
                    const playerAnswers = Array.from(room.answers.values()).map(a => ({
                        playerName: a.playerName,
                        selectedIndex: a.selectedIndex,
                        isCorrect: a.isCorrect
                    }));
                    
                    io.to(roomCode).emit('revealAnswers', {
                        correctAnswer: room.correctAnswer,
                        playerAnswers: playerAnswers,
                        scores: room.players.map(p => ({ name: p.name, score: p.score }))
                    });
                    
                    setTimeout(() => {
                        if (rooms.has(roomCode)) {
                            room.answers.clear();
                        }
                    }, 3000);
                }
            }, 30000); // 30 seconds

        } catch (error) {
            console.error('Error generating question:', error);
            socket.emit('error', { message: 'Failed to generate question' });
        }
    });

    // Submit answer
    socket.on('submitAnswer', ({ roomCode, answer, isCorrect }) => {
        console.log('submitAnswer received:', { roomCode, answer, isCorrect, socketId: socket.id });
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

        room.answers.set(socket.id, { answer, isCorrect, playerName: player.name, selectedIndex: answer });
        console.log(`Player ${player.name} answered. Total answers: ${room.answers.size}/${room.players.length}`);


        if (room.mode === 'compete' && isCorrect) {
            player.score += 1;
        }

        // In collab mode, reveal immediately when first player answers
        if (room.mode === 'collab' && room.answers.size === 1) {
            console.log('Collab mode: First answer received, syncing selection and revealing to all players');
            
            // Broadcast the selection to all other players
            socket.to(roomCode).emit('collabAnswerSelected', {
                playerName: player.name,
                selectedIndex: answer
            });
            
            // Clear the timer
            if (room.answerTimer) {
                clearTimeout(room.answerTimer);
                room.answerTimer = null;
            }
            
            // Reveal answer to all players
            const playerAnswers = Array.from(room.answers.values()).map(a => ({
                playerName: a.playerName,
                selectedIndex: a.selectedIndex,
                isCorrect: a.isCorrect
            }));
            
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
            console.log('All players answered! Revealing answers...');
            // Clear the timer since all answered
            if (room.answerTimer) {
                clearTimeout(room.answerTimer);
                room.answerTimer = null;
            }
            
            // Reveal answers to all players
            const playerAnswers = Array.from(room.answers.values()).map(a => ({
                playerName: a.playerName,
                selectedIndex: a.selectedIndex,
                isCorrect: a.isCorrect
            }));
            
            console.log('Emitting revealAnswers:', { correctAnswer: room.correctAnswer, playerAnswers });
            // Get correct answer from the current question
            // This should be stored when the question is generated
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
