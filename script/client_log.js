// Client-side logging module
// Stores logs for each player and sends them to server

class ClientLogger {
    constructor(maxLogs = 500) {
        this.logs = [];
        this.maxLogs = maxLogs;
        this.playerName = this.generatePlayerName();
    }

    generatePlayerName() {
        // Generate or retrieve player name
        let name = localStorage.getItem('clientPlayerName');
        if (!name) {
            name = 'Player' + Math.random().toString(36).substring(2, 8);
            localStorage.setItem('clientPlayerName', name);
        }
        return name;
    }

    addLog(message, type = 'log', direction = 'internal') {
        const logEntry = {
            message: typeof message === 'string' ? message : JSON.stringify(message),
            type: type,
            direction: direction, // 'sent', 'received', 'internal', 'error'
            timestamp: new Date().toISOString(),
            playerName: this.playerName
        };

        this.logs.push(logEntry);

        // Keep only recent logs
        if (this.logs.length > this.maxLogs) {
            this.logs.shift();
        }

        // Send to server if available
        this.sendLogsToServer();
    }

    logSent(message, target = 'server') {
        this.addLog(`[SENT to ${target}] ${typeof message === 'string' ? message : JSON.stringify(message)}`, 'log', 'sent');
    }

    logReceived(message, from = 'server') {
        this.addLog(`[RECEIVED from ${from}] ${typeof message === 'string' ? message : JSON.stringify(message)}`, 'log', 'received');
    }

    logEvent(message) {
        this.addLog(`[EVENT] ${message}`, 'info', 'internal');
    }

    logError(message) {
        this.addLog(`[ERROR] ${message}`, 'error', 'internal');
    }

    logCodeExecution(code, result = null, error = null) {
        // Log the executed code
        this.addLog(`[EXEC] ${code}`, 'log', 'sent');
        
        // Log the result or error
        if (error) {
            this.addLog(`[RESULT] Error: ${error}`, 'error', 'received');
        } else if (result !== undefined && result !== null) {
            this.addLog(`[RESULT] ${typeof result === 'string' ? result : JSON.stringify(result)}`, 'log', 'received');
        } else if (result === undefined) {
            this.addLog(`[RESULT] undefined`, 'log', 'received');
        }
    }

    async sendLogsToServer() {
        // Send logs to server for persistent storage
        try {
            const response = await fetch('/api/client-logs', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    playerName: this.playerName,
                    logs: this.logs
                })
            });
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            
            return await response.json();
        } catch (error) {
            // Silently fail if server not available
            return null;
        }
    }

    getLogs() {
        return this.logs;
    }

    clearLogs() {
        this.logs = [];
    }

    getPlayerName() {
        return this.playerName;
    }

    setPlayerName(name) {
        this.playerName = name;
        localStorage.setItem('clientPlayerName', name);
    }
}

// Create global instance
window.clientLogger = new ClientLogger();

// Intercept console methods to capture all console output
(function() {
    const logger = window.clientLogger;
    
    // Store original console methods
    const originalLog = console.log;
    const originalInfo = console.info;
    const originalWarn = console.warn;
    const originalError = console.error;
    const originalDebug = console.debug;
    
    // Override console.log
    console.log = function(...args) {
        originalLog.apply(console, args);
        const message = args.map(arg => 
            typeof arg === 'string' ? arg : JSON.stringify(arg)
        ).join(' ');
        logger.addLog(message, 'log', 'internal');
    };
    
    // Override console.info
    console.info = function(...args) {
        originalInfo.apply(console, args);
        const message = args.map(arg => 
            typeof arg === 'string' ? arg : JSON.stringify(arg)
        ).join(' ');
        logger.addLog(message, 'info', 'internal');
    };
    
    // Override console.warn
    console.warn = function(...args) {
        originalWarn.apply(console, args);
        const message = args.map(arg => 
            typeof arg === 'string' ? arg : JSON.stringify(arg)
        ).join(' ');
        logger.addLog(message, 'warn', 'internal');
    };
    
    // Override console.error
    console.error = function(...args) {
        originalError.apply(console, args);
        const message = args.map(arg => 
            typeof arg === 'string' ? arg : JSON.stringify(arg)
        ).join(' ');
        logger.addLog(message, 'error', 'internal');
    };
    
    // Override console.debug
    console.debug = function(...args) {
        originalDebug.apply(console, args);
        const message = args.map(arg => 
            typeof arg === 'string' ? arg : JSON.stringify(arg)
        ).join(' ');
        logger.addLog(message, 'debug', 'internal');
    };
    
    // Capture uncaught errors
    window.addEventListener('error', (event) => {
        const message = `Uncaught ${event.error?.name || 'Error'}: ${event.message}`;
        logger.addLog(message, 'error', 'internal');
    });
    
    // Capture unhandled promise rejections
    window.addEventListener('unhandledrejection', (event) => {
        const message = `Unhandled Promise Rejection: ${event.reason}`;
        logger.addLog(message, 'error', 'internal');
    });
})();

// Log page load
window.clientLogger.logEvent('Client logger initialized');

// Export for Node.js if needed
if (typeof module !== 'undefined' && module.exports) {
    module.exports = ClientLogger;
}
