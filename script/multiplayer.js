// ============================================================================
// UNIFIED GAME SEQUENCE (MULTIPLAYER):
// Client-side implementation using WebSocket
//
// STEP 1: Game starts (user clicks start game)
// STEP 2: Server generates question with 4 options
// STEP 3: Server verifies the answer - if no correct answer, regenerates
// STEP 4: Server sends question to all players via 'newQuestion' event
// STEP 5: Clients render UI, players see timer (30 seconds)
// STEP 6: Player(s) select answer or timer expires
// STEP 7: Server verifies answer with AI and calculates scores
// STEP 8: Server broadcasts results via 'revealAnswers' event
// ============================================================================

// Multiplayer state
let socket = null;
let currentRoomCode = '';
let playerName = '';
let isHost = false; // Track if current player is the host (room creator)
let isMultiplayerActive = false;
let multiplayerType = ''; // 'collab' or 'compete'
let timerInterval = null;
let timerStartTime = null;
let currentLevel = 0; // Track current question level (0-11)
let levelStatus = []; // Track status of each level: 'unanswered', 'correct', 'incorrect'
let conversationHistory = []; // Track Q&A history for AI context
let currentLoadingMessage = null; // Track current loading message element
let currentMultiplayerSubjectTitle = ''; // Track current subject title for display in multiplayer

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
            if (!document.documentElement.lang === "zh")
                showModal('Failed to load multiplayer features. Please make sure the server is running.');
            else
                showModal('無法加載多人遊戲功能。請確保伺服器正在運行。');
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

    // Listen for collabWrongAnswer event to sync game over for all players
    socket.on('collabWrongAnswer', ({ playerName: pName, selectedIndex }) => {
        // Only in collab mode
        if (multiplayerType !== 'collab') return;
        // Show wrong answer UI and game over for all
        const quizTables = document.querySelectorAll('.quiz-table');
        const currentTable = quizTables[quizTables.length - 1];
        if (currentTable && !currentTable.classList.contains('answered')) {
            currentTable.classList.add('answered');
            const rows = currentTable.querySelectorAll('.quiz-option');
            rows.forEach((row, index) => {
                row.style.pointerEvents = 'none';
                if (index === selectedIndex) {
                    row.classList.add('incorrect');
                    row.style.opacity = '0.7';
                    row.style.backgroundColor = '#2c2c2e';
                }
            });
            if (!document.documentElement.lang === "zh")
                addSystemMessage(`❌ You selected a wrong answer! Game Over in Collab Mode.`);
            else
                addSystemMessage(`❌ 你選錯了答案！協作模式遊戲結束。`);
            // Show continue button to view level screen
            const quizContainer = currentTable.closest('.quiz-container');
            if (quizContainer && !quizContainer.querySelector('.quiz-actions')) {
                const actionsDiv = document.createElement('div');
                actionsDiv.className = 'quiz-actions';
                const continueBtn = document.createElement('button');
                continueBtn.className = 'quiz-action-btn continue-btn';
                    if (!document.documentElement.lang === "zh")
                        continueBtn.textContent = 'Continue';
                    else
                        continueBtn.textContent = '繼續';
                continueBtn.style.width = '100%';
                continueBtn.addEventListener('click', () => {
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
        }
    });
    // (Removed duplicate socket initialization)
    
    socket.on('roomCreated', ({ roomCode, playerName: pName }) => {
        currentRoomCode = roomCode;
        playerName = pName;
        isHost = true; // Player who creates the room is the host
        showWaitingRoom(roomCode);
    });
    
    socket.on('playerJoined', ({ playerName: pName, players, subject, subjectTitle }) => {
        updatePlayersList(players);
        if (!document.documentElement.lang === "zh")
            addSystemMessage(`${pName} joined the room`);
        else
            addSystemMessage(`${pName} 加入了房間`);
        
        // Sync the subject selection from the room (when a new player joins)
        if (subject) {
            window.setCurrentSubject(subject);
            if (subjectTitle) {
                currentMultiplayerSubjectTitle = subjectTitle;
            } else {
                // Fallback: find subject title from SUBJECTS array
                const subjectObj = window.SUBJECTS && window.SUBJECTS.find(s => s.id === subject);
                if (subjectObj) {
                    currentMultiplayerSubjectTitle = document.documentElement.lang === "zh" ? subjectObj.zh_name : subjectObj.name;
                } else {
                    currentMultiplayerSubjectTitle = subject;
                }
            }
            
            // Update UI to show selected state using data attribute
            const subjectCards = document.querySelectorAll('.waiting-room-page .subject-card');
            subjectCards.forEach(card => {
                card.classList.remove('selected');
                if (card.getAttribute('data-subject-id') === subject) {
                    card.classList.add('selected');
                }
            });
        }
    });
    
    socket.on('playerLeft', ({ players }) => {
        updatePlayersList(players);
        if (!document.documentElement.lang === "zh")
            addSystemMessage('A player left the room');
        else
            addSystemMessage('有玩家離開了房間');
    });
    
    // Sync game state when a player joins during an active round
    socket.on('syncGameState', ({ currentQuestion, parsedQuestionData, correctAnswer, currentLevelSynced, mode, subject, subjectTitle, questionStartTime, timerDuration }) => {
        console.log('Received game state sync:', { currentLevelSynced, mode, subject, questionStartTime });
        
        // Update local game state
        currentLevel = currentLevelSynced || 0;
        levelStatus = Array(12).fill('unanswered');
        multiplayerType = mode;
        
        // Set subject
        if (subject) {
            window.setCurrentSubject(subject);
            if (subjectTitle) {
                currentMultiplayerSubjectTitle = subjectTitle;
            }
        }
        
        // Hide waiting room and show chat container
        document.getElementById('waitingRoomPage').style.display = 'none';
        document.getElementById('chatContainer').style.display = 'flex';
        
        // Update chat title with subject and mode
        if (!document.documentElement.lang === "zh"){
            const modeText = mode === 'collab' ? 'Collab' : 'Compete';
            document.getElementById('chatTitle').textContent = `${currentMultiplayerSubjectTitle} - ${modeText} Mode`;
            document.getElementById('chatSubtitle').textContent = `Room: ${currentRoomCode}`;
        } else {
            const modeText = mode === 'collab' ? '協作' : '競爭';
            document.getElementById('chatTitle').textContent = `${currentMultiplayerSubjectTitle}-${modeText}模式`;
            document.getElementById('chatSubtitle').textContent = `房間: ${currentRoomCode}`;
        }
        
        // Clear chat and add system message
        const chatMessages = document.getElementById('chatMessages');
        chatMessages.innerHTML = '';
        if (!document.documentElement.lang === "zh")
            addSystemMessage(`📍 Joined at Question ${currentLevel + 1}/12`);
        else
            addSystemMessage(`📍 加入了第 ${currentLevel + 1}/12 題`);
        
        // Show the question immediately
        if (currentQuestion) {
            window.addMessage(currentQuestion, 'ai').then(() => {
                console.log('[Client] Synced question UI ready');
                socket.emit('questionReady', { roomCode: currentRoomCode });
                
                // Calculate remaining time based on when question was sent
                const elapsedTime = Math.floor((Date.now() - questionStartTime) / 1000);
                const remainingTime = Math.max(0, (timerDuration || 30) - elapsedTime);
                
                console.log(`[Timer Sync] Elapsed: ${elapsedTime}s, Remaining: ${remainingTime}s`);
                
                // Start timer with remaining time
                if (remainingTime > 0) {
                    startTimerWithRemaining(remainingTime);
                }
            });
        }
    });
    
    socket.on('playerLeft', ({ players }) => {
        updatePlayersList(players);
        if (!document.documentElement.lang === "zh")
            addSystemMessage('A player left the room');
        else
            addSystemMessage('有玩家離開了房間');
    });
    
    socket.on('subjectChanged', ({ subject, subjectTitle, playerName: pName }) => {
        window.setCurrentSubject(subject);
        if (subjectTitle) {
            currentMultiplayerSubjectTitle = subjectTitle;
        } else {
            // Fallback: find subject title from SUBJECTS array
            const subjectObj = window.SUBJECTS && window.SUBJECTS.find(s => s.id === subject);
            if (subjectObj) {
                currentMultiplayerSubjectTitle = document.documentElement.lang === "zh" ? subjectObj.zh_name : subjectObj.name;
            } else {
                currentMultiplayerSubjectTitle = subject;
            }
        }
        
        // Update UI to show selected state using data attribute
        const subjectCards = document.querySelectorAll('.waiting-room-page .subject-card');
        subjectCards.forEach(card => {
            card.classList.remove('selected');
            if (card.getAttribute('data-subject-id') === subject) {
                card.classList.add('selected');
            }
        });
        
        // Show notification
        if (!document.documentElement.lang === "zh")
            addSystemMessage(`${pName} selected a subject`);
        else
            addSystemMessage(`${pName} 選擇了一個主題`);
    });
    
    socket.on('gameStarted', ({ subject, subjectTitle, mode, startedBy }) => {
        console.log('Game started event received:', { subject, subjectTitle, mode, startedBy });
        isMultiplayerActive = true;
        window.setCurrentSubject(subject);
        if (subjectTitle) {
            currentMultiplayerSubjectTitle = subjectTitle;
        } else {
            // Fallback: find subject title from SUBJECTS array
            const subjectObj = window.SUBJECTS && window.SUBJECTS.find(s => s.id === subject);
            if (subjectObj) {
                currentMultiplayerSubjectTitle = document.documentElement.lang === "zh" ? subjectObj.zh_name : subjectObj.name;
            } else {
                currentMultiplayerSubjectTitle = subject;
            }
        }
        
        // Stop background music when game starts
        if (window.stopMainBGM) {
            window.stopMainBGM();
        }
        
        // Initialize level tracking
        currentLevel = 0;
        levelStatus = Array(12).fill('unanswered');
        conversationHistory = []; // Clear conversation history for new game
        
        document.getElementById('waitingRoomPage').style.display = 'none';
        if (!document.documentElement.lang === "zh"){
            const modeText = mode === 'collab' ? 'Collab' : 'Compete';
            document.getElementById('chatTitle').textContent = `${currentMultiplayerSubjectTitle} - ${modeText} Mode`;
            document.getElementById('chatSubtitle').textContent = `Room: ${currentRoomCode}`;
        }
        else{
            const modeText = mode === 'collab' ? '協作' : '競爭';
            document.getElementById('chatTitle').textContent = `${currentMultiplayerSubjectTitle}-${modeText}模式`;
            document.getElementById('chatSubtitle').textContent = `房間: ${currentRoomCode}`;
        }
        
        // Show level screen in collab mode before questions
        if (mode === 'collab') {
            showLevelScreen();
        } else {
            // In compete mode, show chat and start generating question
            document.getElementById('chatContainer').style.display = 'flex';
            const chatMessages = document.getElementById('chatMessages');
            chatMessages.innerHTML = '';
            if (!document.documentElement.lang === "zh")
                addSystemMessage(`Game started. 🤖 Cooking up a spicy question...`);
            else
                addSystemMessage(`遊戲開始。🤖 正在準備一個刺激的問題...`);
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
        if (!document.documentElement.lang === "zh")
            addSystemMessage(`${pName} answered (${totalAnswers}/${totalPlayers})`);
        else
            addSystemMessage(`${pName} 答了 (${totalAnswers}/${totalPlayers})`);
    });
    
    // Stop visual timer when all players have answered or time expires
    socket.on('stopTimer', () => {
        console.log('[Timer] Server signaling to stop visual timer');
        stopTimer();
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
            if (!document.documentElement.lang === "zh")
                addSystemMessage(`${pName} selected an answer`);
            else
                addSystemMessage(`${pName} 選擇了一個答案`);
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
        }
        
        // In collab mode, check if ANY answer is wrong (not just current player's)
        if (multiplayerType === 'collab') {
            const hasWrongAnswer = playerAnswers.some(p => !p.isCorrect);
            if (hasWrongAnswer) {
                isWrongInCollab = true;
                // Update level status for all players if wrong answer exists
                levelStatus[currentLevel] = 'incorrect';
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
                if (!document.documentElement.lang === "zh")
                    addSystemMessage(`✓ Correct: ${correctPlayers.join(', ')}`);
                else
                    addSystemMessage(`✓ 答對: ${correctPlayers.join(', ')}`);
            }
            if (wrongPlayers.length > 0) {
                if (!document.documentElement.lang === "zh")
                    addSystemMessage(`✗ Wrong: ${wrongPlayers.join(', ')}`);
                else 
                    addSystemMessage(`✗ 答錯: ${wrongPlayers.join(', ')}`);
            }
            
            // In collab mode, game over if answer is wrong (show continue button to view level screen)
            if (isWrongInCollab) {
                if (!document.documentElement.lang === "zh")
                    addSystemMessage('❌ Wrong answer! Game Over in Collab Mode.');
                else
                    addSystemMessage('❌ 答案錯誤！協作模式遊戲結束。');
                
                // Add continue button to show level screen with results (for all players)
                const quizContainer = currentTable.closest('.quiz-container');
                if (quizContainer && !quizContainer.querySelector('.quiz-actions')) {
                    const actionsDiv = document.createElement('div');
                    actionsDiv.className = 'quiz-actions';
                    
                    const continueBtn = document.createElement('button');
                    continueBtn.className = 'quiz-action-btn continue-btn';
                    if (!document.documentElement.lang === "zh")
                        continueBtn.textContent = 'Continue';
                    else
                        continueBtn.textContent = '繼續';
                    continueBtn.style.width = '100%';
                    continueBtn.addEventListener('click', () => {
                        // Notify server - this will sync to all players
                        if (socket && currentRoomCode) {
                            socket.emit('playerContinue', { 
                                roomCode: currentRoomCode, 
                                action: 'gameOverLevelScreen'
                            });
                        }
                        // Show level screen immediately for this player
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
                    if (!document.documentElement.lang === "zh")
                        continueBtn.textContent = 'Continue';
                    else
                        continueBtn.textContent = '繼續';
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
                    if (!document.documentElement.lang === "zh")
                        continueBtn.textContent = 'Continue';
                    else
                        continueBtn.textContent = '繼續';
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
                        if (!document.documentElement.lang === "zh")
                            addSystemMessage('🎲 Rolling a new question...');
                        else
                            addSystemMessage('🎲 正在擲出一個新問題...');
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
        console.error('Server error:', message);
        // Check if it's a host-only error
        if (message.includes('Only the host')) {
            if (!document.documentElement.lang === "zh")
                addSystemMessage('⏳ Only the host can perform this action');
            else
                addSystemMessage('⏳ 只有主機玩家才能執行此操作');
        } else {
            showModal(message);
        }
    });
    
    // Handle answer check stopped
    socket.on('answerCheckStopped', ({ message }) => {
        console.log('[Answer Check] Stopped:', message);
        
        // Hide AI checking overlay
        const overlay = document.getElementById('aiCheckingOverlay');
        if (overlay) {
            overlay.classList.remove('show');
        }
        
        // Show message and return to appropriate screen
        addSystemMessage(`⚠️ ${message}`);
        
        setTimeout(() => {
            returnToGameMenuFromAnswerCheck();
        }, 2000);
    });
    
    socket.on('playerContinued', ({ action, playerName: pName, scores }) => {
        console.log('Player continued:', pName, action);
        
        // Only show message if it's not from current player (to avoid duplicate messages)
        if (pName !== playerName) {
            if (!document.documentElement.lang === "zh")
                addSystemMessage(`${pName} clicked continue`);
            else
                addSystemMessage(`${pName} 點擊了繼續`);
        }
        
        if (action === 'showScore') {
            // Compete mode: show score screen to all players
            if (scores && scores.length > 0) {
                showScoreScreen(scores);
            } else {
                console.error('No scores data received for showScore action');
            }
        } else if (action === 'gameOverLevelScreen') {
            // Collab mode game over: show level screen with results for all players
            // This ensures all players see the level screen when any player clicks continue
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
                if (!document.documentElement.lang === "zh")
                    addSystemMessage('🤖 Cooking up a spicy question...');
                else
                    addSystemMessage('🤖 正在準備一個刺激的問題...');
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
                if (!document.documentElement.lang === "zh")
                    addSystemMessage('🧠 Brain power activating...');
                else
                    addSystemMessage('🧠 大腦啟動中...');
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
        if (!document.documentElement.lang === "zh")
            showModal('Please enter your name');
        else
            showModal('請輸入您的名字');
        return;
    }
    
    playerName = name;
    
    // Sync player name with client logger
    if (window.clientLogger) {
        window.clientLogger.setPlayerName(name);
    }
    
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
                        if (!document.documentElement.lang === "zh")
                            showModal('Failed to connect to server. Please try again.');
                        else
                            showModal('無法連接到伺服器。請再試一次。');
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
        if (!document.documentElement.lang === "zh")
            showModal('Please enter your name');
        else
            showModal('請輸入您的名字');
        return;
    }
    
    if (!code || code.length !== 6) {
        if (!document.documentElement.lang === "zh")
            showModal('Please enter a valid 6-character room code');
        else
            showModal('請輸入有效的6位數房間代碼');
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
                        if (!document.documentElement.lang === "zh")
                            showModal('Failed to connect to server. Please try again.');
                        else
                            showModal('無法連接到伺服器。請再試一次。');
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

    // Dynamically render subject grid from window.SUBJECTS, retry if not ready
    const grid = document.getElementById('subjectGridMulti');
    if (!grid) return;
    if (!window.SUBJECTS) {
        setTimeout(() => showWaitingRoom(roomCode), 100);
        return;
    }
    grid.innerHTML = '';
    grid.classList.remove('grid-2x3', 'grid-2x2');
    grid.classList.add('grid-2x2');
        window.SUBJECTS.forEach(subj => {
        const btn = document.createElement('button');
        btn.className = 'subject-card';
        btn.setAttribute('data-subject-id', subj.id);
        btn.onclick = () => {
            if (window.selectRoomSubject) window.selectRoomSubject(subj.id, document.documentElement.lang === "zh" ? subj.zh_name : subj.name);
        };
        if (document.documentElement.lang === "en")
            btn.innerHTML = `
                <div class="subject-icon"><img class="subject-icon" src="${subj.image}" alt="${subj.name}"></div>
                <div class="subject-name">${subj.name}</div>
            `;
        else
            btn.innerHTML = `
                <div class="subject-icon"><img class="subject-icon" src="${subj.image}" alt="${subj.zh_name}"></div>
                <div class="subject-name">${subj.zh_name}</div>
            `;
        grid.appendChild(btn);
    });
}

function updatePlayersList(players) {
    const container = document.getElementById('playersContainer');
    container.innerHTML = players.map(p => `
        <div class="player-item">
            <span class="player-name">${p.name}</span>
        </div>
    `).join('');
}

function selectRoomSubject(subject, subjectTitle) {
    window.setCurrentSubject(subject);
    
    // If subjectTitle not provided, find it from SUBJECTS array (same as singleplayer)
    if (!subjectTitle) {
        const subjectObj = window.SUBJECTS && window.SUBJECTS.find(s => s.id === subject);
        if (subjectObj) {
            subjectTitle = document.documentElement.lang === "zh" ? subjectObj.zh_name : subjectObj.name;
        } else {
            subjectTitle = subject;
        }
    }
    currentMultiplayerSubjectTitle = subjectTitle;
    
    // Update UI to show selected state using data attribute
    const subjectCards = document.querySelectorAll('.waiting-room-page .subject-card');
    subjectCards.forEach(card => {
        card.classList.remove('selected');
        if (card.getAttribute('data-subject-id') === subject) {
            card.classList.add('selected');
        }
    });
    
    // Notify server of subject selection for real-time sync
    if (socket && currentRoomCode) {
        socket.emit('setSubject', { roomCode: currentRoomCode, subject: subject, subjectTitle: subjectTitle });
    }
}

function startMultiplayerGame() {
    console.log('startMultiplayerGame called');
    const currentSubject = window.getCurrentSubject();
    console.log('Current subject:', currentSubject);
    console.log('Socket:', socket);
    console.log('Room code:', currentRoomCode);
    console.log('Is host:', isHost);
    
    // Check if player is the host
    if (!isHost) {
        if (!document.documentElement.lang === "zh")
            showModal('Only the host can start the game');
        else
            showModal('只有主機玩家才能開始遊戲');
        return;
    }
    
    if (!document.documentElement.lang === "zh"){
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
    }
    else{
        if (!currentSubject) {
            showModal('請選擇一個主題');
            return;
        }

        if (!socket) {
            showModal('未連接到伺服器。請嘗試重新整理頁面。');
            return;
        }

        if (!currentRoomCode) {
            showModal('未找到房間代碼。請創建或加入房間。');
            return;
        }
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
    if (document.documentElement.lang === "en"){
        const modeText = type === 'collab' ? 'Collab' : 'Compete';
        document.getElementById('roomModeSubtitle').textContent = `${modeText} Mode - Create or join a room`;
    }
    else{
        const modeText = type === 'collab' ? '協作' : '競爭';
        document.getElementById('roomModeSubtitle').textContent = `${modeText}模式-建立或加入房間`;
    }
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
function checkHostAndNotify() {
    if (!isHost) {
        if (!document.documentElement.lang === "zh")
            addSystemMessage('⏳ Waiting for the host to continue...');
        else
            addSystemMessage('⏳ 等待主機玩家繼續遊戲...');
        return false;
    }
    return true;
}

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
    
    // In compete mode, keep visual timer running for all players
    // The server will emit 'stopTimer' when all players have answered or time expires
    
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

// Start timer with specific remaining seconds (for syncing players who join mid-round)
function startTimerWithRemaining(remainingSeconds) {
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
    const totalDuration = remainingSeconds * 1000;
    const duration = totalDuration;
    
    function updateTimer() {
        const elapsed = Date.now() - timerStartTime;
        const remaining = Math.max(0, duration - elapsed);
        const remainingSecondsDisplay = Math.ceil(remaining / 1000);
        const percentage = (remaining / duration) * 100;
        
        // Update text
        timerText.textContent = `${remainingSecondsDisplay}s`;
        
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
    if (!document.documentElement.lang === "zh")
        title.textContent = 'Current Standings';
    else
        title.textContent = '目前排名';
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
        if (!document.documentElement.lang === "zh")
            levelRoomCode.textContent = `Room: ${currentRoomCode}`;
        else
            levelRoomCode.textContent = `房間: ${currentRoomCode}`;
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
    // Check if player is the host
    if (!checkHostAndNotify()) return;
    
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
    if (!document.documentElement.lang === "zh")
        addSystemMessage('🤖 Cooking up a spicy question...');
    else
        addSystemMessage('🤖 正在準備一個刺激的問題...');
    currentLoadingMessage = addLoadingMessage();
    
    // Play next question sound
    if (window.playNextQuestionSound) {
        window.playNextQuestionSound();
    }
    
    requestMultiplayerQuestion();
}

function continueFromScore() {
    if (!checkHostAndNotify()) return;
    
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
    if (!document.documentElement.lang === "zh")
        addSystemMessage('✨ Summoning next challenge...');
    else
        addSystemMessage('✨ 正在召喚下一個挑戰...');
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
    if (!document.documentElement.lang === "zh")
        addSystemMessage('🎉 Game Complete! All 12 questions finished!');
    else
        addSystemMessage('🎉 遊戲完成！所有12個問題都完成了！');

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

// Force stop answer check and return to game menu
function returnToGameMenuFromAnswerCheck() {
    // Hide all game screens
    const chatContainer = document.getElementById('chatContainer');
    const levelProgressPage = document.getElementById('levelProgressPage');
    const scoreScreen = document.getElementById('scoreScreen');
    
    if (chatContainer) chatContainer.style.display = 'none';
    if (levelProgressPage) levelProgressPage.style.display = 'none';
    if (scoreScreen) scoreScreen.style.display = 'none';
    
    // Stop timer
    hideTimer();
    
    // Stop all BGM
    if (window.stopMainBGM) window.stopMainBGM();
    if (window.stopLevelBGM) window.stopLevelBGM();
    if (window.stopLevelFirstBGM) window.stopLevelFirstBGM();
    if (window.stopLevelUpSound) window.stopLevelUpSound();
    if (window.stopLevelFailedSound) window.stopLevelFailedSound();
    
    // Reset game state
    currentLevel = 0;
    levelStatus = Array(12).fill('unanswered');
    conversationHistory = [];
    isMultiplayerActive = false;
    
    // Clear subject selection
    const subjectCards = document.querySelectorAll('.waiting-room-page .subject-card');
    subjectCards.forEach(card => card.classList.remove('selected'));
    
    // Return to waiting room
    document.getElementById('waitingRoomPage').style.display = 'flex';
    
    // Play background music
    if (window.playMainBGM) {
        window.playMainBGM();
    }
}

window.returnToGameMenuFromAnswerCheck = returnToGameMenuFromAnswerCheck;
