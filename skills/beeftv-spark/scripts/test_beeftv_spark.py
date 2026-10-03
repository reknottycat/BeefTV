"""HTTP contract tests use isolated mock state and never contact a GPU service."""

import base64
from contextlib import redirect_stdout
import io
import hashlib
import importlib.util
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
from urllib.parse import parse_qs, urlsplit
from unittest.mock import patch

import beeftv_spark as cli

IMAGE = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==")


class MockState:
    def __init__(self):
        self.requests = []
        self.projects, self.assets, self.shots, self.jobs = {}, {}, {}, {}
        self.enabled, self.ready, self.scope = True, True, True
        self.drop_submission, self.health_failure, self.redirect = False, False, False
        self.submit_5xx, self.canonical_5xx, self.content_length_extra = False, False, 0
        self.bootstrap = {"profile": "local", "workspace": {"id": "workspace-a"}, "user": {"id": "local-owner"}}


def mock_handler(state):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def send(self, data, status=200, reason=None):
            payload = json.dumps({"code": 0 if status < 400 and not reason else status, "data": data,
                                  "msg": "ok" if not reason else "rejected", "reason": reason}).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def do_GET(self):
            self.dispatch("GET")

        def do_POST(self):
            self.dispatch("POST")

        def dispatch(self, method):
            split = urlsplit(self.path)
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0)))) if method == "POST" else None
            state.requests.append((method, split.path, parse_qs(split.query), body))
            if split.path.startswith("/api/local-comfy/v1"):
                path = split.path[len(cli.PREFIX):]
                if path == "/health":
                    if state.redirect:
                        self.send_response(302)
                        self.send_header("Location", "/api/projects")
                        self.end_headers()
                        return
                    if state.health_failure:
                        self.send_response(200)
                        self.end_headers()
                        self.wfile.write(b'{"code":503,"data":null,"reason":"service_unavailable"}')
                        return
                    return self.send({"adapter": "ok", "comfy_reachable": True, "generation_enabled": state.enabled,
                                      "queue_running": 0, "queue_pending": 0})
                if path == "/config":
                    return self.send({"generation_enabled": state.enabled, "storage_scope": "sidecar",
                                      "concurrency": 1, "max_reference_bytes": 1024, "recipe_count": 1})
                if path == "/recipes":
                    return self.send([{"id": "confirmed-qwen", "name": "Confirmed image", "mode": "t2i", "ready": state.ready, "reference_slots": 0}])
                if path == "/projects":
                    if method == "GET":
                        return self.send(list(state.projects.values()))
                    project = {"id": "project-a", **body}
                    state.projects[project["id"]] = project
                    return self.send(project)
                if path.endswith("/script"):
                    return self.send({"id": path.split("/")[2], **body})
                if path == "/assets":
                    if method == "GET":
                        return self.send(list(state.assets.values()))
                    asset = {"id": "asset-a", **{k: v for k, v in body.items() if k != "data_base64"},
                             "size": len(IMAGE), "sha256": hashlib.sha256(IMAGE).hexdigest()}
                    state.assets[asset["id"]] = asset
                    return self.send(asset)
                if path.endswith("/content"):
                    self.send_response(200)
                    self.send_header("Content-Type", "image/png")
                    self.send_header("Content-Length", str(len(IMAGE) + state.content_length_extra))
                    self.end_headers()
                    self.wfile.write(IMAGE)
                    return
                if path.startswith("/assets/"):
                    return self.send(state.assets[path.split("/")[2]])
                if path == "/shots":
                    if method == "GET":
                        return self.send(list(state.shots.values()))
                    shot = {"id": "shot-a", **body}
                    state.shots[shot["id"]] = shot
                    return self.send(shot)
                if path.endswith("/references"):
                    return self.send({"id": "shot-a", "reference_asset_ids": body["asset_ids"]})
                if path == "/jobs":
                    if method == "GET":
                        return self.send(list(state.jobs.values()))
                    job = {"id": "job-a", "status": "submitted", "attempt": 1, **body}
                    state.jobs[job["id"]] = job
                    if state.submit_5xx:
                        return self.send(None, 503, "mock_server_failure")
                    if state.drop_submission:
                        self.connection.shutdown(socket.SHUT_RDWR)
                        self.connection.close()
                        return
                    return self.send(job)
                if path.startswith("/jobs/"):
                    job_id = path.split("/")[2]
                    job = state.jobs[job_id]
                    if path.endswith("/poll"):
                        job["status"] = "completed"
                    if path.endswith("/archive"):
                        job["archived_asset_ids"] = ["result-a"]
                        state.assets["result-a"] = {"id": "result-a", "kind": "result", "mime_type": "image/png",
                                                   "size": len(IMAGE), "sha256": hashlib.sha256(IMAGE).hexdigest()}
                    if path.endswith("/retry"):
                        job = {**job, "id": "job-b", "parent_job_id": job_id, "attempt": job["attempt"] + 1, "status": "submitted", **body}
                        state.jobs[job["id"]] = job
                    return self.send(job)
            if split.path == "/api/workspace/bootstrap":
                return self.send(state.bootstrap if state.scope else {"profile": "local", "workspace": {}, "user": {}})
            if split.path == "/api/projects":
                if method == "POST" and state.canonical_5xx:
                    return self.send(None, 503, "mock_server_failure")
                return self.send({"projects": []} if method == "GET" else {"project": {"id": "native-a", **body}})
            if split.path.endswith("/units/import"):
                return self.send({"units": [{"id": "unit-a", **body["units"][0]}]})
            if split.path.endswith("/units"):
                return self.send({"units": [], "canvasCounts": {}})
            if split.path.endswith("/shots/shot-n/assets"):
                return self.send({"reference": {"id": "link-n", **body}})
            if split.path.endswith("/shots"):
                return self.send({"shot": {"id": "shot-n", **body}})
            if split.path.endswith("/assets"):
                return self.send({"assets": [{"id": "native-asset", "category": "environment", "primaryVersionId": "version-n"}], "hasMore": False})
            if "/characters/" in split.path:
                return self.send({"asset": {"id": "character-n"}, "character": {"representations": []}})
            if split.path.endswith("/core"):
                return self.send({"project": {"id": "native-a"}})
            return self.send(None, 404, "not_found")

    return Handler


class ClientContractTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="beeftv-client-test-")
        self.root = Path(self.temp.name)
        self.state = MockState()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), mock_handler(self.state))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = "http://127.0.0.1:" + str(self.server.server_port)
        self.client = cli.Client(self.url, state_dir=self.root / "state")
        self.text = self.root / "prompt.txt"
        self.text.write_text("Scene: an empty workshop.", encoding="utf-8")

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.temp.cleanup()

    def run_command(self, *arguments):
        args = cli.build_parser().parse_args(list(arguments))
        return cli.execute(self.client, args)

    def submit(self, key="shot-1-attempt-1", extra=()):
        return self.run_command("job-submit", "--project", "project-a", "--shot", "shot-a",
                                "--recipe", "confirmed-qwen", "--prompt-file", str(self.text),
                                "--seed", "7", "--request-key", key, "--allow-generation", *extra)

    def expect_reason(self, reason, function):
        with self.assertRaises(cli.ClientError) as captured:
            function()
        self.assertEqual(captured.exception.reason, reason)

    def test_readonly_service_and_queries(self):
        self.assertEqual(self.run_command("health")["adapter"], "ok")
        self.assertEqual(self.run_command("config")["concurrency"], 1)
        self.assertEqual(self.run_command("recipes")[0]["id"], "confirmed-qwen")
        self.assertEqual(self.run_command("projects"), [])
        self.run_command("assets", "--project", "project-a", "--kind", "scene")
        self.assertEqual(self.state.requests[-1][2], {"project_id": ["project-a"], "kind": ["scene"]})
        self.run_command("jobs", "--project", "project-a", "--shot", "shot-a")
        self.assertEqual(self.state.requests[-1][2]["shot_id"], ["shot-a"])
        self.assertTrue(all(item[0] == "GET" for item in self.state.requests))

    def test_sidecar_project_script_shot_link_contract(self):
        project = self.run_command("project-create", "--name", "Test", "--upstream-project-id", "native-a")
        self.assertEqual(project["upstream_project_id"], "native-a")
        self.run_command("script-import", "--project", "project-a", "--file", str(self.text))
        self.assertEqual(self.state.requests[-1][3], {"script": self.text.read_text(), "format": "text"})
        self.run_command("shot-create", "--project", "project-a", "--name", "One", "--reference", "asset-a", "--upstream-shot-id", "native-shot")
        self.assertEqual(self.state.requests[-1][3]["reference_asset_ids"], ["asset-a"])
        self.run_command("shot-references", "--shot", "shot-a", "--asset", "asset-a")
        self.assertEqual(self.state.requests[-1][3], {"asset_ids": ["asset-a"]})

    def test_upload_and_download_real_bytes_no_overwrite(self):
        image = self.root / "image.png"
        image.write_bytes(IMAGE)
        asset = self.run_command("asset-upload", "--project", "project-a", "--name", "Reference", "--kind", "character", "--file", str(image))
        self.assertEqual(asset["mime_type"], "image/png")
        self.assertEqual(base64.b64decode(self.state.requests[-1][3]["data_base64"]), IMAGE)
        destination = self.root / "download.png"
        self.run_command("asset-download", "--asset", "asset-a", "--output", str(destination))
        self.assertEqual(destination.read_bytes(), IMAGE)
        self.expect_reason("destination_exists", lambda: self.run_command("asset-download", "--asset", "asset-a", "--output", str(destination)))

    def test_large_upload_rejected_before_upload(self):
        image = self.root / "large.png"
        image.write_bytes(b"x" * 1025)
        self.expect_reason("reference_too_large", lambda: self.run_command("asset-upload", "--project", "project-a", "--name", "Reference", "--kind", "reference", "--file", str(image)))
        self.assertFalse(any(item[0] == "POST" for item in self.state.requests))

    def test_download_hash_and_size_mismatch_leave_no_output(self):
        self.state.assets["asset-a"] = {"size": len(IMAGE), "sha256": "0" * 64}
        destination = self.root / "invalid.png"
        self.expect_reason("result_hash_mismatch", lambda: self.run_command("asset-download", "--asset", "asset-a", "--output", str(destination)))
        self.assertFalse(destination.exists())
        self.state.assets["asset-a"]["size"] += 1
        self.expect_reason("result_size_mismatch", lambda: self.run_command("asset-download", "--asset", "asset-a", "--output", str(destination)))
        self.assertFalse(destination.exists())

    def test_oversized_and_incomplete_download_leave_no_output(self):
        self.state.assets["asset-a"] = {"size": cli.MAX_RESULT_BYTES + 1, "sha256": "0" * 64}
        destination = self.root / "incomplete.png"
        self.expect_reason("result_too_large", lambda: self.run_command("asset-download", "--asset", "asset-a", "--output", str(destination)))
        self.assertFalse(any(item[1].endswith("/content") for item in self.state.requests))
        self.state.assets["asset-a"] = {"size": len(IMAGE), "sha256": hashlib.sha256(IMAGE).hexdigest()}
        self.state.content_length_extra = 1
        self.expect_reason("transport_error", lambda: self.run_command("asset-download", "--asset", "asset-a", "--output", str(destination)))
        self.assertFalse(destination.exists())

    def test_generation_disabled_never_posts(self):
        self.state.enabled = False
        self.expect_reason("generation_disabled", self.submit)
        self.assertFalse(any(item[0] == "POST" for item in self.state.requests))

    def test_missing_generation_permission_and_recipe(self):
        self.expect_reason("generation_not_authorized", lambda: self.client.generation_gate(False, "confirmed-qwen"))
        self.assertEqual(self.state.requests, [])
        self.state.ready = False
        self.expect_reason("recipe_unavailable", self.submit)
        self.assertFalse(any(item[0] == "POST" for item in self.state.requests))

    def test_submit_poll_archive_download_closed_loop(self):
        job = self.submit()
        self.assertEqual(job["id"], "job-a")
        self.assertEqual(self.run_command("job-poll", "--job", "job-a")["status"], "completed")
        self.assertEqual(self.run_command("job-archive", "--job", "job-a")["archived_asset_ids"], ["result-a"])
        output = self.run_command("result-download", "--job", "job-a", "--directory", str(self.root / "results"))
        self.assertEqual(Path(output["files"][0]["path"]).read_bytes(), IMAGE)
        ledger = json.loads(next((self.root / "state").glob("*.json")).read_text())
        self.assertNotIn("prompt", ledger)
        self.assertNotIn("base_url", ledger)

    def test_same_key_uses_get_and_different_payload_conflicts(self):
        self.submit()
        self.submit()
        self.assertEqual(sum(item[:2] == ("POST", cli.PREFIX + "/jobs") for item in self.state.requests), 1)
        self.text.write_text("Changed scene.", encoding="utf-8")
        self.expect_reason("request_key_conflict", self.submit)

    def test_unknown_submission_is_retained_and_never_auto_repeated(self):
        self.state.drop_submission = True
        self.expect_reason("request_outcome_unknown", self.submit)
        self.expect_reason("request_outcome_unknown", self.submit)
        self.assertEqual(sum(item[:2] == ("POST", cli.PREFIX + "/jobs") for item in self.state.requests), 1)
        ledger = json.loads(next((self.root / "state").glob("*.json")).read_text())
        self.assertEqual(ledger["state"], "request_outcome_unknown")
        self.assertEqual(self.run_command("jobs", "--shot", "shot-a")[0]["id"], "job-a")

    def test_unknown_ledger_blocks_new_key_and_allows_readonly(self):
        self.state.drop_submission = True
        self.expect_reason("request_outcome_unknown", self.submit)
        self.state.drop_submission = False
        self.expect_reason("request_outcome_unknown", lambda: self.submit(key="changed-key"))
        self.assertEqual(sum(item[:2] == ("POST", cli.PREFIX + "/jobs") for item in self.state.requests), 1)
        self.assertEqual(self.run_command("jobs", "--shot", "shot-a")[0]["id"], "job-a")
        self.assertEqual(self.run_command("config")["storage_scope"], "sidecar")

    def test_malformed_or_unreadable_ledger_stops_new_generation(self):
        self.client.state_dir.mkdir()
        broken = self.client.state_dir / "damaged.json"
        broken.write_text("{broken")
        self.expect_reason("invalid_request_ledger", self.submit)
        self.assertFalse(any(item[0] == "POST" for item in self.state.requests))
        broken.write_text(json.dumps({"state": "submitted", "request_key": "old-key", "body_sha256": "0" * 64}))
        self.expect_reason("invalid_request_ledger", self.submit)
        broken.write_text(json.dumps({"state": "pending", "request_key": "old-key", "body_sha256": "0" * 64}))
        original = Path.read_text

        def unreadable(path, *args, **kwargs):
            if path == broken:
                raise PermissionError("Simulated inaccessible ledger")
            return original(path, *args, **kwargs)

        with patch.object(Path, "read_text", unreadable):
            self.expect_reason("invalid_request_ledger", self.submit)
        original_iterdir = Path.iterdir

        def unreadable_directory(path):
            if path == self.client.state_dir:
                raise PermissionError("Simulated inaccessible ledger directory")
            return original_iterdir(path)

        with patch.object(Path, "iterdir", unreadable_directory):
            self.expect_reason("invalid_request_ledger", self.submit)
        self.assertFalse(any(item[0] == "POST" for item in self.state.requests))

    def test_known_job_same_key_get_still_works_with_unresolved_other_ledger(self):
        self.submit()
        other = self.client.state_dir / "another.json"
        other.write_text(json.dumps({"state": "pending", "request_key": "unresolved", "body_sha256": "0" * 64}))
        self.assertEqual(self.submit()["id"], "job-a")
        self.expect_reason("request_outcome_unknown", lambda: self.submit(key="new-key"))
        self.assertEqual(sum(item[:2] == ("POST", cli.PREFIX + "/jobs") for item in self.state.requests), 1)

    def test_post_5xx_unknown_is_never_repeated(self):
        self.state.submit_5xx = True
        self.expect_reason("request_outcome_unknown", self.submit)
        self.expect_reason("request_outcome_unknown", self.submit)
        self.assertEqual(sum(item[:2] == ("POST", cli.PREFIX + "/jobs") for item in self.state.requests), 1)
        self.state.canonical_5xx = True
        self.expect_reason("request_outcome_unknown", lambda: self.run_command("upstream-project-create", "--name", "Native", "--type", "short-drama", "--aspect-ratio", "16:9", "--source-type", "blank"))

    def test_accepted_job_with_local_finalize_failure_stays_unknown(self):
        original = cli.atomic_json
        writes = []

        def failing_finalize(path, value):
            writes.append(value["state"])
            if value["state"] == "submitted":
                raise OSError("Simulated local disk error")
            original(path, value)

        with patch.object(cli, "atomic_json", failing_finalize):
            self.expect_reason("request_outcome_unknown", self.submit)
        self.expect_reason("request_outcome_unknown", self.submit)
        self.assertEqual(writes, ["pending", "submitted"])
        self.assertEqual(sum(item[:2] == ("POST", cli.PREFIX + "/jobs") for item in self.state.requests), 1)
        self.assertEqual(json.loads(next((self.root / "state").glob("*.json")).read_text())["state"], "pending")

    def test_service_requests_ignore_proxy_environment(self):
        with patch.dict("os.environ", {"HTTP_PROXY": "http://127.0.0.1:1", "http_proxy": "http://127.0.0.1:1",
                                      "NO_PROXY": "", "no_proxy": ""}):
            direct = cli.Client(self.url)
            self.assertEqual(direct.call("GET", "/projects"), [])

    def test_retry_failed_and_redo_completed_need_new_key(self):
        self.submit()
        self.state.jobs["job-a"]["status"] = "failed"
        job = self.run_command("job-retry", "--job", "job-a", "--request-key", "second", "--allow-generation")
        self.assertEqual((job["attempt"], job["parent_job_id"]), (2, "job-a"))
        self.state.jobs["job-a"]["status"] = "completed"
        self.expect_reason("retry_state_conflict", lambda: self.run_command("job-retry", "--job", "job-a", "--request-key", "third", "--allow-generation"))
        self.expect_reason("retry_key_conflict", lambda: self.run_command("job-redo", "--job", "job-a", "--request-key", "shot-1-attempt-1", "--allow-generation"))
        self.assertEqual(self.run_command("job-redo", "--job", "job-a", "--request-key", "redo-key", "--allow-generation")["parent_job_id"], "job-a")

    def test_unknown_job_cannot_retry_and_watch_stops(self):
        self.submit()
        self.state.jobs["job-a"]["status"] = "submission_unknown"
        self.expect_reason("retry_state_conflict", lambda: self.run_command("job-retry", "--job", "job-a", "--request-key", "second", "--allow-generation"))
        self.assertEqual(self.run_command("job-watch", "--job", "job-a")["status"], "submission_unknown")
        self.assertFalse(any(item[1].endswith("/retry") for item in self.state.requests))

    def test_watch_timeout_preserves_pending_job(self):
        self.submit()
        self.expect_reason("wait_timeout", lambda: self.run_command("job-watch", "--job", "job-a", "--max-wait", "0"))
        self.assertEqual(self.state.jobs["job-a"]["status"], "submitted")

    def test_canonical_project_script_units_contract(self):
        self.assertEqual(self.run_command("upstream-projects"), {"projects": []})
        project = self.run_command("upstream-project-create", "--name", "Native", "--type", "short-drama", "--aspect-ratio", "16:9", "--source-type", "blank")
        self.assertEqual(project["project"]["aspectRatio"], "16:9")
        self.assertEqual(self.state.requests[-2][1], "/api/workspace/bootstrap")
        units = self.run_command("upstream-script-import", "--project", "native-a", "--file", str(self.text), "--kind", "chapter", "--title", "Opening")
        self.assertEqual(units["units"][0]["sourceText"], self.text.read_text())
        self.assertEqual(set(self.state.requests[-1][3]), {"units"})
        self.assertEqual(self.run_command("upstream-units", "--project", "native-a")["units"], [])

    def test_canonical_environment_asset_and_shot_version_link(self):
        self.run_command("upstream-assets", "--project", "native-a", "--category", "environment")
        self.assertEqual(self.state.requests[-1][2]["category"], ["environment"])
        shot = self.run_command("upstream-shot-create", "--project", "native-a", "--title", "Opening", "--description-file", str(self.text), "--duration-ms", "1000", "--position", "0")
        self.assertEqual(shot["shot"]["revision"]["plotDescription"], self.text.read_text())
        link = self.run_command("upstream-shot-link", "--project", "native-a", "--shot", "shot-n", "--asset-version", "version-n", "--role", "reference")
        self.assertEqual(link["reference"]["assetVersionId"], "version-n")
        self.assertEqual(self.run_command("upstream-character-get", "--project", "native-a", "--asset", "character-n")["asset"]["id"], "character-n")

    def test_canonical_missing_scope_never_writes(self):
        self.state.scope = False
        self.expect_reason("unsupported_workspace_scope", lambda: self.run_command("upstream-project-create", "--name", "Native", "--type", "short-drama", "--aspect-ratio", "16:9", "--source-type", "blank"))
        self.assertEqual([item[:2] for item in self.state.requests], [("GET", "/api/workspace/bootstrap")])

    def test_nonzero_business_envelope_and_redirect_fail(self):
        self.state.health_failure = True
        self.expect_reason("service_unavailable", lambda: self.run_command("health"))
        self.state.health_failure, self.state.redirect = False, True
        self.expect_reason("http_error", lambda: self.run_command("health"))
        self.assertFalse(any(item[1] == "/api/projects" for item in self.state.requests))

    def test_config_relative_state_and_json_failure_output(self):
        config = self.root / "private.json"
        config.write_text(json.dumps({"base_url": self.url, "state_dir": "private-ledger"}))
        args = cli.build_parser().parse_args(["--config", str(config), "projects"])
        with patch.dict("os.environ", {}, clear=True):
            client = cli.make_client(args)
            self.assertEqual(client.state_dir, self.root / "private-ledger")
            output = io.StringIO()
            with redirect_stdout(output):
                exit_code = cli.main(["projects"])
        self.assertEqual(exit_code, 1)
        self.assertEqual(json.loads(output.getvalue())["reason"], "missing_base_url")

    def test_ascii_strict_subprocess_download_to_unicode_path(self):
        self.state.assets["asset-a"] = {"id": "asset-a", "name": "参考图", "mime_type": "image/png",
                                      "size": len(IMAGE), "sha256": hashlib.sha256(IMAGE).hexdigest()}
        destination = self.root / "中文素材" / "参考图.png"
        environment = {**os.environ, "PYTHONIOENCODING": "ascii:strict", "PYTHONUTF8": "0"}
        result = subprocess.run([sys.executable, str(Path(cli.__file__).resolve()), "--base-url", self.url,
                                 "asset-download", "--asset", "asset-a", "--output", str(destination)],
                                env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr.decode("ascii", errors="replace"))
        output = json.loads(result.stdout.decode("ascii"))
        self.assertTrue(output["ok"])
        self.assertEqual(output["data"]["path"], str(destination))
        self.assertEqual(destination.read_bytes(), IMAGE)

    def test_credential_url_rejected_before_network(self):
        for url in ("http://person:secret@example.invalid", self.url + "?token=hidden", self.url + "/unsupported"):
            self.expect_reason("invalid_config", lambda: cli.Client(url))
        self.assertEqual(self.state.requests, [])


class ActualAdapterContractTests(unittest.TestCase):
    def test_actual_adapter_registration_query_and_generation_disabled(self):
        source = Path(__file__).resolve().parents[3] / "tools" / "comfy_adapter" / "server.py"
        if not source.is_file():
            self.skipTest("Actual adapter source is only available in the BeefTV repository.")
        spec = importlib.util.spec_from_file_location("beeftv_actual_adapter", source)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)

        class ReadOnlyComfy:
            def json(self, path):
                if path != "/queue":
                    raise AssertionError("Contract test only permits the read-only queue endpoint.")
                return {"queue_running": [], "queue_pending": []}

        with tempfile.TemporaryDirectory(prefix="beeftv-actual-api-") as folder:
            adapter = module.Adapter(Path(folder) / "server-state", client=ReadOnlyComfy(), enabled=False)
            server = module.make_server(adapter, port=0)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                client = cli.Client("http://127.0.0.1:" + str(server.server_port), state_dir=Path(folder) / "client-state")
                self.assertFalse(client.call("GET", "/config")["generation_enabled"])
                self.assertEqual(client.call("GET", "/health")["adapter"], "ok")
                self.assertEqual(client.call("GET", "/projects"), [])
                self.assertEqual(client.call("GET", "/assets"), [])
                project = client.call("POST", "/projects", {"name": "Isolated contract project", "upstream_project_id": "native-contract"})
                client.call("POST", "/projects/" + project["id"] + "/script", {"script": "A short test.", "format": "text"})
                asset = client.call("POST", "/assets", {"project_id": project["id"], "name": "One pixel",
                                    "kind": "scene", "mime_type": "image/png", "data_base64": base64.b64encode(IMAGE).decode()})
                self.assertEqual(cli.download_asset(client, asset["id"]), IMAGE)
                shot = client.call("POST", "/shots", {"project_id": project["id"], "name": "Test shot", "reference_asset_ids": [asset["id"]]})
                self.assertEqual(shot["reference_asset_ids"], [asset["id"]])
                self.assertEqual(client.call("GET", "/assets", query={"project_id": project["id"], "kind": "scene"})[0]["sha256"], hashlib.sha256(IMAGE).hexdigest())
                with self.assertRaises(cli.ClientError) as caught:
                    client.generation_gate(True, "absent-recipe")
                self.assertEqual(caught.exception.reason, "generation_disabled")
                self.assertEqual(client.call("GET", "/jobs"), [])
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)
                adapter.close()


if __name__ == "__main__":
    unittest.main()
