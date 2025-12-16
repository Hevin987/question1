// Multiplayer state
let socket = null;
let currentRoomCode = '';
let playerName = '';
let isMultiplayerActive = false;
let multiplayerType = ''; // 'collab' or 'compete'
let timerInterval = null;
let timerStartTime = null;
let currentLevel = 0; // Track current question level (0-11)
let levelStatus = []; // Track status of each level: 'unanswered', 'correct', 'incorrect'
let conversationHistory = []; // Track Q&A history for AI context
let currentLoadingMessage = null; // Track current loading message element

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
            showModal('Failed to load multiplayer features. Please make sure the server is running.');
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
        
        // Stop background music when game starts
        if (window.stopMainBGM) {
            window.stopMainBGM();
        }
        
        // Initialize level tracking
        currentLevel = 0;
        levelStatus = Array(12).fill('unanswered');
        conversationHistory = []; // Clear conversation history for new game
        
        document.getElementById('waitingRoomPage').style.display = 'none';
        
        const modeText = mode === 'collab' ? 'Collab' : 'Compete';
        document.getElementById('chatTitle').textContent = `${subject} - ${modeText} Mode`;
        document.getElementById('chatSubtitle').textContent = `Room: ${currentRoomCode}`;
        
        // Show level screen in collab mode before questions
        if (mode === 'collab') {
            showLevelScreen();
        } else {
            // In compete mode, show chat and start generating question
            document.getElementById('chatContainer').style.display = 'flex';
            const chatMessages = document.getElementById('chatMessages');
            chatMessages.innerHTML = '';
            addSystemMessage(`Game started. 🤖 Cooking up a spicy question...`);
            currentLoadingMessage = addLoadingMessage();
        }
    });
    
    socket.on('newQuestion', ({ question }) => {
        // Remove loading message before showing question
        if (currentLoadingMessage && currentLoadingMessage.parentNode) {
            currentLoadingMessage.remove();
            currentLoadingMessage = null;
        }
        
        // Store question in conversation history
        conversationHistory.push({ role: 'assistant', content: question });
        
        window.addMessage(question, 'ai').then(() => {
            // After message is added and buttons are rendered, notify server and start visual timer
            console.log('[Client] Question UI ready, notifying server to start timer');
            socket.emit('questionReady', { roomCode: currentRoomCode });
            startTimer(30); // Start visual timer display for 30 seconds
        });
    });
    
    // Function to notify server that question is ready (called from main.js)
    window.notifyQuestionReady = () => {
        console.log('[Client] Question buttons rendered, notifying server');
        socket.emit('questionReady', { roomCode: currentRoomCode });
        startTimer(30); // Start visual timer display for 30 seconds
    };
    
    socket.on('answerSubmitted', ({ playerName: pName, selectedOption, totalAnswers, totalPlayers }) => {
        addSystemMessage(`${pName} answered (${totalAnswers}/${totalPlayers})`);
    });
    
    // AI checking overlay handlers
    socket.on('aiCheckingStart', () => {
        console.log('[AI Checking] Showing checking overlay');
        const overlay = document.getElementById('aiCheckingOverlay');
        if (overlay) {
            overlay.classList.add('show');
        }
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
        
        // Hide AI checking overlay
        const overlay = document.getElementById('aiCheckingOverlay');
        if (overlay) {
            overlay.classList.remove('show');
        }
        
        hideTimer(); // Hide the timer completely when answers are revealed
        
        // Stop level BGM when answers are revealed
        if (window.stopLevelBGM) {
            window.stopLevelBGM();
        }
        
        // Update level status based on current player's answer
        const myAnswer = playerAnswers.find(p => p.playerName === playerName);
        let isWrongInCollab = false;
        
        if (myAnswer) {
            levelStatus[currentLevel] = myAnswer.isCorrect ? 'correct' : 'incorrect';
            
            // Play sound effect based on answer
            if (myAnswer.isCorrect) {
                if (window.playCorrectSound) window.playCorrectSound();
            } else {
                if (window.playWrongSound) window.playWrongSound();
            }
            
            // Store answer result in conversation history for AI context
            const answerFeedback = myAnswer.isCorrect ? 
                'Previous answer was correct.' : 
                'Previous answer was incorrect.';
            conversationHistory.push({ role: 'user', content: answerFeedback });
            
            // Check if game should end in collab mode
            if (multiplayerType === 'collab' && !myAnswer.isCorrect) {
                isWrongInCollab = true;
            }
        }
        
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
            
            // In collab mode, game over if answer is wrong (show continue button to view level screen)
            if (isWrongInCollab) {
                addSystemMessage('❌ Wrong answer! Game Over in Collab Mode.');
                
                // Add continue button to show level screen with results
                const quizContainer = currentTable.closest('.quiz-container');
                if (quizContainer && !quizContainer.querySelector('.quiz-actions')) {
                    const actionsDiv = document.createElement('div');
                    actionsDiv.className = 'quiz-actions';
                    
                    const continueBtn = document.createElement('button');
                    continueBtn.className = 'quiz-action-btn continue-btn';
                    continueBtn.textContent = 'Continue';
                    continueBtn.style.width = '100%';
                    continueBtn.addEventListener('click', () => {
                        // Notify server
                        if (socket && currentRoomCode) {
                            socket.emit('playerContinue', { 
                                roomCode: currentRoomCode, 
                                action: 'gameOverLevelScreen'
                            });
                        }
                        showLevelScreen('failed');
                    });
                    
                    actionsDiv.appendChild(continueBtn);
                    quizContainer.appendChild(actionsDiv);
                }
                
                return; // Don't add default action buttons
            }
            
            // Show score if in compete mode
            if (multiplayerType === 'compete' && scores && scores.length > 0) {
                // Sort by score descending
                const sortedScores = scores.sort((a, b) => b.score - a.score);
                
                // Add continue button that shows score screen
                const quizContainer = currentTable.closest('.quiz-container');
                if (quizContainer && !quizContainer.querySelector('.quiz-actions')) {
                    const actionsDiv = document.createElement('div');
                    actionsDiv.className = 'quiz-actions';
                    
                    const continueBtn = document.createElement('button');
                    continueBtn.className = 'quiz-action-btn continue-btn';
                    continueBtn.textContent = 'Continue';
                    continueBtn.addEventListener('click', () => {
                        // Notify server that a player clicked continue to show score
                        if (socket && currentRoomCode) {
                            socket.emit('playerContinue', { 
                                roomCode: currentRoomCode, 
                                action: 'showScore',
                                scores: sortedScores 
                            });
                        }
                        showScoreScreen(sortedScores);
                    });
                    
                    actionsDiv.appendChild(continueBtn);
                    quizContainer.appendChild(actionsDiv);
                }
                
                return; // Don't add default action buttons
            }
            
            // Add action buttons after reveal (only in collab mode or when no scores)
            const quizContainer = currentTable.closest('.quiz-container');
            if (quizContainer && !quizContainer.querySelector('.quiz-actions')) {
                const actionsDiv = document.createElement('div');
                actionsDiv.className = 'quiz-actions';
                
                const continueBtn = document.createElement('button');
                continueBtn.className = 'quiz-action-btn continue-btn';
                continueBtn.textContent = 'Continue';
                continueBtn.style.width = '100%'; // Full width since no back button
                continueBtn.addEventListener('click', () => {
                    // If wrong in collab mode, just show level screen (don't continue game)
                    if (isWrongInCollab) {
                        // Notify server
                        if (socket && currentRoomCode) {
                            socket.emit('playerContinue', { 
                                roomCode: currentRoomCode, 
                                action: 'gameOverLevelScreen'
                            });
                        }
                        showLevelScreen();
                        return;
                    }
                    
                    // Notify server that a player clicked continue
                    if (socket && currentRoomCode) {
                        socket.emit('playerContinue', { 
                            roomCode: currentRoomCode, 
                            action: multiplayerType === 'collab' ? 'levelScreen' : 'nextQuestion'
                        });
                    }
                    
                    // Increment level and show level screen in collab mode
                    currentLevel++;
                    if (multiplayerType === 'collab') {
                        showLevelScreen('levelUp');
                    } else {
                        // Check if game should end after 12 questions
                        if (currentLevel >= 12) {
                            endGame();
                            return;
                        }
                        // Request new question
                        const chatMessages = document.getElementById('chatMessages');
                        chatMessages.innerHTML = '';
                        addSystemMessage('🎲 Rolling a new question...');
                        currentLoadingMessage = addLoadingMessage();
                        requestMultiplayerQuestion();
                    }
                });
                
                actionsDiv.appendChild(continueBtn);
                quizContainer.appendChild(actionsDiv);
            }
        } else {
            console.error('No quiz table found for reveal');
        }
    });
    
    socket.on('error', ({ message }) => {
        showModal(message);
    });
    
    socket.on('playerContinued', ({ action, playerName: pName, scores }) => {
        console.log('Player continued:', pName, action);
        addSystemMessage(`${pName} clicked continue`);
        
        if (action === 'showScore') {
            // Compete mode: show score screen to all players
            if (scores && scores.length > 0) {
                showScoreScreen(scores);
            } else {
                console.error('No scores data received for showScore action');
            }
        } else if (action === 'gameOverLevelScreen') {
            // Collab mode game over: show level screen with results
            showLevelScreen('failed');
        } else if (action === 'levelScreen') {
            // Collab mode: automatically show level screen for all players
            currentLevel++;
            showLevelScreen('levelUp');
        } else if (action === 'continueLevelScreen') {
            // Collab mode: sync continue from level screen for all players
            const levelProgressPage = document.getElementById('levelProgressPage');
            const chatContainer = document.getElementById('chatContainer');
            
            // Stop level BGM when continuing
            if (window.stopLevelFirstBGM) {
                window.stopLevelFirstBGM();
            }
            if (window.stopLevelUpSound) {
                window.stopLevelUpSound();
            }
            
            // Check if game should end after 12 questions
            if (currentLevel >= 12) {
                if (levelProgressPage) levelProgressPage.style.display = 'none';
                endGame();
                return;
            }
            
            // Hide level screen, show chat
            if (levelProgressPage) {
                levelProgressPage.style.display = 'none';
            }
            if (chatContainer) {
                chatContainer.style.display = 'flex';
            }
            
            // Clear chat and request new question
            const chatMessages = document.getElementById('chatMessages');
            if (chatMessages) {
                chatMessages.innerHTML = '';
                addSystemMessage('🤖 Cooking up a spicy question...');
                currentLoadingMessage = addLoadingMessage();
            }
            
            // Play next question sound
            if (window.playNextQuestionSound) {
                window.playNextQuestionSound();
            }
            
            // Don't request question here - the player who clicked continue already requested it
        } else if (action === 'nextQuestion') {
            // Compete mode: automatically move to next question for all players
            currentLevel++;
            if (currentLevel >= 12) {
                endGame();
                return;
            }
            
            // Hide score screen and show chat screen
            const scoreScreen = document.getElementById('scoreScreen');
            if (scoreScreen) {
                scoreScreen.style.display = 'none';
            }
            
            // Show chat screen
            const chatScreen = document.getElementById('chatScreen');
            if (chatScreen) {
                chatScreen.style.display = 'flex';
            }
            
            const chatMessages = document.getElementById('chatMessages');
            if (chatMessages) {
                chatMessages.innerHTML = '';
                addSystemMessage('🧠 Brain power activating...');
                currentLoadingMessage = addLoadingMessage();
            }
            
            // Play next question sound
            if (window.playNextQuestionSound) {
                window.playNextQuestionSound();
            }
            
            // Don't request question here - the player who clicked continue already requested it
            // Just wait for the newQuestion event from server
        }
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
                        showModal('Failed to connect to server. Please try again.');
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
        showModal('Please enter your name');
        return;
    }
    
    if (!code || code.length !== 6) {
        showModal('Please enter a valid 6-character room code');
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
                        showModal('Failed to connect to server. Please try again.');
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
            <span class="player-name">${p.name}</span>
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
        showModal('Please select a subject first');
        return;
    }
    
    if (!socket) {
        showModal('Not connected to server. Please try refreshing the page.');
        return;
    }
    
    if (!currentRoomCode) {
        showModal('No room code found. Please create or join a room.');
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

function addLoadingMessage() {
    const chatMessages = document.getElementById('chatMessages');
    
    const messageDiv = document.createElement('div');
    messageDiv.className = 'loading-message';
    messageDiv.innerHTML = '<div class="loading-ring"></div>';
    
    chatMessages.appendChild(messageDiv);
    
    // Scroll to bottom
    chatMessages.scrollTop = chatMessages.scrollHeight;
    
    return messageDiv;
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
    
    // Keep background music playing on multiplayer screens
    if (window.playMainBGM) window.playMainBGM();
}

function goBackToMultiplayerMode() {
    document.getElementById('roomSetupPage').style.display = 'none';
    document.getElementById('waitingRoomPage').style.display = 'none';
    document.getElementById('multiplayerPage').style.display = 'flex';
    
    // Resume background music when returning to multiplayer mode selection
    if (window.playMainBGM) window.playMainBGM();
}

// Request new question in multiplayer
function requestMultiplayerQuestion() {
    if (socket && currentRoomCode) {
        // Send conversation history for AI context
        socket.emit('requestQuestion', { 
            roomCode: currentRoomCode,
            conversationHistory: conversationHistory 
        });
    }
}

// Submit answer in multiplayer
function submitMultiplayerAnswer(selectedIndex) {
    console.log('submitMultiplayerAnswer called:', { selectedIndex, hasSocket: !!socket, roomCode: currentRoomCode });
    
    // In compete mode, stop timer for this player after they submit
    // (timer still runs on server until all players answer)
    if (multiplayerType === 'compete') {
        stopTimer();
    }
    
    if (socket && currentRoomCode) {
        console.log('Emitting submitAnswer to server');
        socket.emit('submitAnswer', {
            roomCode: currentRoomCode,
            answer: selectedIndex
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
    hideTimer();
    
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
    
    // Play level BGM when timer starts
    if (window.playLevelBGM) {
        window.playLevelBGM();
    }
    
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
    
    // Keep timer visible but frozen - don't hide it
    // const timerContainer = document.getElementById('timerContainer');
    // if (timerContainer) {
    //     timerContainer.style.display = 'none';
    // }
}

function hideTimer() {
    stopTimer(); // Stop the interval first
    
    const timerContainer = document.getElementById('timerContainer');
    if (timerContainer) {
        timerContainer.style.display = 'none';
    }
}

function showScoreScreen(scores) {
    console.log('showScoreScreen called with scores:', scores);
    const scoreScreen = document.getElementById('scoreScreen');
    const scoreboardContainer = document.getElementById('scoreboardContainer');
    
    console.log('scoreScreen element:', scoreScreen);
    console.log('scoreboardContainer element:', scoreboardContainer);
    
    if (!scoreScreen || !scoreboardContainer) {
        console.error('Score screen elements not found!');
        return;
    }
    
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
    console.log('Setting scoreScreen display to flex');
    scoreScreen.style.display = 'flex';
    console.log('Score screen should now be visible');
}

function showLevelScreen(screenState = 'firstLevel') {
    // screenState can be: 'firstLevel', 'levelUp', or 'failed'
    const levelProgressPage = document.getElementById('levelProgressPage');
    const chatContainer = document.getElementById('chatContainer');
    const levelRoomCode = document.getElementById('levelRoomCode');
    
    if (!levelProgressPage) {
        console.error('Level progress page not found!');
        return;
    }
    
    // Stop main BGM and level BGM before playing level screen music
    if (window.stopMainBGM) {
        window.stopMainBGM();
    }
    if (window.stopLevelBGM) {
        window.stopLevelBGM();
    }
    
    // Play appropriate music based on screen state
    if (screenState === 'firstLevel') {
        // First level - play level first BGM once
        if (window.playLevelFirstBGM) {
            window.playLevelFirstBGM();
        }
    } else if (screenState === 'failed') {
        // Failed level - play level failed sound
        if (window.playLevelFailedSound) {
            window.playLevelFailedSound();
        }
    } else if (screenState === 'levelUp') {
        // Level up - play level up sound
        if (window.playLevelUpSound) {
            window.playLevelUpSound();
        }
    }
    
    // Update room code display
    if (levelRoomCode) {
        levelRoomCode.textContent = `Room: ${currentRoomCode}`;
    }
    
    // Update all level indicators
    const levelRows = levelProgressPage.querySelectorAll('.level-row');
    levelRows.forEach((row, index) => {
        const indicator = row.querySelector('.level-indicator');
        
        // Remove all status classes
        indicator.classList.remove('yellow', 'green', 'red');
        row.classList.remove('active');
        
        // Set indicator color based on status
        if (index < currentLevel) {
            // Past levels - show result
            if (levelStatus[index] === 'correct') {
                indicator.classList.add('green');
            } else if (levelStatus[index] === 'incorrect') {
                indicator.classList.add('red');
            } else {
                indicator.classList.add('yellow'); // Unanswered (shouldn't happen)
            }
        } else if (index === currentLevel) {
            // Current level - highlight with color based on state
            if (screenState === 'failed') {
                indicator.classList.add('red'); // Failed - show red
            } else {
                indicator.classList.add('yellow'); // Active/in progress - show yellow
            }
            row.classList.add('active');
        } else {
            // Future levels - yellow
            indicator.classList.add('yellow');
        }
    });
    
    // Hide chat, show level screen
    if (chatContainer) {
        chatContainer.style.display = 'none';
    }
    levelProgressPage.style.display = 'flex';
}

function continueLevelScreen() {
    const levelProgressPage = document.getElementById('levelProgressPage');
    const chatContainer = document.getElementById('chatContainer');
    
    // Stop level BGM or level up sound or level failed sound when continuing
    if (window.stopLevelFirstBGM) {
        window.stopLevelFirstBGM();
    }
    if (window.stopLevelUpSound) {
        window.stopLevelUpSound();
    }
    if (window.stopLevelFailedSound) {
        window.stopLevelFailedSound();
    }
    
    // Check if current level is wrong (game over in collab mode)
    if (multiplayerType === 'collab' && levelStatus[currentLevel] === 'incorrect') {
        // Game over - return to waiting room
        levelProgressPage.style.display = 'none';
        if (chatContainer) chatContainer.style.display = 'none';
        
        // Reset state
        conversationHistory = [];
        currentLevel = 0;
        levelStatus = Array(12).fill('unanswered');
        
        // Clear subject selection
        const subjectCards = document.querySelectorAll('.waiting-room-page .subject-card');
        subjectCards.forEach(card => card.classList.remove('selected'));
        
        // Resume background music
        if (window.playMainBGM) {
            window.playMainBGM();
        }
        
        // Show waiting room
        document.getElementById('waitingRoomPage').style.display = 'flex';
        return;
    }
    
    // Notify server that a player clicked continue from level screen
    if (socket && currentRoomCode) {
        socket.emit('playerContinue', { 
            roomCode: currentRoomCode, 
            action: 'continueLevelScreen'
        });
    }
    
    // Check if game should end after 12 questions
    if (currentLevel >= 12) {
        levelProgressPage.style.display = 'none';
        endGame();
        return;
    }
    
    // Hide level screen, show chat
    if (levelProgressPage) {
        levelProgressPage.style.display = 'none';
    }
    if (chatContainer) {
        chatContainer.style.display = 'flex';
    }
    
    // Clear chat and request new question
    const chatMessages = document.getElementById('chatMessages');
    if (chatMessages) {
        chatMessages.innerHTML = '';
    }
    
    // Always request question when continuing from level screen
    addSystemMessage('🤖 Cooking up a spicy question...');
    currentLoadingMessage = addLoadingMessage();
    
    // Play next question sound
    if (window.playNextQuestionSound) {
        window.playNextQuestionSound();
    }
    
    requestMultiplayerQuestion();
}

function continueFromScore() {
    // Notify server that a player clicked continue from score screen
    if (socket && currentRoomCode) {
        socket.emit('playerContinue', { roomCode: currentRoomCode, action: 'nextQuestion' });
    }
    
    const scoreScreen = document.getElementById('scoreScreen');
    scoreScreen.style.display = 'none';
    
    // Check if game should end after showing score for 12th question
    if (currentLevel >= 12) {
        endGame();
        return;
    }
    
    // Increment level for compete mode
    currentLevel++;
    
    // Play next question sound
    if (window.playNextQuestionSound) {
        window.playNextQuestionSound();
    }
    
    // Clear chat and request new question
    const chatMessages = document.getElementById('chatMessages');
    chatMessages.innerHTML = '';
    addSystemMessage('✨ Summoning next challenge...');
    currentLoadingMessage = addLoadingMessage();
    requestMultiplayerQuestion();
}

function endGame() {
    // Show final message and return to waiting room or landing
    const chatContainer = document.getElementById('chatContainer');
    const levelProgressPage = document.getElementById('levelProgressPage');
    const scoreScreen = document.getElementById('scoreScreen');
    
    // Stop level BGM or level up sound if playing
    if (window.stopLevelFirstBGM) {
        window.stopLevelFirstBGM();
    }
    if (window.stopLevelUpSound) {
        window.stopLevelUpSound();
    }
    
    // Hide all game screens
    if (chatContainer) chatContainer.style.display = 'none';
    if (levelProgressPage) levelProgressPage.style.display = 'none';
    if (scoreScreen) scoreScreen.style.display = 'none';
    
    // Show completion message
    addSystemMessage('🎉 Game Complete! All 12 questions finished!');
    
    // Resume background music when game ends
    if (window.playMainBGM) {
        window.playMainBGM();
    }
    
    // Reset and return to waiting room
    setTimeout(() => {
        currentLevel = 0;
        levelStatus = Array(12).fill('unanswered');
        conversationHistory = []; // Clear conversation history
        document.getElementById('waitingRoomPage').style.display = 'flex';
    }, 2000);
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
window.stopTimer = stopTimer;
window.hideTimer = hideTimer;
