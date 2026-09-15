"""A transient control-server failure must not permanently lose readiness."""
import importlib.util
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

mode = sys.argv[2] if len(sys.argv) > 2 else "ready"
attempts = []
ready = threading.Event()

class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('content-length', '0')))
        attempts.append({'path': self.path, 'body': json.loads(body)})
        status = 503 if mode != "ready" or len(attempts) == 1 else 200
        self.send_response(status)
        self.end_headers()
        if status == 200:
            ready.set()

    def log_message(self, *args):
        pass

server = HTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
os.environ['SERVE_SIM_CAPTURE_CONTROL_URL'] = f'http://127.0.0.1:{server.server_port}'
os.environ['SERVE_SIM_CAPTURE_CONTROL_TOKEN'] = 'ready-probe'
spec = importlib.util.spec_from_file_location('servesim_capture', sys.argv[1])
addon = importlib.util.module_from_spec(spec)
spec.loader.exec_module(addon)
if mode == "flow":
    addon._post("/request", {"id": "one"})
else:
    addon.running()
recovered = ready.wait(0.75 if mode == "flow" else 3)
addon.done()
server.shutdown()
print(json.dumps({'recovered': recovered, 'attempts': attempts}))
