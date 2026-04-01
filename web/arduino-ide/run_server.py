#!/usr/bin/env python3
import http.server
import socketserver
import os

PORT = 3007
DIRECTORY = "/home/mantiz010/kate/web/arduino-ide"

# Change to the directory containing the files
os.chdir(DIRECTORY)

Handler = http.server.SimpleHTTPRequestHandler
with socketserver.TCPServer(("", PORT), Handler) as httpd:
    print(f"Server running at http://localhost:{PORT}/")
    print(f"Serving directory: {DIRECTORY}")
    httpd.serve_forever()