#!/usr/bin/env python3
import http.server
import os

class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def log_message(self, format, *args):
        print(f'127.0.0.1 - - [{self.log_date_time_string()}] {format % args}')

if __name__ == '__main__':
    port = 5000
    server = http.server.HTTPServer(('0.0.0.0', port), NoCacheHandler)
    print(f'Serving HTTP on 0.0.0.0 port {port} (http://0.0.0.0:{port}/) ...')
    server.serve_forever()
