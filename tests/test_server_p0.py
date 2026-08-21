#!/usr/bin/env python3
"""Focused P0 security/state tests for server.py (stdlib only, no deps).

Covers:
- GET /server.py -> 404 (no file disclosure, no SimpleHTTPRequestHandler fallback)
- GET / -> 200 (app shell still served)
- unknown GET -> 404 JSON
- malformed/non-numeric Content-Length -> safe 400, no traceback
- server 500 responses never disclose raw exception text
"""
import http.client
import importlib.util
import json
import os
import pathlib
import socket
import threading
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
SERVER_PATH = ROOT / "server.py"


def load_server():
    spec = importlib.util.spec_from_file_location("structa_server_p0", SERVER_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ServerP0Test(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._old_cwd = os.getcwd()
        os.chdir(ROOT)
        cls.server_mod = load_server()
        cls.httpd = cls.server_mod.http.server.ThreadingHTTPServer(
            ("127.0.0.1", 0), cls.server_mod.StructaHandler
        )
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        os.chdir(cls._old_cwd)

    def get(self, path):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        conn.request("GET", path)
        resp = conn.getresponse()
        body = resp.read()
        conn.close()
        return resp.status, body

    def post(self, path, payload):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        conn.request("POST", path, body=json.dumps(payload),
                     headers={"Content-Type": "application/json"})
        resp = conn.getresponse()
        body = resp.read()
        conn.close()
        return resp.status, body

    def raw_post(self, path, raw_headers):
        sock = socket.create_connection(("127.0.0.1", self.port), timeout=5)
        sock.sendall(("POST " + path + " HTTP/1.1\r\nHost: 127.0.0.1\r\n"
                      + raw_headers + "\r\n").encode("utf-8"))
        data = b""
        while True:
            chunk = sock.recv(65536)
            if not chunk:
                break
            data += chunk
        sock.close()
        return data

    # --- R1: no file disclosure fallback ---

    def test_get_server_py_is_404(self):
        status, body = self.get("/server.py")
        self.assertEqual(status, 404)
        self.assertNotIn(b"import http.server", body)
        self.assertNotIn(b"Traceback", body)
        parsed = json.loads(body)
        self.assertFalse(parsed.get("ok"))

    def test_get_root_serves_app(self):
        status, body = self.get("/")
        self.assertEqual(status, 200)
        self.assertIn(b"<!DOCTYPE", body[:64].upper())

    def test_get_index_html_serves_app(self):
        status, body = self.get("/index.html")
        self.assertEqual(status, 200)
        self.assertIn(b"html", body[:128].lower())

    def test_get_unknown_path_is_404(self):
        status, body = self.get("/some/unknown/path.txt")
        self.assertEqual(status, 404)
        parsed = json.loads(body)
        self.assertFalse(parsed.get("ok"))

    def test_get_dotenv_is_404(self):
        status, _ = self.get("/.env")
        self.assertEqual(status, 404)

    def test_get_healthz_is_200(self):
        status, body = self.get("/healthz")
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(body).get("ok"))

    # --- malformed Content-Length ---

    def test_non_numeric_content_length_is_400(self):
        resp = self.raw_post("/v1/diagnostic/echo",
                             "Content-Length: not-a-number\r\n")
        self.assertIn(b" 400 ", resp.split(b"\r\n")[0])
        self.assertNotIn(b"Traceback", resp)

    def test_negative_content_length_is_400(self):
        resp = self.raw_post("/v1/diagnostic/echo",
                             "Content-Length: -5\r\n")
        self.assertIn(b" 400 ", resp.split(b"\r\n")[0])
        self.assertNotIn(b"Traceback", resp)

    def test_invalid_json_body_is_400(self):
        sock = socket.create_connection(("127.0.0.1", self.port), timeout=5)
        body = b"{not json"
        sock.sendall(("POST /v1/diagnostic/echo HTTP/1.1\r\n"
                      "Host: 127.0.0.1\r\n"
                      "Content-Type: application/json\r\n"
                      "Content-Length: %d\r\n\r\n" % len(body)).encode("utf-8") + body)
        data = b""
        while True:
            chunk = sock.recv(65536)
            if not chunk:
                break
            data += chunk
        sock.close()
        self.assertIn(b" 400 ", data.split(b"\r\n")[0])

    # --- unknown POST endpoint ---

    def test_unknown_post_endpoint_is_404(self):
        status, body = self.post("/v1/nope", {"a": 1})
        self.assertEqual(status, 404)
        self.assertFalse(json.loads(body).get("ok"))

    # --- 500 responses never disclose exception text ---

    def test_500_hides_exception_text(self):
        raw_response = json.dumps({
            "focus": {"phase_next": "observe"},
            "produced": {
                "claims": [{"text": "boom", "evidence": ["claim-1"], "confidence": "not-a-number"}]
            }
        })
        status, body = self.post("/v1/chain/step", {
            "focus": {"kind": "branch", "id": "main", "phase": "observe"},
            "rawResponse": raw_response,
        })
        self.assertEqual(status, 500)
        text = body.decode("utf-8", "replace")
        self.assertNotIn("not-a-number", text)
        self.assertNotIn("ValueError", text)
        self.assertNotIn("float", text)
        self.assertNotIn("Traceback", text)
        parsed = json.loads(body)
        self.assertFalse(parsed.get("ok"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
