const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

// Simple static file server for Arduino IDE
const server = http.createServer((req, res) => {
    const parsedUrl = url.parse(req.url);
    let pathname = parsedUrl.pathname;
    
    // Serve static files
    if (pathname === '/') {
        pathname = '/index.html';
    }
    
    const filePath = path.join(__dirname, pathname);
    
    fs.readFile(filePath, (err, content) => {
        if (err) {
            if (err.code === 'ENOENT') {
                // File not found
                res.writeHead(404);
                res.end('File not found');
            } else {
                // Server error
                res.writeHead(500);
                res.end('Server error');
            }
        } else {
            // Determine content type
            let contentType = 'text/html';
            if (pathname.endsWith('.js')) {
                contentType = 'application/javascript';
            } else if (pathname.endsWith('.css')) {
                contentType = 'text/css';
            } else if (pathname.endsWith('.json')) {
                contentType = 'application/json';
            }
            
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content, 'utf-8');
        }
    });
});

const PORT = 3007;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Arduino IDE web server running at http://0.0.0.0:${PORT}/`);
    console.log('Features:');
    console.log('- Monaco editor from CDN');
    console.log('- File list panel showing Arduino files');
    console.log('- Compile button that sends POST to http://172.168.1.25:3201/api/message');
    console.log('- Output panel showing compilation results');
});