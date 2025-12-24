/**
 * Server Display Module
 * Handles client-side display of server logs and status information
 * Manages real-time updates and console UI interactions
 */

(function() {
    'use strict';

    // Configuration
    const CONFIG = {
        MAX_LOG_ENTRIES: 1000,
        LOG_UPDATE_INTERVAL: 100,
        AUTO_SCROLL_THRESHOLD: 50,
        TIMESTAMP_FORMAT: 'HH:mm:ss'
    };

    // State management
    let state = {
        isConnected: false,
        logs: [],
        logBuffer: [],
        lastUpdateTime: 0,
        autoScroll: true,
        filterLevel: null,
        socket: null
    };

    /**
     * Initialize the server display module
     */
    function init() {
        console.log('Server Display Module initializing...');
        
        // Setup DOM elements
        setupDOMElements();
        
        // Setup event listeners
        setupEventListeners();
        
        // Initialize auto-scroll observer
        initAutoScrollObserver();
        
        // Load initial logs from server
        loadInitialLogs();
        
        // Try to connect to server for real-time updates
        connectToServer();
        
        console.log('Server Display Module initialized');
    }

    /**
     * Load initial logs from the server
     */
    function loadInitialLogs() {
        // Try multiple endpoints to get logs
        const endpoints = ['/api/logs', '/logs', '/getLogs'];
        
        const tryEndpoint = (index) => {
            if (index >= endpoints.length) {
                console.warn('Could not fetch logs from any endpoint');
                addLog('📡 Waiting for new logs...', 'info');
                return;
            }

            fetch(endpoints[index])
                .then(response => {
                    if (!response.ok) {
                        throw new Error(`HTTP ${response.status}`);
                    }
                    return response.json();
                })
                .then(data => {
                    if (Array.isArray(data)) {
                        // If data is an array of log objects
                        data.forEach(logEntry => {
                            addLog(logEntry.message || logEntry, logEntry.level || 'info', logEntry.timestamp);
                        });
                    } else if (data.logs && Array.isArray(data.logs)) {
                        // If data has a logs property
                        data.logs.forEach(logEntry => {
                            addLog(logEntry.message || logEntry, logEntry.level || 'info', logEntry.timestamp);
                        });
                    }
                    console.log('Initial logs loaded from ' + endpoints[index]);
                })
                .catch(error => {
                    console.log(`Endpoint ${endpoints[index]} not available, trying next...`);
                    tryEndpoint(index + 1);
                });
        };

        tryEndpoint(0);
    }

    /**
     * Setup DOM elements and cache references
     */
    function setupDOMElements() {
        // Get references to key elements
        window.serverDisplay = {
            console: document.getElementById('console'),
            statusDot: document.getElementById('statusDot'),
            statusText: document.getElementById('statusText'),
            connectionInfo: document.getElementById('connectionInfo'),
            clearLogBtn: document.getElementById('clearLogBtn'),
            downloadLogsBtn: document.getElementById('downloadLogsBtn'),
            resetServerBtn: document.getElementById('resetServerBtn'),
            autoScrollToggle: document.getElementById('autoScrollToggle')
        };

        // Verify all elements exist
        if (!window.serverDisplay.console) {
            console.warn('Server display console element not found');
        }
    }

    /**
     * Setup event listeners for buttons and controls
     */
    function setupEventListeners() {
        if (window.serverDisplay.clearLogBtn) {
            window.serverDisplay.clearLogBtn.addEventListener('click', clearLogs);
        }

        if (window.serverDisplay.downloadLogsBtn) {
            window.serverDisplay.downloadLogsBtn.addEventListener('click', downloadLogs);
        }

        if (window.serverDisplay.resetServerBtn) {
            window.serverDisplay.resetServerBtn.addEventListener('click', resetServer);
        }

        if (window.serverDisplay.autoScrollToggle) {
            window.serverDisplay.autoScrollToggle.addEventListener('click', toggleAutoScroll);
        }

        // Handle window resize to adjust layout
        window.addEventListener('resize', onWindowResize);
    }

    /**
     * Initialize observer for auto-scroll functionality
     */
    function initAutoScrollObserver() {
        if (!window.serverDisplay.console) return;

        const observer = new MutationObserver(() => {
            if (state.autoScroll) {
                scrollToBottom();
            }
        });

        observer.observe(window.serverDisplay.console, {
            childList: true,
            subtree: true
        });
    }

    /**
     * Connect to the server via WebSocket
     */
    function connectToServer() {
        try {
            if (window.io) {
                // Using Socket.io if available
                const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
                const socketUrl = window.location.origin;

                state.socket = io(socketUrl, {
                    reconnection: true,
                    reconnectionDelay: 1000,
                    reconnectionDelayMax: 5000,
                    reconnectionAttempts: 5
                });

                state.socket.on('connect', onServerConnect);
                state.socket.on('disconnect', onServerDisconnect);
                state.socket.on('log', onServerLog);
                state.socket.on('serverLog', onServerLog);
                state.socket.on('playerUpdate', onPlayerUpdate);
                state.socket.on('roomUpdate', onRoomUpdate);
                state.socket.on('serverStatus', onServerStatus);
                state.socket.on('message', onServerMessage);
            } else {
                console.warn('Socket.io not available, will use polling for logs');
                setStatusConnected();
                // Start polling for new logs
                startLogPolling();
            }
        } catch (error) {
            console.error('Failed to initialize server connection:', error);
            setStatusDisconnected();
            startLogPolling();
        }
    }

    /**
     * Start polling for new logs (fallback when WebSocket unavailable)
     */
    let lastLogTime = Date.now();
    function startLogPolling() {
        setInterval(() => {
            fetch('/api/logs?since=' + lastLogTime)
                .then(response => {
                    if (!response.ok) {
                        throw new Error(`HTTP ${response.status}`);
                    }
                    return response.json();
                })
                .then(data => {
                    if (Array.isArray(data) && data.length > 0) {
                        data.forEach(logEntry => {
                            if (logEntry.timestamp) {
                                lastLogTime = Math.max(lastLogTime, new Date(logEntry.timestamp).getTime());
                            }
                            addLog(logEntry.message || logEntry, logEntry.level || 'info', logEntry.timestamp);
                        });
                    }
                })
                .catch(error => {
                    // Silently fail for polling
                });
        }, 1000); // Poll every 1 second
    }

    /**
     * Handle server connection established
     */
    function onServerConnect() {
        console.log('Connected to server');
        setStatusConnected();
        addLog('✓ Connected to server', 'success');
    }

    /**
     * Handle server disconnection
     */
    function onServerDisconnect() {
        console.log('Disconnected from server');
        setStatusDisconnected();
        addLog('✗ Disconnected from server', 'error');
    }

    /**
     * Handle incoming log from server
     */
    function onServerLog(data) {
        if (data && data.message) {
            addLog(data.message, data.level || 'info', data.timestamp);
        } else if (typeof data === 'string') {
            addLog(data, 'info');
        }
    }

    /**
     * Handle generic message from server
     */
    function onServerMessage(data) {
        if (data) {
            if (typeof data === 'string') {
                addLog(data, 'info');
            } else if (data.message) {
                addLog(data.message, data.level || 'info', data.timestamp);
            }
        }
    }

    /**
     * Handle player update from server
     */
    function onPlayerUpdate(data) {
        if (data) {
            const message = `👤 Player Update: ${JSON.stringify(data)}`;
            addLog(message, 'info');
        }
    }

    /**
     * Handle room update from server
     */
    function onRoomUpdate(data) {
        if (data) {
            const message = `🎮 Room Update: ${JSON.stringify(data)}`;
            addLog(message, 'info');
        }
    }

    /**
     * Handle server status update
     */
    function onServerStatus(data) {
        if (data) {
            const message = `📊 Server Status: Players: ${data.playerCount || 0}, Rooms: ${data.roomCount || 0}`;
            addLog(message, 'info');
        }
    }

    /**
     * Add a log entry to the display
     */
    function addLog(message, level = 'info', timestamp = null) {
        if (!message) return;

        const time = timestamp ? new Date(timestamp) : new Date();
        const logEntry = {
            message: String(message),
            level: level,
            timestamp: time,
            id: Date.now() + Math.random()
        };

        // Add to log buffer
        state.logBuffer.push(logEntry);
        state.logs.push(logEntry);

        // Trim logs if exceeding max entries
        if (state.logs.length > CONFIG.MAX_LOG_ENTRIES) {
            state.logs.shift();
        }

        // Render immediately for better responsiveness
        renderLogs();
    }

    /**
     * Render log entries to the console display
     */
    function renderLogs() {
        if (!window.serverDisplay.console || state.logBuffer.length === 0) return;

        state.logBuffer.forEach(logEntry => {
            const logElement = createLogElement(logEntry);
            window.serverDisplay.console.appendChild(logElement);
        });

        state.logBuffer = [];

        if (state.autoScroll) {
            scrollToBottom();
        }
    }

    /**
     * Create a DOM element for a log entry
     */
    function createLogElement(logEntry) {
        const div = document.createElement('div');
        div.className = `log-entry log-${logEntry.level}`;
        div.dataset.timestamp = logEntry.timestamp.getTime();

        const timeStr = formatTime(logEntry.timestamp);
        const levelBadge = `<span class="log-level">[${logEntry.level.toUpperCase()}]</span>`;
        const messageSpan = `<span class="log-message">${escapeHtml(logEntry.message)}</span>`;

        div.innerHTML = `<span class="log-time">${timeStr}</span> ${levelBadge} ${messageSpan}`;

        return div;
    }

    /**
     * Format timestamp for display
     */
    function formatTime(date) {
        if (!(date instanceof Date)) {
            date = new Date(date);
        }

        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        const seconds = String(date.getSeconds()).padStart(2, '0');

        return `${hours}:${minutes}:${seconds}`;
    }

    /**
     * Escape HTML special characters
     */
    function escapeHtml(text) {
        const map = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;'
        };
        return text.replace(/[&<>"']/g, m => map[m]);
    }

    /**
     * Scroll console to bottom
     */
    function scrollToBottom() {
        if (!window.serverDisplay.console) return;

        setTimeout(() => {
            window.serverDisplay.console.scrollTop = window.serverDisplay.console.scrollHeight;
        }, 0);
    }

    /**
     * Check if should auto-scroll based on scroll position
     */
    function shouldAutoScroll() {
        if (!window.serverDisplay.console) return true;

        const { scrollHeight, scrollTop, clientHeight } = window.serverDisplay.console;
        const distanceFromBottom = scrollHeight - (scrollTop + clientHeight);

        return distanceFromBottom < CONFIG.AUTO_SCROLL_THRESHOLD;
    }

    /**
     * Clear all logs
     */
    function clearLogs() {
        if (confirm('Clear all logs? This action cannot be undone.')) {
            state.logs = [];
            state.logBuffer = [];
            if (window.serverDisplay.console) {
                window.serverDisplay.console.innerHTML = '';
            }
            addLog('📋 Logs cleared', 'info');
        }
    }

    /**
     * Download logs as a text file
     */
    function downloadLogs() {
        const logContent = state.logs
            .map(log => {
                const time = formatTime(log.timestamp);
                return `[${time}] [${log.level.toUpperCase()}] ${log.message}`;
            })
            .join('\n');

        const element = document.createElement('a');
        element.setAttribute('href', 'data:text/plain;charset=utf-8,' + encodeURIComponent(logContent));
        element.setAttribute('download', `server-logs-${Date.now()}.txt`);
        element.style.display = 'none';

        document.body.appendChild(element);
        element.click();
        document.body.removeChild(element);

        addLog('📥 Logs downloaded', 'success');
    }

    /**
     * Reset the server
     */
    function resetServer() {
        if (confirm('Are you sure you want to reset the server? This will disconnect all players.')) {
            if (state.socket) {
                state.socket.emit('resetServer');
                addLog('⚠️ Server reset requested', 'warn');
            } else {
                addLog('⚠️ Not connected to server', 'warn');
            }
        }
    }

    /**
     * Toggle auto-scroll functionality
     */
    function toggleAutoScroll() {
        state.autoScroll = !state.autoScroll;

        if (window.serverDisplay.autoScrollToggle) {
            window.serverDisplay.autoScrollToggle.classList.toggle('active', state.autoScroll);
            window.serverDisplay.autoScrollToggle.textContent = state.autoScroll ? 'Auto-Scroll: ON' : 'Auto-Scroll: OFF';
        }

        if (state.autoScroll) {
            scrollToBottom();
        }

        const message = `Auto-scroll ${state.autoScroll ? 'enabled' : 'disabled'}`;
        addLog(message, 'info');
    }

    /**
     * Set connection status to connected
     */
    function setStatusConnected() {
        state.isConnected = true;

        if (window.serverDisplay.statusDot) {
            window.serverDisplay.statusDot.classList.remove('disconnected');
        }

        if (window.serverDisplay.statusText) {
            window.serverDisplay.statusText.textContent = 'Connected';
        }

        if (window.serverDisplay.connectionInfo) {
            window.serverDisplay.connectionInfo.textContent = `Connected to: ${window.location.hostname}`;
        }
    }

    /**
     * Set connection status to disconnected
     */
    function setStatusDisconnected() {
        state.isConnected = false;

        if (window.serverDisplay.statusDot) {
            window.serverDisplay.statusDot.classList.add('disconnected');
        }

        if (window.serverDisplay.statusText) {
            window.serverDisplay.statusText.textContent = 'Disconnected';
        }

        if (window.serverDisplay.connectionInfo) {
            window.serverDisplay.connectionInfo.textContent = 'Not connected';
        }
    }

    /**
     * Handle window resize
     */
    function onWindowResize() {
        if (state.autoScroll) {
            scrollToBottom();
        }
    }

    /**
     * Export public API
     */
    window.ServerDisplay = {
        init: init,
        addLog: addLog,
        clearLogs: clearLogs,
        downloadLogs: downloadLogs,
        resetServer: resetServer,
        setStatusConnected: setStatusConnected,
        setStatusDisconnected: setStatusDisconnected,
        scrollToBottom: scrollToBottom,
        toggleAutoScroll: toggleAutoScroll
    };

    /**
     * Auto-initialize when DOM is ready
     */
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
