// Multiplayer state
let socket = null;
let currentRoomCode = '';
let playerName = '';
let isMultiplayerActive = false;
let multiplayerType = ''; // 'collab' or 'compete'
let timerInterval = null;
let timerStartTime = null;

// Initialize Socket.IO
function initializeSocket() {
    // If socket exists and is connected, just return it
    if (socket && socket.connected) {
        console.log('Socket already connected');
        return;
    }
    
    // If socket exists but disconnected, disconnect it properly
    if (socket && !socket.connected) {
        console.log('Cleaning up old socket');
        socket.disconnect();
        socket = null;
    }
    
    // Load socket.io client dynamically
    if (typeof io === 'undefined') {
        const script = document.createElement('script');
        script.src = '/socket.io/socket.io.js';
        script.onload = () => {
            console.log('Socket.IO loaded');
            connectSocket();
        };
        script.onerror = () => {
            console.error('Failed to load Socket.IO');
            alert('Failed to load multiplayer features. Please make sure the server is running.');
        };
        document.head.appendChild(script);
    } else {
        connectSocket();
    }
}

function connectSocket() {
    // Auto-detect server URL (works locally and in production)
    const serverUrl = window.location.origin;
    socket = io(serverUrl);
    
    socket.on('roomCreated', ({ roomCode, playerName: pName }) => {
        currentRoomCode = roomCode;
        playerName = pName;
        showWaitingRoom(roomCode);
    });
    
    socket.on('playerJoined', ({ playerName: pName, players }) => {
        updatePlayersList(players);
        addSystemMessage(`${pName} joined the room`);
    });
    
    socket.on('playerLeft', ({ players }) => {
        updatePlayersList(players);
        addSystemMessage('A player left the room');
    });
    
    socket.on('subjectChanged', ({ subject, playerName: pName }) => {
        window.setCurrentSubject(subject);
        
        // Update UI to show selected state
        const subjectCards = document.querySelectorAll('.waiting-room-page .subject-card');
        subjectCards.forEach(card => {
            card.classList.remove('selected');
            if (card.textContent.includes(subject)) {
                card.classList.add('selected');
            }
        });
        
        // Show notification
        addSystemMessage(`${pName} selected ${subject}`);
    });
    
    socket.on('gameStarted', ({ subject, mode, startedBy }) => {
        console.log('Game started event received:', { subject, mode, startedBy });
        isMultiplayerActive = true;
        window.setCurrentSubject(subject);
        
        document.getElementById('waitingRoomPage').style.display = 'none';
        document.getElementById('chatContainer').style.display = 'flex';
        
        const modeText = mode === 'collab' ? 'Collab' : 'Compete';
        document.getElementById('chatTitle').textContent = `${subject} - ${modeText} Mode`;
        document.getElementById('chatSubtitle').textContent = `Room: ${currentRoomCode}`;
        
        const chatMessages = document.getElementById('chatMessages');
        chatMessages.innerHTML = '';
        addSystemMessage(`${startedBy} started the game! Get ready...`);
    });
    
    socket.on('newQuestion', ({ question }) => {
        window.addMessage(question, 'ai');
        startTimer(30); // Start 30-second timer
    });
    
    socket.on('answerSubmitted', ({ playerName: pName, selectedOption, totalAnswers, totalPlayers }) => {
        addSystemMessage(`${pName} answered (${totalAnswers}/${totalPlayers})`);
    });
    
    socket.on('collabAnswerSelected', ({ playerName: pName, selectedIndex }) => {
        console.log('Collab answer selected by', pName, ':', selectedIndex);
        // Apply selection to all players' screens
        const quizTables = document.querySelectorAll('.quiz-table');
        const currentTable = quizTables[quizTables.length - 1];
        
        if (currentTable && !currentTable.classList.contains('answered')) {
            currentTable.classList.add('answered');
            const rows = currentTable.querySelectorAll('.quiz-option');
            rows.forEach((row, index) => {
                row.style.pointerEvents = 'none';
                if (index === selectedIndex) {
                    row.style.opacity = '0.7';
                    row.style.backgroundColor = '#2c2c2e';
                }
            });
            addSystemMessage(`${pName} selected an answer`);
        }
    });
    
    socket.on('revealAnswers', ({ correctAnswer, playerAnswers, scores }) => {
        console.log('revealAnswers received:', { correctAnswer, playerAnswers, scores });
        stopTimer(); // Stop the timer when answers are revealed
        // Find the current quiz table
        const quizTables = document.querySelectorAll('.quiz-table');
        const currentTable = quizTables[quizTables.length - 1]; // Get the latest table
        
        if (currentTable) {
            console.log('Processing reveal on table');
            const rows = currentTable.querySelectorAll('.quiz-option');
            
            rows.forEach((row, index) => {
                row.style.pointerEvents = 'none';
                
                // Highlight correct answer in green
                if (index === correctAnswer) {
                    row.classList.add('correct');
                    console.log('Marking row', index, 'as correct');
                }
                
                // Show who chose each option
                playerAnswers.forEach(({ playerName: pName, selectedIndex, isCorrect }) => {
                    if (selectedIndex === index) {
                        // Add red highlight for wrong answers
                        if (!isCorrect) {
                            row.classList.add('incorrect');
                            console.log('Marking row', index, 'as incorrect');
                        }
                    }
                });
            });
            
            // Show summary message
            let correctPlayers = playerAnswers.filter(p => p.isCorrect).map(p => p.playerName);
            let wrongPlayers = playerAnswers.filter(p => !p.isCorrect).map(p => p.playerName);
            
            if (correctPlayers.length > 0) {
                addSystemMessage(`✓ Correct: ${correctPlayers.join(', ')}`);
            }
            if (wrongPlayers.length > 0) {
                addSystemMessage(`✗ Wrong: ${wrongPlayers.join(', ')}`);
            }
            
            // Show score if in compete mode
            if (multiplayerType === 'compete' && scores && scores.length > 0) {
                // Sort by score descending
                const sortedScores = scores.sort((a, b) => b.score - a.score);
                let scoreMessage = '📊 Scores: ';
                scoreMessage += sortedScores.map(s => `${s.name}: ${s.score}`).join(' | ');
                addSystemMessage(scoreMessage);
                
                // Show score screen
                setTimeout(() => {
                    showScoreScreen(sortedScores);
                }, 1500);
            }
            
            // Add action buttons after reveal
            const quizContainer = currentTable.closest('.quiz-container');
            if (quizContainer && !quizContainer.querySelector('.quiz-actions')) {
                const actionsDiv = document.createElement('div');
                actionsDiv.className = 'quiz-actions';
                
                const backBtn = document.createElement('button');
                backBtn.className = 'quiz-action-btn back-btn';
                backBtn.textContent = 'Back';
                backBtn.addEventListener('click', () => {
                    // Leave the room and go back
                    leaveRoom();
                });
                
                const continueBtn = document.createElement('button');
                continueBtn.className = 'quiz-action-btn continue-btn';
                continueBtn.textContent = 'Continue';
                continueBtn.addEventListener('click', () => {
                    // Request new question
                    const chatMessages = document.getElementById('chatMessages');
                    chatMessages.innerHTML = '';
                    requestMultiplayerQuestion();
                });
                
                actionsDiv.appendChild(backBtn);
                actionsDiv.appendChild(continueBtn);
                quizContainer.appendChild(actionsDiv);
            }
        } else {
            console.error('No quiz table found for reveal');
        }
    });
    
    socket.on('error', ({ message }) => {
        alert(message);
    });
}

function createRoom() {
    const nameInput = document.getElementById('playerNameInput');
    const name = nameInput.value.trim();
    
    if (!name) {
        alert('Please enter your name');
        return;
    }
    
    playerName = name;
    
    // Initialize socket and wait for connection
    if (!socket || !socket.connected) {
        initializeSocket();
        // Wait longer for socket to connect (especially for remote servers)
        setTimeout(() => {
            if (socket && socket.connected) {
                socket.emit('createRoom', { 
                    playerName: name, 
                    mode: multiplayerType, 
                    subject: '' // Subject will be selected later
                });
            } else {
                // Try one more time after additional delay
                setTimeout(() => {
                    if (socket && socket.connected) {
                        socket.emit('createRoom', { 
                            playerName: name, 
                            mode: multiplayerType, 
                            subject: ''
                        });
                    } else {
                        alert('Failed to connect to server. Please try again.');
                    }
                }, 1000);
            }
        }, 2000);
    } else {
        socket.emit('createRoom', { 
            playerName: name, 
            mode: multiplayerType, 
            subject: '' // Subject will be selected later
        });
    }
}

function joinRoom() {
    const nameInput = document.getElementById('playerNameInput');
    const codeInput = document.getElementById('roomCodeInput');
    const name = nameInput.value.trim();
    const code = codeInput.value.trim().toUpperCase();
    
    if (!name) {
        alert('Please enter your name');
        return;
    }
    
    if (!code || code.length !== 6) {
        alert('Please enter a valid 6-character room code');
        return;
    }
    
    playerName = name;
    currentRoomCode = code;
    
    // Initialize socket and wait for connection
    if (!socket || !socket.connected) {
        initializeSocket();
        // Wait longer for socket to connect (especially for remote servers)
        setTimeout(() => {
            if (socket && socket.connected) {
                socket.emit('joinRoom', { roomCode: code, playerName: name });
                showWaitingRoom(code);
            } else {
                // Try one more time after additional delay
                setTimeout(() => {
                    if (socket && socket.connected) {
                        socket.emit('joinRoom', { roomCode: code, playerName: name });
                        showWaitingRoom(code);
                    } else {
                        alert('Failed to connect to server. Please try again.');
                    }
                }, 1000);
            }
        }, 2000);
    } else {
        socket.emit('joinRoom', { roomCode: code, playerName: name });
        showWaitingRoom(code);
    }
}

function showWaitingRoom(roomCode) {
    document.getElementById('roomSetupPage').style.display = 'none';
    document.getElementById('waitingRoomPage').style.display = 'flex';
    document.getElementById('displayRoomCode').textContent = roomCode;
}

function updatePlayersList(players) {
    const container = document.getElementById('playersContainer');
    container.innerHTML = players.map(p => `
        <div class="player-item">
            <span class="player-icon">👤</span>
            <span class="player-name">${p.name}</span>
            ${multiplayerType === 'compete' ? `<span class="player-score">${p.score} pts</span>` : ''}
        </div>
    `).join('');
}

function selectRoomSubject(subject) {
    window.setCurrentSubject(subject);
    
    // Update UI to show selected state
    const subjectCards = document.querySelectorAll('.waiting-room-page .subject-card');
    subjectCards.forEach(card => {
        card.classList.remove('selected');
        if (card.textContent.includes(subject)) {
            card.classList.add('selected');
        }
    });
    
    // Notify server of subject selection for real-time sync
    if (socket && currentRoomCode) {
        socket.emit('setSubject', { roomCode: currentRoomCode, subject: subject });
    }
}

function startMultiplayerGame() {
    console.log('startMultiplayerGame called');
    const currentSubject = window.getCurrentSubject();
    console.log('Current subject:', currentSubject);
    console.log('Socket:', socket);
    console.log('Room code:', currentRoomCode);
    
    if (!currentSubject) {
        alert('Please select a subject first');
        return;
    }
    
    if (!socket) {
        alert('Not connected to server. Please try refreshing the page.');
        return;
    }
    
    if (!currentRoomCode) {
        alert('No room code found. Please create or join a room.');
        return;
    }
    
    // Emit to server to start game for all players
    console.log('Emitting startGame event');
    socket.emit('startGame', { roomCode: currentRoomCode });
}

function addSystemMessage(text) {
    const chatMessages = document.getElementById('chatMessages');
    const messageDiv = document.createElement('div');
    messageDiv.className = 'message system-message';
    messageDiv.style.textAlign = 'center';
    messageDiv.style.color = '#8e8e93';
    messageDiv.style.fontSize = '14px';
    messageDiv.style.margin = '10px 0';
    messageDiv.textContent = text;
    chatMessages.appendChild(messageDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function updateScoreboard(scores) {
    // TODO: Add scoreboard UI element
    console.log('Scores:', scores);
}

function goToRoomSetup(type) {
    multiplayerType = type;
    window.setMultiplayerType(type);
    document.getElementById('multiplayerPage').style.display = 'none';
    document.getElementById('roomSetupPage').style.display = 'flex';
    
    const modeText = type === 'collab' ? 'Collab' : 'Compete';
    document.getElementById('roomModeSubtitle').textContent = `${modeText} Mode - Create or join a room`;
}

function goBackToMultiplayerMode() {
    document.getElementById('roomSetupPage').style.display = 'none';
    document.getElementById('waitingRoomPage').style.display = 'none';
    document.getElementById('multiplayerPage').style.display = 'flex';
}

// Request new question in multiplayer
function requestMultiplayerQuestion() {
    if (socket && currentRoomCode) {
        socket.emit('requestQuestion', { roomCode: currentRoomCode });
    }
}

// Submit answer in multiplayer
function submitMultiplayerAnswer(selectedIndex, isCorrect) {
    console.log('submitMultiplayerAnswer called:', { selectedIndex, isCorrect, hasSocket: !!socket, roomCode: currentRoomCode });
    if (socket && currentRoomCode) {
        console.log('Emitting submitAnswer to server');
        socket.emit('submitAnswer', {
            roomCode: currentRoomCode,
            answer: selectedIndex,
            isCorrect: isCorrect
        });
    } else {
        console.error('Cannot submit answer - no socket or room code');
    }
}

// Getters for multiplayer state
function getMultiplayerState() {
    return {
        isActive: isMultiplayerActive,
        socket: socket,
        roomCode: currentRoomCode,
        playerName: playerName,
        type: multiplayerType
    };
}

function setMultiplayerType(type) {
    multiplayerType = type;
}

function getMultiplayerType() {
    return multiplayerType;
}

function leaveRoom() {
    // Stop timer
    stopTimer();
    
    // Notify server
    if (socket && currentRoomCode) {
        socket.disconnect();
    }
    
    // Reset state
    currentRoomCode = '';
    isMultiplayerActive = false;
    
    // Go back to landing page
    document.getElementById('chatContainer').style.display = 'none';
    document.getElementById('landingPage').style.display = 'flex';
    
    // Clear chat messages
    const chatMessages = document.getElementById('chatMessages');
    if (chatMessages) {
        chatMessages.innerHTML = '';
    }
}

// Timer functions
function startTimer(seconds) {
    stopTimer(); // Clear any existing timer
    
    const timerContainer = document.getElementById('timerContainer');
    const timerText = document.getElementById('timerText');
    const timerFill = document.getElementById('timerFill');
    
    if (!timerContainer) return;
    
    timerContainer.style.display = 'block';
    timerStartTime = Date.now();
    const duration = seconds * 1000;
    
    function updateTimer() {
        const elapsed = Date.now() - timerStartTime;
        const remaining = Math.max(0, duration - elapsed);
        const remainingSeconds = Math.ceil(remaining / 1000);
        const percentage = (remaining / duration) * 100;
        
        // Update text
        timerText.textContent = `${remainingSeconds}s`;
        
        // Update bar width
        timerFill.style.width = `${percentage}%`;
        
        // Change color based on time remaining
        timerFill.classList.remove('warning', 'critical');
        if (percentage <= 33) {
            timerFill.classList.add('critical');
        } else if (percentage <= 66) {
            timerFill.classList.add('warning');
        }
        
        // Stop when time is up
        if (remaining <= 0) {
            stopTimer();
        }
    }
    
    updateTimer();
    timerInterval = setInterval(updateTimer, 100);
}

function stopTimer() {
    if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
    }
    
    const timerContainer = document.getElementById('timerContainer');
    if (timerContainer) {
        timerContainer.style.display = 'none';
    }
}

function showScoreScreen(scores) {
    const scoreScreen = document.getElementById('scoreScreen');
    const scoreboardContainer = document.getElementById('scoreboardContainer');
    
    // Clear previous scores
    scoreboardContainer.innerHTML = '';
    
    // Add title
    const title = document.createElement('h3');
    title.style.color = 'white';
    title.style.marginBottom = '16px';
    title.style.fontSize = '18px';
    title.textContent = 'Current Standings';
    scoreboardContainer.appendChild(title);
    
    // Add each player's score
    scores.forEach((player, index) => {
        const scoreItem = document.createElement('div');
        scoreItem.className = 'score-item';
        
        // Highlight current player
        if (player.name === playerName) {
            scoreItem.classList.add('current-player');
        }
        
        const nameDiv = document.createElement('div');
        nameDiv.className = 'score-player-name';
        
        // Add rank emoji
        const rank = ['🥇', '🥈', '🥉'][index] || '🏅';
        const rankSpan = document.createElement('span');
        rankSpan.className = 'score-rank';
        rankSpan.textContent = rank;
        
        const nameSpan = document.createElement('span');
        nameSpan.textContent = player.name;
        
        nameDiv.appendChild(rankSpan);
        nameDiv.appendChild(nameSpan);
        
        const scoreDiv = document.createElement('div');
        scoreDiv.className = 'score-value';
        scoreDiv.textContent = `${player.score} pts`;
        
        scoreItem.appendChild(nameDiv);
        scoreItem.appendChild(scoreDiv);
        scoreboardContainer.appendChild(scoreItem);
    });
    
    // Show score screen
    scoreScreen.style.display = 'flex';
}

function continueFromScore() {
    const scoreScreen = document.getElementById('scoreScreen');
    scoreScreen.style.display = 'none';
    
    // Clear chat and request new question
    const chatMessages = document.getElementById('chatMessages');
    chatMessages.innerHTML = '';
    requestMultiplayerQuestion();
}

// Expose functions to global scope
window.createRoom = createRoom;
window.joinRoom = joinRoom;
window.startMultiplayerGame = startMultiplayerGame;
window.goToRoomSetup = goToRoomSetup;
window.goBackToMultiplayerMode = goBackToMultiplayerMode;
window.selectRoomSubject = selectRoomSubject;
window.getMultiplayerState = getMultiplayerState;
window.requestMultiplayerQuestion = requestMultiplayerQuestion;
window.submitMultiplayerAnswer = submitMultiplayerAnswer;
window.setMultiplayerType = setMultiplayerType;
window.getMultiplayerType = getMultiplayerType;
window.leaveRoom = leaveRoom;
window.continueFromScore = continueFromScore;
