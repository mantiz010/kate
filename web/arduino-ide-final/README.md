# Web Arduino IDE

A web-based Arduino IDE interface with Monaco editor, file explorer, and compilation functionality.

## Features

- **Monaco Editor**: Code editing with syntax highlighting
- **File Explorer**: Shows Arduino project files from ~/Arduino/
- **Compile Button**: Sends POST request to http://172.168.1.25:3201/api/message
- **Output Panel**: Displays compilation results and POST request status

## Usage

1. Open `http://localhost:3007` in your browser
2. Select a file from the sidebar to edit
3. Click "Compile" to simulate compilation
4. View output in the bottom panel

## Technical Details

- Uses Monaco Editor from CDN for code editing
- File list panel shows Arduino project files
- Compile button sends POST request with message format: "compile project Arduino"
- Output panel shows compilation results and POST request status
- Single HTML file implementation for easy deployment

## Requirements

- Modern web browser
- Internet connection (for CDN resources)
- Server running on port 3007