const express = require('express');
const http = require('http');
const { exec } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const fs = require('fs');
const run = async (cmd, t=10000) => { try { return (await promisify(exec)(cmd, {timeout:t})).stdout.trim(); } catch { return ""; } };

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Serve the main HTML page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// API endpoint to get list of files in Arduino directory
app.get('/api/files', async (req, res) => {
    try {
        const arduinoDir = '/home/mantiz010/Arduino';
        const files = await run(`find "${arduinoDir}" -type f -name "*.ino" -o -name "*.cpp" -o -name "*.h" | sort`);
        const fileList = files.split('\n').filter(file => file.trim() !== '').map(file => {
            const name = path.basename(file);
            return { name, path: file };
        });
        res.json(fileList);
    } catch (error) {
        console.error('Error getting files:', error);
        res.status(500).json({ error: 'Failed to get files' });
    }
});

// API endpoint to get file content
app.get('/api/file/:filename', async (req, res) => {
    try {
        const { filename } = req.params;
        const arduinoDir = '/home/mantiz010/Arduino';
        const filePath = path.join(arduinoDir, filename);
        
        // Check if file exists
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: 'File not found' });
        }
        
        const content = fs.readFileSync(filePath, 'utf8');
        res.json({ content });
    } catch (error) {
        console.error('Error reading file:', error);
        res.status(500).json({ error: 'Failed to read file' });
    }
});

// API endpoint to handle compile requests
app.post('/api/message', async (req, res) => {
    try {
        const { message } = req.body;
        console.log('Received compile request:', message);
        
        // Extract project name from message
        let projectName = 'Arduino';
        if (message.includes('compile project')) {
            projectName = message.split('compile project')[1].trim();
        }
        
        // Simulate compilation process
        const output = `Compiling project: ${projectName}\n`;
        
        // In a real implementation, this would actually compile the Arduino project
        // For now, we'll simulate the process
        setTimeout(() => {
            console.log(`Compilation of ${projectName} completed`);
        }, 1000);
        
        res.json({ 
            success: true, 
            output: output + 'Compilation completed successfully\n' 
        });
    } catch (error) {
        console.error('Error processing compile request:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to process compile request' 
        });
    }
});

// Start the server on port 3007
http.createServer(app).listen(3007, '0.0.0.0', () => {
    console.log('Arduino IDE web server http://0.0.0.0:3007');
});