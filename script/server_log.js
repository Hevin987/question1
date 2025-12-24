// Server logging module
// Appends logs to both HTML display and a single log file

import fs from 'fs';
import path from 'path';

class ServerLogger {
    constructor(logDir = 'logs') {
        this.logsHtml = [];
        this.logs = []; // JSON format logs for API
        this.logDir = logDir;
        this.logFile = path.join(logDir, 'server.log');
        
        // Create logs directory if it doesn't exist
        try {
            if (!fs.existsSync(this.logDir)) {
                fs.mkdirSync(this.logDir, { recursive: true });
            }
        } catch (err) {
            console.error('Failed to create logs directory:', err.message);
        }
        
        // Load existing logs from file
        this.loadLogsFromFile();
    }

    loadLogsFromFile() {
        try {
            if (fs.existsSync(this.logFile)) {
                const content = fs.readFileSync(this.logFile, 'utf-8');
                const lines = content.split('\n').filter(line => line.trim());
                
                lines.forEach(line => {
                    // Parse log line: [timestamp] [TYPE] message
                    const match = line.match(/\[(.*?)\]\s*\[(.*?)\]\s*(.*)/);
                    if (match) {
                        const [, timestamp, type, message] = match;
                        const timeStr = new Date(timestamp).toLocaleTimeString();
                        
                        // Create HTML log entry with proper structure
                        const htmlEntry = `<div class="console-line ${type.toLowerCase()}"><span class="timestamp">[${timeStr}]</span><span class="log-type">${type}</span><span class="message">${this.escapeHtml(message)}</span></div>`;
                        this.logsHtml.push(htmlEntry);
                        
                        // Create JSON log entry
                        this.logs.push({
                            message: message,
                            level: type.toLowerCase(),
                            timestamp: timestamp
                        });
                    } else {
                        // Fallback for lines that don't match the pattern
                        const htmlEntry = `<div class="console-line log"><span class="timestamp">${this.escapeHtml(line)}</span></div>`;
                        this.logsHtml.push(htmlEntry);
                        
                        this.logs.push({
                            message: line,
                            level: 'log',
                            timestamp: new Date().toISOString()
                        });
                    }
                });
                
                console.log(`Loaded ${lines.length} existing logs from server.log`);
            }
        } catch (err) {
            console.error('Error loading log file:', err.message);
        }
    }

    addLog(message, type = 'log') {
        const logMessage = typeof message === 'string' ? message : JSON.stringify(message);
        const timeStrFull = new Date().toISOString();
        const timeStr = new Date().toLocaleTimeString();
        
        // Log to console
        console.log(logMessage);

        // Create HTML log entry
        const htmlEntry = `<div class="console-line ${type}"><span class="timestamp">[${timeStr}]</span><span class="log-type">${type.toUpperCase()}</span><span class="message">${this.escapeHtml(logMessage)}</span></div>`;
        this.logsHtml.push(htmlEntry);
        
        // Add to JSON logs array
        this.logs.push({
            message: logMessage,
            level: type.toLowerCase(),
            timestamp: timeStrFull
        });

        // Append to log file
        const fileEntry = `[${timeStrFull}] [${type.toUpperCase()}] ${logMessage}`;
        try {
            // Ensure directory exists before writing
            if (!fs.existsSync(this.logDir)) {
                fs.mkdirSync(this.logDir, { recursive: true });
            }
            fs.appendFileSync(this.logFile, fileEntry + '\n', 'utf-8');
        } catch (err) {
            console.error(`Error writing to log file (${this.logFile}):`, err.message);
        }
    }

    escapeHtml(text) {
        const map = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;'
        };
        return String(text).replace(/[&<>"']/g, m => map[m]);
    }

    getLogsHtml() {
        return this.logsHtml.join('');
    }

    clearLogs() {
        this.logsHtml = [];
    }
}

// Export as ES6 default export
export default ServerLogger;
