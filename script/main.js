// Get elements (will be accessed when needed, not immediately)
let chatMessages;

let currentMode = 'singleplayer'; // 'singleplayer' or 'multiplayer'
let currentSubject = 'History'; // Selected subject


// Navigation functions
function goToModeSelection(mode) {
    console.log('goToModeSelection called with mode:', mode);
    currentMode = mode;
    document.getElementById('landingPage').style.display = 'none';
    
    if (mode === 'multiplayer') {
        // Show multiplayer mode selection page (Collab/Compete)
        document.getElementById('multiplayerPage').style.display = 'flex';
    } else {
        // Show subject selection for singleplayer
        document.getElementById('subjectPage').style.display = 'flex';
        document.getElementById('modeSubtitle').textContent = 'Select a subject for singleplayer mode';
    }
}

function goBackToLanding() {
    document.getElementById('subjectPage').style.display = 'none';
    document.getElementById('multiplayerPage').style.display = 'none';
    document.getElementById('landingPage').style.display = 'flex';
}

function goBackToSubjects() {
    document.getElementById('chatContainer').style.display = 'none';
    document.getElementById('subjectPage').style.display = 'flex';
}

function startChat(subject) {
    currentSubject = subject;
    
    // Check if multiplayer mode
    if (currentMode === 'multiplayer') {
        // Go to room setup for multiplayer
        document.getElementById('subjectPage').style.display = 'none';
        document.getElementById('roomSetupPage').style.display = 'flex';
        
        const multiplayerType = window.getMultiplayerType();
        const modeText = multiplayerType === 'collab' ? 'Collab' : 'Compete';
        document.getElementById('roomModeSubtitle').textContent = `${subject} - ${modeText} Mode`;
        return;
    }
    
    // Singleplayer mode
    document.getElementById('subjectPage').style.display = 'none';
    document.getElementById('chatContainer').style.display = 'flex';
    
    // Update chat header
    const modeText = 'Singleplayer';
    document.getElementById('chatTitle').textContent = `${subject} - ${modeText} Mode`;
    document.getElementById('chatSubtitle').textContent = 'Is it AI or not';
    
    // Clear chat
    if (!chatMessages) chatMessages = document.getElementById('chatMessages');
    chatMessages.innerHTML = '';
    
    // Show loading message
    const loadingDiv = addLoadingMessage();
    
    // Automatically send preset question based on subject
    const presetQuestion = `Generate a ${subject.toLowerCase()} multiple choice question with 4 options. 

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
    
    // Send the preset question to AI
    const apiUrl = window.location.origin + '/chat';
    fetch(apiUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ message: presetQuestion })
    })
    .then(response => {
        if (!response.ok) {
            throw new Error('Failed to get response from AI');
        }
        return response.json();
    })
    .then(async data => {
        // Remove loading message
        loadingDiv.remove();
        
        // Store the AI-verified correct answer if provided
        if (data.correctAnswer !== undefined) {
            window.currentCorrectAnswer = data.correctAnswer;
            console.log('[Singleplayer] AI-verified correct answer stored:', data.correctAnswer);
        }
        
        // Add AI response (quiz only)
        await addMessage(data.response, 'ai');
    })
    .catch(async error => {
        console.error('Error:', error);
        loadingDiv.remove();
        await addMessage('Connection error. Please start the server with "npm start".', 'ai');
    });
}

async function addMessage(text, type) {
    if (!chatMessages) chatMessages = document.getElementById('chatMessages');
    
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${type}-message`;
    
    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';
    
    // Try to detect and parse quiz JSON format
    const result = tryParseQuizJSON(text);
    
    if (result.quizData) {
        // Only show quiz table, no before/after text
        const quizTable = await createQuizTable(result.quizData);
        contentDiv.appendChild(quizTable);
    } else {
        contentDiv.textContent = text;
    }
    
    messageDiv.appendChild(contentDiv);
    chatMessages.appendChild(messageDiv);
    
    // Scroll to bottom
    chatMessages.scrollTop = chatMessages.scrollHeight;
    
    return messageDiv;
}

function tryParseQuizJSON(text) {
    try {
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
                    quizData: {
                        question: question,
                        options: options,
                        answer: answer
                    },
                    beforeText: '',
                    afterText: ''
                };
            }
        }
        
        // Try to find JSON object in the text (even if it's not in code blocks)
        const jsonObjectMatch = text.match(/\{[\s\S]*"question"[\s\S]*\}/);
        
        if (jsonObjectMatch) {
            let jsonText = jsonObjectMatch[0];
            // Remove comments from JSON
            jsonText = jsonText.replace(/\/\*[\s\S]*?\*\//g, '');
            jsonText = jsonText.replace(/\/\/.*/g, '');
            
            // Fix malformed options array: ["A": "text", "B": "text"] to [{"A": "text"}, {"B": "text"}]
            if (/"options"\s*:\s*\[\s*"[A-F]"\s*:/.test(jsonText)) {
                console.log('Detected malformed options array format, fixing...');
                
                // Extract the options array
                const optionsMatch = jsonText.match(/"options"\s*:\s*\[([^\]]+)\]/);
                if (optionsMatch) {
                    const originalOptions = optionsMatch[0];
                    let fixedOptions = originalOptions;
                    
                    // Replace "options": ["A": with "options": [{"A":
                    fixedOptions = fixedOptions.replace(/"options"\s*:\s*\[\s*"([A-F])"\s*:/g, '"options": [{"$1":');
                    
                    // Replace , "B": with }, {"B":
                    fixedOptions = fixedOptions.replace(/,\s*"([A-F])"\s*:/g, '}, {"$1":');
                    
                    // Close the last object before the closing bracket ]
                    fixedOptions = fixedOptions.replace(/("\s*)\]$/, '$1}]');
                    
                    jsonText = jsonText.replace(originalOptions, fixedOptions);
                    console.log('Fixed options array format');
                }
            }
            
            try {
                const data = JSON.parse(jsonText);
                
                // Handle format: { question, options: [], answer: index }
                if (data.question && Array.isArray(data.options) && data.options.length > 0) {
                    const cleanOptions = data.options.map(opt => {
                        if (typeof opt === 'object') {
                            return JSON.stringify(opt);
                        }
                        return String(opt);
                    });
                    
                    return {
                        quizData: {
                            question: data.question,
                            options: cleanOptions,
                            answer: data.answer
                        },
                        beforeText: '',
                        afterText: ''
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
                            const optionText = typeof optionValue === 'object' 
                                ? JSON.stringify(optionValue) 
                                : String(optionValue);
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
                            quizData: {
                                question: data.question,
                                options: options,
                                answer: correctIndex
                            },
                            beforeText: '',
                            afterText: ''
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
                            const optionText = typeof optionValue === 'object' 
                                ? JSON.stringify(optionValue) 
                                : String(optionValue);
                            options.push(optionText);
                            
                            if (data.correct === key || data.correct === lowerKey || 
                                data.answer === key || data.answer === lowerKey) {
                                correctIndex = i;
                            }
                        } else {
                            break;
                        }
                    }
                    
                    if (options.length > 0) {
                        return {
                            quizData: {
                                question: data.question,
                                options: options,
                                answer: correctIndex
                            },
                            beforeText: '',
                            afterText: ''
                        };
                    }
                }
            } catch (e) {
                console.log('JSON parse error:', e);
            }
        }
        
        // Try to extract JSON from markdown code blocks (```json or just ```)
        const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        
        if (jsonMatch) {
            let jsonText = jsonMatch[1].trim();
            // Remove comments from JSON (single-line // and multi-line /* */)
            jsonText = jsonText.replace(/\/\*[\s\S]*?\*\//g, ''); // Remove /* */ comments
            jsonText = jsonText.replace(/\/\/.*/g, ''); // Remove // comments
            const beforeText = text.substring(0, jsonMatch.index).trim();
            const afterText = text.substring(jsonMatch.index + jsonMatch[0].length).trim();
            
            try {
                const data = JSON.parse(jsonText);
                
                // Handle format: { question, options: [], answer: index }
                if (data.question && Array.isArray(data.options) && data.options.length > 0) {
                    // Ensure all options are strings
                    const cleanOptions = data.options.map(opt => {
                        if (typeof opt === 'object') {
                            return JSON.stringify(opt);
                        }
                        return String(opt);
                    });
                    
                    return {
                        quizData: {
                            question: data.question,
                            options: cleanOptions,
                            answer: data.answer
                        },
                        beforeText: beforeText,
                        afterText: afterText
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
                            const optionText = typeof optionValue === 'object' 
                                ? JSON.stringify(optionValue) 
                                : String(optionValue);
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
                            quizData: {
                                question: data.question,
                                options: options,
                                answer: correctIndex
                            },
                            beforeText: beforeText,
                            afterText: afterText
                        };
                    }
                }
                
                // Handle format: { question, A, B, C, D, correct: "A" }
                if (data.question && (data.A || data.a)) {
                    // Convert to standard format
                    const options = [];
                    const keys = ['A', 'B', 'C', 'D', 'E', 'F'];
                    let correctIndex = -1;
                    
                    for (let i = 0; i < keys.length; i++) {
                        const key = keys[i];
                        const lowerKey = key.toLowerCase();
                        
                        if (data[key] || data[lowerKey]) {
                            const optionValue = data[key] || data[lowerKey];
                            // Convert to string if it's an object
                            const optionText = typeof optionValue === 'object' 
                                ? JSON.stringify(optionValue) 
                                : String(optionValue);
                            options.push(optionText);
                            
                            // Check if this is the correct answer
                            if (data.correct === key || data.correct === lowerKey || 
                                data.answer === key || data.answer === lowerKey) {
                                correctIndex = i;
                            }
                        } else {
                            break;
                        }
                    }
                    
                    if (options.length > 0) {
                        return {
                            quizData: {
                                question: data.question,
                                options: options,
                                answer: correctIndex
                            },
                            beforeText: beforeText,
                            afterText: afterText
                        };
                    }
                }
            } catch (e) {
                // Not valid JSON
            }
        }
        
        // Try parsing the entire text as JSON (no code blocks)
        try {
            let cleanText = text.trim();
            // Remove comments from JSON
            cleanText = cleanText.replace(/\/\*[\s\S]*?\*\//g, ''); // Remove /* */ comments
            cleanText = cleanText.replace(/\/\/.*/g, ''); // Remove // comments
            
            const data = JSON.parse(cleanText);
            
            if (data.question && Array.isArray(data.options) && data.options.length > 0) {
                // Ensure all options are strings
                const cleanOptions = data.options.map(opt => {
                    if (typeof opt === 'object') {
                        return JSON.stringify(opt);
                    }
                    return String(opt);
                });
                
                return { 
                    quizData: {
                        question: data.question,
                        options: cleanOptions,
                        answer: data.answer
                    }, 
                    beforeText: '', 
                    afterText: '' 
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
                        const optionText = typeof optionValue === 'object' 
                            ? JSON.stringify(optionValue) 
                            : String(optionValue);
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
                        quizData: {
                            question: data.question,
                            options: options,
                            answer: correctIndex
                        },
                        beforeText: '',
                        afterText: ''
                    };
                }
            }
            
            // Handle A/B/C/D format
            if (data.question && (data.A || data.a)) {
                const options = [];
                const keys = ['A', 'B', 'C', 'D', 'E', 'F'];
                let correctIndex = -1;
                
                for (let i = 0; i < keys.length; i++) {
                    const key = keys[i];
                    const lowerKey = key.toLowerCase();
                    
                    if (data[key] || data[lowerKey]) {
                        const optionValue = data[key] || data[lowerKey];
                        // Convert to string if it's an object
                        const optionText = typeof optionValue === 'object' 
                            ? JSON.stringify(optionValue) 
                            : String(optionValue);
                        options.push(optionText);
                        
                        if (data.correct === key || data.correct === lowerKey || 
                            data.answer === key || data.answer === lowerKey) {
                            correctIndex = i;
                        }
                    } else {
                        break;
                    }
                }
                
                if (options.length > 0) {
                    return {
                        quizData: {
                            question: data.question,
                            options: options,
                            answer: correctIndex
                        },
                        beforeText: '',
                        afterText: ''
                    };
                }
            }
        } catch (e) {
            // Not valid JSON
        }
    } catch (e) {
        // Error in parsing
    }
    
    return { quizData: null };
}

// Client-side AI verification removed - all verification now happens server-side

async function createQuizTable(quizData) {
    const container = document.createElement('div');
    container.className = 'quiz-container';
    
    // Question only - no extra styling div
    const questionDiv = document.createElement('div');
    questionDiv.className = 'quiz-question';
    questionDiv.textContent = quizData.question;
    container.appendChild(questionDiv);
    
    // Options grid (now using div instead of table)
    const grid = document.createElement('div');
    grid.className = 'quiz-table';
    
    quizData.options.forEach((option, index) => {
        const optionDiv = document.createElement('div');
        optionDiv.className = 'quiz-option';
        
        const textSpan = document.createElement('span');
        textSpan.className = 'option-text';
        textSpan.textContent = option;
        
        optionDiv.appendChild(textSpan);
        
        // Make option clickable - pass the parsed answer (AI verification happens server-side)
        optionDiv.addEventListener('click', function() {
            handleAnswerSelection(optionDiv, index, quizData.answer, grid, quizData.question, option);
        });
        
        grid.appendChild(optionDiv);
    });
    
    container.appendChild(grid);
    
    // Notify that question UI is ready (buttons are clickable) - for multiplayer
    if (window.multiplayerMode && typeof window.notifyQuestionReady === 'function') {
        // Use setTimeout to ensure buttons are fully rendered in DOM
        setTimeout(() => {
            window.notifyQuestionReady();
        }, 0);
    }
    
    // No answer info displayed
    
    return container;
}

// Client-side verifyAnswerWithAI function removed - all verification now happens server-side

async function handleAnswerSelection(selectedRow, selectedIndex, correctAnswer, table, question, selectedAnswer) {
    // Prevent multiple selections
    if (table.classList.contains('answered')) return;
    
    // Stop timer IMMEDIATELY at the first line - before any processing
    const multiplayerState = window.getMultiplayerState();
    const isMultiplayer = multiplayerState && multiplayerState.isActive;
    if (isMultiplayer && typeof window.stopTimer === 'function') {
        window.stopTimer();
    }
    
    table.classList.add('answered');
    
    const rows = table.querySelectorAll('.quiz-option');
    
    // In multiplayer, don't verify answer on client - server will do it after timer stops
    if (isMultiplayer) {
        // In multiplayer: only show which option was selected (no colors yet)
        rows.forEach((row, index) => {
            row.style.pointerEvents = 'none';
            if (index === selectedIndex) {
                row.style.opacity = '0.7';
                row.style.backgroundColor = '#2c2c2e';
            }
        });
        
        // Send answer to server (server will verify with AI after timer stops)
        console.log('Submitting multiplayer answer:', selectedIndex);
        window.submitMultiplayerAnswer(selectedIndex);
        
        // Don't add action buttons in multiplayer - wait for reveal
        return;
    }
    
    // Singleplayer: reveal immediately using the AI-verified correctAnswer from server
    const aiVerifiedAnswer = window.currentCorrectAnswer;
    console.log('[Singleplayer] Using AI-verified answer:', aiVerifiedAnswer, 'Selected:', selectedIndex);
    
    rows.forEach((row, index) => {
        row.style.pointerEvents = 'none';
        
        if (aiVerifiedAnswer !== undefined) {
            if (index === aiVerifiedAnswer) {
                row.classList.add('correct');
            } else if (index === selectedIndex) {
                row.classList.add('incorrect');
            }
        } else if (correctAnswer !== undefined) {
            // Fallback to parsed correctAnswer if AI verification not available
            if (index === correctAnswer) {
                row.classList.add('correct');
            } else if (index === selectedIndex) {
                row.classList.add('incorrect');
            }
        } else {
            if (index === selectedIndex) {
                row.classList.add('selected');
            }
        }
    });
    
    // Add action buttons after answering
    const quizContainer = table.closest('.quiz-container');
    if (quizContainer && !quizContainer.querySelector('.quiz-actions')) {
        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'quiz-actions';
        
        const backBtn = document.createElement('button');
        backBtn.className = 'quiz-action-btn back-btn';
        backBtn.textContent = 'Back';
        backBtn.addEventListener('click', goBackToSubjects);
        
        const continueBtn = document.createElement('button');
        continueBtn.className = 'quiz-action-btn continue-btn';
        continueBtn.textContent = 'Continue';
        continueBtn.addEventListener('click', () => {
            // Generate new question
            if (!chatMessages) chatMessages = document.getElementById('chatMessages');
            chatMessages.innerHTML = '';
            const loadingDiv = addLoadingMessage();
            
            const multiplayerState = window.getMultiplayerState();
            if (multiplayerState.isActive && multiplayerState.socket) {
                // Multiplayer: request new question via socket
                window.requestMultiplayerQuestion();
                loadingDiv.remove();
            } else {
                // Singleplayer: fetch from API
                const presetQuestion = `Make a ${currentSubject.toLowerCase()} question with 4 MC (Multiple Choice) options in JSON format with only {
                        "question": "...",
                        "options": ["A": "" , "B": "" , "C": "" , "D": ""],
                        "answer": ""
                        } format.`;
                
                const apiUrl = window.location.origin + '/chat';
                fetch(apiUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ message: presetQuestion })
                })
                .then(response => response.json())
                .then(async data => {
                    loadingDiv.remove();
                    await addMessage(data.response, 'ai');
                })
                .catch(async error => {
                    console.error('Error:', error);
                    loadingDiv.remove();
                    await addMessage('Sorry, I encountered an error. Please try again.', 'ai');
                });
            }
        });
        
        actionsDiv.appendChild(backBtn);
        actionsDiv.appendChild(continueBtn);
        quizContainer.appendChild(actionsDiv);
    }
}

function addLoadingMessage() {
    if (!chatMessages) chatMessages = document.getElementById('chatMessages');
    
    const messageDiv = document.createElement('div');
    messageDiv.className = 'loading-message';
    messageDiv.innerHTML = '<div class="loading-ring"></div>';
    
    chatMessages.appendChild(messageDiv);
    
    // Scroll to bottom
    chatMessages.scrollTop = chatMessages.scrollHeight;
    
    return messageDiv;
}

// Expose functions to global scope for onclick handlers
// Expose functions to global scope for onclick handlers
console.log('Registering global functions...');
console.log('goToModeSelection exists?', typeof goToModeSelection);
console.log('startChat exists?', typeof startChat);

window.goToModeSelection = goToModeSelection;
window.goBackToLanding = goBackToLanding;
window.goBackToSubjects = goBackToSubjects;
window.startChat = startChat;
window.addMessage = addMessage;
window.getCurrentSubject = () => currentSubject;
window.setCurrentSubject = (subject) => { currentSubject = subject; };

console.log('Global functions registered successfully');