const http = require('http');
const fs = require('fs');
const path = require('path');

const server = http.createServer((req, res) => {
    // Serve static files from arduino-ide-final directory
    let filePath = './arduino-ide-final' + (req.url === '/' ? '/index.html' : req.url);
    filePath = path.join(__dirname, filePath);
    
    fs.readFile(filePath, (err, content) => {
        if (err) {
            if (err.code === 'ENOENT') {
                res.writeHead(404);
                res.end('File not found');
            } else {
                res.writeHead(500);
                res.end('Server error');
            }
        } else {
            let contentType = 'text/html';
            if (filePath.endsWith('.js')) {
                contentType = 'application/javascript';
            } else if (filePath.endsWith('.css')) {
                contentType = 'text/css';
            }
            
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content, 'utf-8');
        }
    });
});

const PORT = 3007;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Arduino IDE web server running at http://0.0.0.0:${PORT}/`);
    console.log('Features implemented:');
    console.log('1. Monaco editor from CDN');
    console.log('2. File list panel showing Arduino files');
    console.log('3. Compile button that sends POST to http://172.168.1.25:3201/api/message');
    console.log('4. Output panel showing results');
});