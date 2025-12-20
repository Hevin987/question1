// ============================================================================
// UNIFIED GAME SEQUENCE (SINGLEPLAYER & MULTIPLAYER):
// Client-side implementation
//
// STEP 1: Game starts (user clicks singleplayer/multiplayer)
// STEP 2: AI generates question with 4 options (server)
// STEP 3: AI verifies the answer (server) - if no correct answer, regenerate
// STEP 4: Question is sent to client(s)
// STEP 5: Client(s) render UI and timer starts (30 seconds)
// STEP 6: Player(s) select answer or timer expires
// STEP 7: Server verifies answer with AI and calculates score
// STEP 8: Results are revealed to all player(s)
// ============================================================================

//command selectRoomSubject('History')

// Get elements (will be accessed when needed, not immediately)
let chatMessages;

let currentMode = 'singleplayer'; // 'singleplayer' or 'multiplayer'
let currentSubject = 'History'; // Selected subject
let CurrentSubjectTitle = ''; // Current subject title for display

// Audio management
let audioContext = null;
let mainBGMIntro = null;
let mainBGMLoop = null;
let introBuffer = null;
let loopBuffer = null;
let currentSource = null;
let isInGame = false;
let hasPlayedIntro = false;
let introEndTime = 0;
let isPlaying = false; // Track if audio is currently playing
let startBGM = true; // Track if we should start BGM on first click

// Level BGM (intro + loop)
let levelBGMIntroBuffer = null;
let levelBGMLoopBuffer = null;
let levelBGMSource = null;
let levelBGMPlaying = false;
let levelBGMIntroPlayed = false;

// Sound effects
let correctSound = null;
let wrongSound = null;
let levelFirstBGM = null;
let nextQuestionSound = null;
let levelUpSound = null;
let levelFailedSound = null;

function initSoundEffects() {
    if (!correctSound) {
        correctSound = new Audio('audio/right.ogg');
        correctSound.volume = 0.6;
        correctSound.preload = 'auto';
    }
    if (!wrongSound) {
        wrongSound = new Audio('audio/wrong.ogg');
        wrongSound.volume = 0.6;
        wrongSound.preload = 'auto';
    }
    if (!levelFirstBGM) {
        levelFirstBGM = new Audio('audio/levelfirstlevelbgm.ogg');
        levelFirstBGM.volume = 0.5;
        levelFirstBGM.preload = 'auto';
    }
    if (!nextQuestionSound) {
        nextQuestionSound = new Audio('audio/nextquestion.ogg');
        nextQuestionSound.volume = 0.6;
        nextQuestionSound.preload = 'auto';
    }
    if (!levelUpSound) {
        levelUpSound = new Audio('audio/levelup.ogg');
        levelUpSound.volume = 0.6;
        levelUpSound.preload = 'auto';
    }
    if (!levelFailedSound) {
        levelFailedSound = new Audio('audio/levelfailed.ogg');
        levelFailedSound.volume = 0.6;
        levelFailedSound.preload = 'auto';
    }
}

function playCorrectSound() {
    initSoundEffects();
    correctSound.currentTime = 0;
    correctSound.play().catch(e => console.log('Correct sound play failed:', e));
}

function playWrongSound() {
    initSoundEffects();
    wrongSound.currentTime = 0;
    wrongSound.play().catch(e => console.log('Wrong sound play failed:', e));
}

function playLevelFirstBGM() {
    initSoundEffects();
    levelFirstBGM.currentTime = 0;
    levelFirstBGM.play().catch(e => console.log('Level first BGM play failed:', e));
}

function stopLevelFirstBGM() {
    if (levelFirstBGM) {
        levelFirstBGM.pause();
        levelFirstBGM.currentTime = 0;
    }
}

function playLevelUpSound() {
    initSoundEffects();
    levelUpSound.currentTime = 0;
    levelUpSound.play().catch(e => console.log('Level up sound play failed:', e));
}

function stopLevelUpSound() {
    if (levelUpSound) {
        levelUpSound.pause();
        levelUpSound.currentTime = 0;
    }
}

function playNextQuestionSound() {
    initSoundEffects();
    nextQuestionSound.currentTime = 0;
    nextQuestionSound.play().catch(e => console.log('Next question sound play failed:', e));
}

function playLevelFailedSound() {
    initSoundEffects();
    levelFailedSound.currentTime = 0;
    levelFailedSound.play().catch(e => console.log('Level failed sound play failed:', e));
}

function stopLevelFailedSound() {
    if (levelFailedSound) {
        levelFailedSound.pause();
        levelFailedSound.currentTime = 0;
    }
}

function playLevelBGM() {
    if (!audioContext || levelBGMPlaying) return;
    
    if (!levelBGMIntroPlayed) {
        // Play intro first
        if (!levelBGMIntroBuffer) {
            console.log('Level BGM intro not loaded yet');
            return;
        }
        
        console.log('Playing level BGM intro');
        levelBGMSource = audioContext.createBufferSource();
        levelBGMSource.buffer = levelBGMIntroBuffer;
        
        const gainNode = audioContext.createGain();
        gainNode.gain.value = 0.5;
        
        levelBGMSource.connect(gainNode);
        gainNode.connect(audioContext.destination);
        
        levelBGMSource.onended = () => {
            console.log('Level BGM intro ended, starting loop');
            levelBGMPlaying = false;
            if (levelBGMSource) {
                levelBGMIntroPlayed = true;
                playLevelBGMLoop();
            }
        };
        
        levelBGMSource.start(0);
        levelBGMPlaying = true;
    } else {
        // Intro already played, just play loop
        playLevelBGMLoop();
    }
}

function playLevelBGMLoop() {
    if (!audioContext || !levelBGMLoopBuffer || levelBGMPlaying) return;
    
    console.log('Playing level BGM loop');
    levelBGMSource = audioContext.createBufferSource();
    levelBGMSource.buffer = levelBGMLoopBuffer;
    levelBGMSource.loop = true;
    
    const gainNode = audioContext.createGain();
    gainNode.gain.value = 0.5;
    
    levelBGMSource.connect(gainNode);
    gainNode.connect(audioContext.destination);
    
    levelBGMSource.start(0);
    levelBGMPlaying = true;
}

function stopLevelBGM() {
    console.log('stopLevelBGM called');
    if (levelBGMSource) {
        try {
            const sourceToStop = levelBGMSource;
            levelBGMSource = null;
            sourceToStop.stop();
            levelBGMPlaying = false;
            levelBGMIntroPlayed = false;
            console.log('Level BGM stopped');
        } catch (e) {
            levelBGMSource = null;
            levelBGMPlaying = false;
            levelBGMIntroPlayed = false;
        }
    }
}

function initAudio() {
    if (!audioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    
    // Load intro audio
    if (!introBuffer) {
        fetch('audio/mainbgm.ogg')
            .then(response => response.arrayBuffer())
            .then(arrayBuffer => audioContext.decodeAudioData(arrayBuffer))
            .then(buffer => {
                introBuffer = buffer;
                console.log('Intro loaded, duration:', buffer.duration);
            })
            .catch(e => console.error('Error loading intro:', e));
    }
    
    // Load loop audio
    if (!loopBuffer) {
        fetch('audio/mainbgmloop.ogg')
            .then(response => response.arrayBuffer())
            .then(arrayBuffer => audioContext.decodeAudioData(arrayBuffer))
            .then(buffer => {
                loopBuffer = buffer;
                console.log('Loop loaded, duration:', buffer.duration);
            })
            .catch(e => console.error('Error loading loop:', e));
    }
    
    // Load level BGM intro
    if (!levelBGMIntroBuffer) {
        fetch('audio/levelbgm.ogg')
            .then(response => response.arrayBuffer())
            .then(arrayBuffer => audioContext.decodeAudioData(arrayBuffer))
            .then(buffer => {
                levelBGMIntroBuffer = buffer;
                console.log('Level BGM intro loaded, duration:', buffer.duration);
            })
            .catch(error => console.error('Error loading level BGM intro:', error));
    }
    
    // Load level BGM loop
    if (!levelBGMLoopBuffer) {
        fetch('audio/levelbgmloop.ogg')
            .then(response => response.arrayBuffer())
            .then(arrayBuffer => audioContext.decodeAudioData(arrayBuffer))
            .then(buffer => {
                levelBGMLoopBuffer = buffer;
                console.log('Level BGM loop loaded, duration:', buffer.duration);
            })
            .catch(error => console.error('Error loading level BGM loop:', error));
    }
}

function playLoopBGM() {
    if (isInGame || !loopBuffer || !audioContext) return;
    
    console.log('playLoopBGM called, isPlaying:', isPlaying);
    
    // Don't start if already playing
    if (isPlaying && currentSource) {
        console.log('Already playing, skipping');
        return;
    }
    
    // Stop any existing source
    if (currentSource) {
        try {
            currentSource.stop();
        } catch (e) {
            // Already stopped
        }
    }
    
    // Create source for loop
    currentSource = audioContext.createBufferSource();
    currentSource.buffer = loopBuffer;
    currentSource.loop = true;
    currentSource.loopStart = 0;
    currentSource.loopEnd = loopBuffer.duration - 0.025; // Slightly before end to avoid gap
    
    // Create gain node for volume control
    const gainNode = audioContext.createGain();
    gainNode.gain.value = 0.5;
    
    currentSource.connect(gainNode);
    gainNode.connect(audioContext.destination);
    
    currentSource.start(0);
    isPlaying = true;
    console.log('Loop started');
}

function playMainBGM() {
    console.log('playMainBGM called, isInGame:', isInGame, 'hasPlayedIntro:', hasPlayedIntro, 'isPlaying:', isPlaying);
    
    if (isInGame) {
        console.log('Not playing - in game');
        return;
    }
    
    // Don't start if already playing
    if (isPlaying && currentSource) {
        console.log('Already playing, skipping');
        return;
    }
    
    if (!audioContext) {
        console.log('No audio context, initializing...');
        initAudio();
    }
    
    // Resume audio context if suspended (for autoplay policy)
    if (audioContext && audioContext.state === 'suspended') {
        console.log('Audio context suspended, resuming...');
        audioContext.resume().then(() => {
            console.log('Audio context resumed');
            playMainBGM(); // Retry after resuming
        });
        return;
    }
    
    // Wait for buffers to load before playing
    if (!introBuffer || !loopBuffer) {
        console.log('Waiting for buffers to load...', 'intro:', !!introBuffer, 'loop:', !!loopBuffer);
        setTimeout(() => playMainBGM(), 100);
        return;
    }
    
    if (!hasPlayedIntro) {
        console.log('Playing intro for first time');
        // Stop any existing source
        if (currentSource) {
            try {
                currentSource.stop();
            } catch (e) {}
        }
        
        // Play intro
        currentSource = audioContext.createBufferSource();
        currentSource.buffer = introBuffer;
        
        const gainNode = audioContext.createGain();
        gainNode.gain.value = 0.5;
        
        currentSource.connect(gainNode);
        gainNode.connect(audioContext.destination);
        
        // When intro ends, start loop
        currentSource.onended = () => {
            console.log('Intro ended');
            isPlaying = false;
            // Only continue to loop if still supposed to be playing (not stopped or in game)
            if (!isInGame && currentSource) {
                hasPlayedIntro = true;
                playLoopBGM();
            }
        };
        
        currentSource.start(0);
        isPlaying = true;
        console.log('Intro started, duration:', introBuffer.duration);
    } else {
        console.log('Intro already played, playing loop');
        // Intro already played, just play loop
        playLoopBGM();
    }
}

function stopMainBGM() {
    console.log('stopMainBGM called');
    if (currentSource) {
        try {
            // Remove the reference before stopping to prevent onended callback
            const sourceToStop = currentSource;
            currentSource = null;
            sourceToStop.stop();
            isPlaying = false;
            console.log('Audio stopped');
        } catch (e) {
            // Already stopped
            currentSource = null;
            isPlaying = false;
        }
    }
}

// Auto-play music when page loads
window.addEventListener('DOMContentLoaded', () => {
    // Initialize audio context and load all audio files
    initAudio();
    // Preload all sound effects
    initSoundEffects();
});

// Modern alert modal functions
function showModal(message) {
    const overlay = document.getElementById('modalOverlay');
    const messageEl = document.getElementById('modalMessage');
    if (overlay && messageEl) {
        messageEl.textContent = message;
        overlay.style.display = 'flex';
    }
}

function closeModal() {
    const overlay = document.getElementById('modalOverlay');
    if (overlay) {
        overlay.style.display = 'none';
    }
}

// Expose modal functions globally
window.showModal = showModal;
window.closeModal = closeModal;


// Navigation functions
// Subject data array (name, image, id)
window.SUBJECTS = [
    { name: 'History', zh_name: '歷史', image: 'image/hist.png', id: 'History' },
    { name: 'Chinese History', zh_name: '中國歷史', image: 'image/chist.png', id: '中文的中國歷史' },
    { name: 'Cantonese', zh_name: '粵語', image: 'image/canton.webp', id: '粵語' },
    { name: 'Science', zh_name: '科學', image: 'image/science.png', id: 'Science' },
    { name: 'Physics', zh_name: '物理學', image: 'image/phy.png', id: 'Physics' },
    { name: 'Math', zh_name: '數學', image: 'image/math.png', id: 'Math' },
    { name: 'Geography', zh_name: '地理', image: 'image/geo.png', id: 'Geography' },
    { name: 'War', zh_name: '戰爭', image: 'image/war.png', id: 'War' },
    { name: 'Music', zh_name: '音樂', image: 'image/music.png', id: 'Music Theory' },
    { name: 'Music Technology', zh_name: '音樂科技', image: 'image/musictech.png', id: 'Music Technology' },
    { name: 'EDM', zh_name: '電子舞曲', image: 'image/edm.png', id: 'electonic dance music' },
    { name: 'World Trigger', zh_name: '境界触发者', image: 'image/worldTrigger.png', id: 'World Trigger TV Series' },
    { name: 'Minecraft', zh_name: '我的世界', image: 'image/minecraft.png', id: 'Minecraft' }

    // Add more subjects here if needed
];

function renderSubjectGrid(mode) {
    // mode: 'singleplayer' or 'multiplayer'
    const gridId = mode === 'singleplayer' ? 'subjectGridSingle' : 'subjectGridMulti';
    const grid = document.getElementById(gridId);
    if (!grid) return;
    grid.innerHTML = '';
    // Set grid layout class
    grid.classList.remove('grid-2x3', 'grid-2x2');
    grid.classList.add(mode === 'singleplayer' ? 'grid-2x3' : 'grid-2x2');
    
    // For singleplayer: show all subjects with scrolling in 2x3 grid
    // For multiplayer: only show first 4 subjects in 2x2 grid
    const subjectsToShow = mode === 'singleplayer' ? SUBJECTS : SUBJECTS.slice(0, 4);
    
    if(document.documentElement.lang === !"ZH"){
    subjectsToShow.forEach(subj => {
        const btn = document.createElement('button');
        btn.className = 'subject-card';
        btn.onclick = () => {
            if (mode === 'singleplayer') {
                startChat(subj.id, subj.name);
            } else {
                if (window.selectRoomSubject) window.selectRoomSubject(subj.id);
            }
        };
        btn.innerHTML = `
            <div class="subject-icon"><img class="subject-icon" src="${subj.image}" alt="${subj.name}"></div>
            <div class="subject-name">${subj.name}</div>
        `;
        grid.appendChild(btn);
    });}
    else{
    subjectsToShow.forEach(subj => {
        const btn = document.createElement('button');
        btn.className = 'subject-card';
        btn.onclick = () => {
            if (mode === 'singleplayer') {
                startChat(subj.id, subj.zh_name);
            } else {
                if (window.selectRoomSubject) window.selectRoomSubject(subj.id);
            }
        };
        btn.innerHTML = `
            <div class="subject-icon"><img class="subject-icon" src="${subj.image}" alt="${subj.zg_name}"></div>
            <div class="subject-name">${subj.zh_name}</div>
        `;
        grid.appendChild(btn);
    });}
}

// Render subject grids on page show
window.addEventListener('DOMContentLoaded', () => {
    renderSubjectGrid('singleplayer');
    renderSubjectGrid('multiplayer');
});

// If you want to re-render on mode switch, call renderSubjectGrid('singleplayer') or renderSubjectGrid('multiplayer') as needed.
function goToModeSelection(mode) {
    console.log('goToModeSelection called with mode:', mode);
    console.log('startBGM flag:', startBGM);
    
    currentMode = mode;
    document.getElementById('landingPage').style.display = 'none';
    
    // Start BGM on first button click only
    if (startBGM) {
        console.log('First mode selection, starting BGM');
        startBGM = false; // Set to false so it won't start again
        
        if (!audioContext) initAudio();
        
        // Small delay to ensure audio context is ready
        setTimeout(() => {
            if (audioContext && audioContext.state === 'suspended') {
                console.log('Audio context suspended, resuming...');
                audioContext.resume().then(() => {
                    console.log('Audio context resumed, starting playback');
                    playMainBGM();
                });
            } else {
                console.log('Audio context ready, starting playback');
                playMainBGM();
            }
        }, 100);
    }
    
    if (mode === 'multiplayer') {
        // Show multiplayer mode selection page (Collab/Compete)
        document.getElementById('multiplayerPage').style.display = 'flex';
    } else {
        // Show subject selection for singleplayer
        document.getElementById('subjectPage').style.display = 'flex';
        if(document.documentElement.lang === !"ZH")
        document.getElementById('modeSubtitle').textContent = 'Select a subject for singleplayer mode';
        else
        document.getElementById('modeSubtitle').textContent = '選擇單人模式的主題';
    }
}

function goBackToLanding() {
    document.getElementById('subjectPage').style.display = 'none';
    document.getElementById('multiplayerPage').style.display = 'none';
    document.getElementById('landingPage').style.display = 'flex';
    
    // Resume background music when returning to landing
    isInGame = false;
    playMainBGM();
}

function goBackToSubjects() {
    console.log('goBackToSubjects called');
    document.getElementById('chatContainer').style.display = 'none';
    document.getElementById('subjectPage').style.display = 'flex';
    
    // Resume background music when returning to subject selection
    isInGame = false;
    console.log('Setting isInGame to false, calling playMainBGM');
    playMainBGM();
}// Start BGM on first button click only
    if (!hasPlayedIntro && !isPlaying) {
        console.log('First mode selection, starting BGM');
        if (!audioContext) initAudio();
        
        if (audioContext && audioContext.state === 'suspended') {
            audioContext.resume().then(() => {
                console.log('Audio context resumed');
                playMainBGM();
            });
        } else {
            playMainBGM();
        }
    }
    
    

function startChat(subject, subjectTitle) {
    currentSubject = subject;
    CurrentSubjectTitle = subjectTitle;
    
    // Stop background music when entering game
    isInGame = true;
    stopMainBGM();
    
    // Check if multiplayer mode
    if (currentMode === 'multiplayer') {
        // Go to room setup for multiplayer
        document.getElementById('subjectPage').style.display = 'none';
        document.getElementById('roomSetupPage').style.display = 'flex';
        
        const multiplayerType = window.getMultiplayerType();
        if (!document.documentElement.lang === "ZH"){
            const modeText = multiplayerType === 'collab' ? 'Collab' : 'Compete';
            document.getElementById('roomModeSubtitle').textContent = `${subject} - ${modeText} Mode`;}
        else{
            const modeText = multiplayerType === 'collab' ? '合作' : '競爭';
            document.getElementById('roomModeSubtitle').textContent = `${subjectTitle} - ${modeText} 模式`;}
        return;
    }
    
    // Singleplayer mode
    document.getElementById('subjectPage').style.display = 'none';
    document.getElementById('chatContainer').style.display = 'flex';
    
    // Update chat header
    const modeText = 'Singleplayer';
    document.getElementById('chatTitle').textContent = `${CurrentSubjectTitle} - ${modeText} Mode`;
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
    <answer>Index of correct option (0-based)</answer>
</question>

Generate the question now using ONLY the XML format above:`;
    
    // Send the preset question to AI
    const apiUrl = window.location.origin + '/chat';
    fetch(apiUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ message: presetQuestion , subject: currentSubject}),
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
    
    // Play level BGM when quiz appears
    if (window.playLevelBGM) {
        window.playLevelBGM();
    }
    
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
    const multiplayerState = typeof window.getMultiplayerState === 'function' ? window.getMultiplayerState() : null;
    const isMultiplayer = multiplayerState && multiplayerState.isActive;
    if (isMultiplayer && typeof window.stopTimer === 'function') {
        window.stopTimer();
    }
    
    table.classList.add('answered');
    
    // Stop level BGM when answer is selected
    if (window.stopLevelBGM) {
        window.stopLevelBGM();
    }
    
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
    
    // ============================================================================
    // SINGLEPLAYER: STEP 7-8 - Call server to check answer with AI
    // ============================================================================
    console.log('[Singleplayer] STEP 7: Submitting answer to server for AI verification');
    
    // Disable all options while checking
    rows.forEach(row => {
        row.style.pointerEvents = 'none';
        row.style.opacity = '0.7';
    });
    
    try {
        // Get all option texts for verification
        const allOptions = Array.from(rows).map(row => 
            row.querySelector('.option-text').textContent
        );
        
        // Send to server for AI verification
        const response = await fetch(window.location.origin + '/checkAnswer', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ 
                question: question,
                selectedAnswer: selectedAnswer,
                allOptions: allOptions,
                correctAnswerIndex: correctAnswer  // Pass the correct answer index from parsed XML
            }),
        });
        
        const result = await response.json();
        const isCorrect = result.isCorrect;
        const correctAnswerIndex = result.correctAnswerIndex;
        
        console.log('[Singleplayer] STEP 8: AI verification complete - Correct: ' + isCorrect);
        
        // Play sound effect based on result
        if (isCorrect) {
            playCorrectSound();
        } else {
            playWrongSound();
        }
        
        // Highlight answers - show what was selected and what was correct
        rows.forEach((row, index) => {
            row.style.pointerEvents = 'none';
            
            // Show correct answer in green
            if (index === correctAnswerIndex) {
                row.classList.add('correct');
            }
            
            // Show selected answer (red if wrong)
            if (index === selectedIndex && !isCorrect) {
                row.classList.add('incorrect');
            }
        });
        
    } catch (error) {
        console.error('[Singleplayer] Error checking answer:', error);
        
        // Fallback: use parsed correctAnswer if available
        const fallbackCorrect = (selectedIndex === correctAnswer);
        
        if (fallbackCorrect) {
            playCorrectSound();
        } else {
            playWrongSound();
        }
        
        rows.forEach((row, index) => {
            row.style.pointerEvents = 'none';
            
            if (index === correctAnswer) {
                row.classList.add('correct');
            } else if (index === selectedIndex && !fallbackCorrect) {
                row.classList.add('incorrect');
            }
        });
    }
    
    // Add action buttons after answer is revealed
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
        if (!document.documentElement.lang === "ZH")
            continueBtn.textContent = 'Continue';
        else
            continueBtn.textContent = '繼續';
        continueBtn.addEventListener('click', () => {
            // Play next question sound
            if (window.playNextQuestionSound) {
                window.playNextQuestionSound();
            }
            
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
                const presetQuestion = `Make a ${currentSubject.toLowerCase()} multiple choice question with 4 options.

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

Generate the question now using ONLY the XML format above:`;
                
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
                    
                    // Store the AI-verified correct answer if provided
                    if (data.correctAnswer !== undefined) {
                        window.currentCorrectAnswer = data.correctAnswer;
                        console.log('[Singleplayer] AI-verified correct answer stored:', data.correctAnswer);
                    }
                    
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
window.playMainBGM = playMainBGM;
window.stopMainBGM = stopMainBGM;
window.playCorrectSound = playCorrectSound;
window.playWrongSound = playWrongSound;
window.playLevelFirstBGM = playLevelFirstBGM;
window.stopLevelFirstBGM = stopLevelFirstBGM;
window.playLevelUpSound = playLevelUpSound;
window.stopLevelUpSound = stopLevelUpSound;
window.playNextQuestionSound = playNextQuestionSound;
window.playLevelFailedSound = playLevelFailedSound;
window.stopLevelFailedSound = stopLevelFailedSound;
window.playLevelBGM = playLevelBGM;
window.stopLevelBGM = stopLevelBGM;

console.log('Global functions registered successfully');