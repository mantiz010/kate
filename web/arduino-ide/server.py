#!/usr/bin/env python3
import http.server
import socketserver
import os
import sys

PORT = 3007
DIRECTORY = "/home/mantiz010/kate/web/arduino-ide"

class MyHttpRequestHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

Handler = MyHttpRequestHandler
with socketserver.TCPServer(("", PORT), Handler) as httpd:
    print(f"Server running at http://localhost:{PORT}/")
    print(f"Serving directory: {DIRECTORY}")
    httpd.serve_forever()