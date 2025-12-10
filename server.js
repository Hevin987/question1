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
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('.'));

// Initialize OpenAI client with Hugging Face router
const client = new OpenAI({
    baseURL: "https://router.huggingface.co/v1",
    apiKey: process.env.HF_API_KEY,
});

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
        const chatCompletion = await client.chat.completions.create({
            model: "meta-llama/Llama-3.2-3B-Instruct",
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
            answerTimer: null
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
    socket.on('requestQuestion', async ({ roomCode }) => {
        const room = rooms.get(roomCode);
        if (!room) return;

        try {
            const message = `Make a ${room.subject.toLowerCase()} question with 4 MC (Multiple Choice) options in JSON format with only {
                "question": "...",
                "options": {"A": "", "B": "", "C": "", "D": ""},
                "answer": ""
            } format.`;

            const chatCompletion = await client.chat.completions.create({
                model: "meta-llama/Llama-3.2-3B-Instruct",
                messages: [{ role: "user", content: message }],
                max_tokens: 500,
                temperature: 0.7,
            });

            const aiResponse = chatCompletion.choices[0].message.content;
            room.currentQuestion = aiResponse;
            
            // Try to parse the correct answer from the JSON response
            try {
                const jsonMatch = aiResponse.match(/\{[\s\S]*"question"[\s\S]*\}/);
                if (jsonMatch) {
                    const data = JSON.parse(jsonMatch[0]);
                    // Convert answer letter to index (A=0, B=1, C=2, D=3)
                    if (data.answer) {
                        const answerLetter = data.answer.toUpperCase();
                        room.correctAnswer = answerLetter.charCodeAt(0) - 65; // A=0, B=1, etc.
                    }
                }
            } catch (e) {
                console.log('Could not parse correct answer:', e);
                room.correctAnswer = 0; // Default to first option
            }
            
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

            io.to(roomCode).emit('newQuestion', { question: aiResponse });
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
        // Notify all players to start the game
        io.to(roomCode).emit('gameStarted', {
            subject: room.subject,
            mode: room.mode,
            startedBy: player.name
        });

        // Generate first question
        try {
            const message = `Make a ${room.subject.toLowerCase()} question with 4 MC (Multiple Choice) options in JSON format with only {
                "question": "...",
                "options": {"A": "", "B": "", "C": "", "D": ""},
                "answer": ""
            } format.`;

            const chatCompletion = await client.chat.completions.create({
                model: "meta-llama/Llama-3.2-3B-Instruct",
                messages: [{ role: "user", content: message }],
                max_tokens: 500,
                temperature: 0.7,
            });

            const aiResponse = chatCompletion.choices[0].message.content;
            room.currentQuestion = aiResponse;
            
            // Try to parse the correct answer from the JSON response
            try {
                const jsonMatch = aiResponse.match(/\{[\s\S]*"question"[\s\S]*\}/);
                if (jsonMatch) {
                    const data = JSON.parse(jsonMatch[0]);
                    // Convert answer letter to index (A=0, B=1, C=2, D=3)
                    if (data.answer) {
                        const answerLetter = data.answer.toUpperCase();
                        room.correctAnswer = answerLetter.charCodeAt(0) - 65; // A=0, B=1, etc.
                    }
                }
            } catch (e) {
                console.log('Could not parse correct answer:', e);
                room.correctAnswer = 0; // Default to first option
            }
            
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

            io.to(roomCode).emit('newQuestion', { question: aiResponse });
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

httpServer.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log('Using FREE Hugging Face AI - No credit card required!');
    console.log('WebSocket server ready for multiplayer!');
});
