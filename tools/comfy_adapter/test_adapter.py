"""Contract and failure tests against an HTTP mock; never calls a GPU endpoint."""
import base64
import copy
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import socket
import tempfile
import threading
import unittest
from urllib import error, request

from server import Adapter, ApiError, ComfyClient, PREFIX, load_recipes, make_server, validate_recipe, recipe_version

PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aPXYAAAAASUVORK5CYII=")
MP4 = b"\x00\x00\x00\x18ftypisom\x00\x00\x00\x00isommp42"


def recipe(ref=False):
    value = {"id": "mock_image", "name": "Mock Image", "mode": "i2i" if ref else "t2i",
             "workflow": {"1": {"class_type": "MockText", "inputs": {"prompt": "example"}},
                          "2": {"class_type": "MockSampler", "inputs": {"seed": 0, "steps": 20}},
                          "3": {"class_type": "MockSave", "inputs": {"images": ["2", 0]}}},
             "bindings": {"prompt": {"node": "1", "field": "prompt"}, "seed": {"node": "2", "field": "seed"}, "references": []},
             "output_nodes": ["3"]}
    if ref:
        value["workflow"]["4"] = {"class_type": "LoadImage", "inputs": {"image": "placeholder.png"}}
        value["bindings"]["references"] = [{"node": "4", "field": "image"}]
    return value


class MockHandler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, value, status=200):
        raw = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        state = self.server.state
        if self.path == "/queue":
            if state.get("queue_error"):
                return self.reply({}, 503)
            state["queue_calls"] = state.get("queue_calls", 0) + 1
            if state.get("queue_second_busy") and state["queue_calls"] > 1:
                return self.reply({"queue_running": [[0, "other-work"]], "queue_pending": []})
            return self.reply(state.get("queue", {"queue_running": [], "queue_pending": []}))
        if self.path.startswith("/history/"):
            if state.get("history_error"):
                return self.reply({}, 503)
            return self.reply(state.get("history", {}))
        if self.path.startswith("/view?"):
            state["view_calls"] += 1
            payload = state.get("result", PNG)
            self.send_response(200)
            self.send_header("Content-Length", str(len(payload) + state.get("extra_length", 0)))
            self.end_headers()
            self.wfile.write(payload)
            return
        self.reply({}, 404)

    def do_POST(self):
        state = self.server.state
        raw = self.rfile.read(int(self.headers["Content-Length"]))
        if self.path == "/upload/image":
            state["uploads"].append(raw)
            state["upload_content_type"] = self.headers["Content-Type"]
            if state.get("upload_error"):
                return self.reply({}, 500)
            return self.reply(state.get("upload_response", {"name": "uploaded.png", "subfolder": "refs", "type": "input"}))
        if self.path == "/prompt":
            state["prompts"].append(json.loads(raw))
            if state.get("disconnect"):
                self.connection.shutdown(socket.SHUT_RDWR)
                self.connection.close()
                return
            if state.get("reject"):
                return self.reply({"error": {"private_path": "never returned"}}, 400)
            if state.get("missing_prompt_id"):
                return self.reply({})
            return self.reply({"prompt_id": "mock-prompt-" + str(len(state["prompts"]))})
        self.reply({}, 404)


class AdapterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.state = {"prompts": [], "uploads": [], "view_calls": 0}
        self.mock = ThreadingHTTPServer(("127.0.0.1", 0), MockHandler)
        self.mock.state = self.state
        self.mock_thread = threading.Thread(target=self.mock.serve_forever, daemon=True)
        self.mock_thread.start()
        self.client = ComfyClient("http://127.0.0.1:" + str(self.mock.server_port), timeout=1)
        self.adapter = Adapter(self.temp.name, self.client, {"mock_image": recipe()}, enabled=True)
        self.project = self.call("POST", "/projects", {"name": "Mock project", "upstream_project_id": "upstream-example"})
        self.shot = self.call("POST", "/shots", {"project_id": self.project["id"], "name": "Shot 1", "upstream_shot_id": "shot-example"})
        self.body = {"project_id": self.project["id"], "shot_id": self.shot["id"], "recipe_id": "mock_image", "prompt": "A test card",
                     "seed": 42, "request_key": "request-1"}

    def tearDown(self):
        self.adapter.close()
        self.mock.shutdown()
        self.mock.server_close()
        self.mock_thread.join()
        self.temp.cleanup()

    def call(self, method, path, body=None, query=None):
        if method == "POST" and (path == "/jobs" or path.endswith("/retry")) and body is not None:
            body = dict(body)
            rid = body.get("recipe_id", "mock_image")
            body.setdefault("recipe_version", recipe_version(self.adapter.recipes[rid]))
        return self.adapter.dispatch(method, path, query, body)

    def upload(self, **changes):
        body = {"project_id": self.project["id"], "name": "Reference", "kind": "character", "mime_type": "image/png",
                "data_base64": base64.b64encode(PNG).decode()}
        body.update(changes)
        return self.call("POST", "/assets", body)

    def complete(self, job, filename="image.png"):
        self.state["history"] = {job["prompt_id"]: {"status": {"completed": True, "status_str": "success"},
                                                        "outputs": {"3": {"images": [{"filename": filename, "subfolder": "", "type": "output"}]}}}}
        return self.call("POST", f"/jobs/{job['id']}/poll")

    def assert_reason(self, reason, fn):
        with self.assertRaises(ApiError) as raised:
            fn()
        self.assertEqual(raised.exception.reason, reason)

    def test_disabled_refuses_generation_without_any_prompt(self):
        self.adapter.enabled = False
        self.assert_reason("generation_disabled", lambda: self.call("POST", "/jobs", self.body))
        self.assertEqual(self.state["prompts"], [])
        self.assertTrue(self.call("GET", "/health")["comfy_reachable"])
        self.assertEqual(len(self.call("GET", "/projects")), 1)

    def test_private_config_does_not_leak_urls_or_workflows(self):
        value = json.dumps([self.call("GET", "/config"), self.call("GET", "/recipes")])
        self.assertNotIn("127.0.0.1", value)
        self.assertNotIn("workflow", value)
        self.assertEqual(self.call("GET", "/recipes")[0]["reference_slots"], 0)

    def test_internal_project_asset_query(self):
        self.assert_reason("route_not_found", lambda: self.call("POST", f"/projects/{self.project['id']}/script", {"script": "Scene one"}))
        asset = self.upload()
        self.assertEqual(self.call("GET", "/assets", query={"project_id": self.project["id"], "kind": "character"})[0]["id"], asset["id"])
        self.assertNotIn("relative_path", asset)
        self.assertEqual(self.call("GET", f"/assets/{asset['id']}/content")[0].read_bytes(), PNG)

    def test_canvas_project_metadata_independent_persists_after_reopen(self):
        project = self.call("POST", "/projects", {"name": "Linked project", "upstream_project_id": "native-domain-id", "canvas_project_id": "independent-canvas-id"})
        self.assertEqual(project["upstream_project_id"], "native-domain-id")
        self.assertEqual(project["canvas_project_id"], "independent-canvas-id")
        self.adapter.close()
        self.adapter = Adapter(self.temp.name, self.client, {"mock_image": recipe()}, enabled=True)
        reopened = self.call("GET", f"/projects/{project['id']}")
        self.assertEqual(reopened, project)
        self.assertEqual(self.adapter.db.execute("PRAGMA user_version").fetchone()[0], 1)

    def test_canvas_project_id_optional_and_validated(self):
        self.assertEqual(self.project["canvas_project_id"], "")
        no_link = self.call("POST", "/projects", {"name": "Unlinked", "canvas_project_id": ""})
        self.assertEqual(no_link["canvas_project_id"], "")
        self.assertIsNone(no_link["upstream_project_id"])
        for invalid in (None, 7, [], "x" * 201):
            self.assert_reason("invalid_field", lambda value=invalid: self.call("POST", "/projects", {"name": "Invalid", "canvas_project_id": value}))
        self.assertEqual(self.state["prompts"], [])

    def test_legacy_v1_read_normalization_preserves_database_records(self):
        import sqlite3
        directory = Path(self.temp.name) / "legacy-v1"
        directory.mkdir()
        legacy_project = {"id": "legacy-project", "name": "Original project", "upstream_project_id": "legacy-native-domain-id",
                          "storage_scope": "sidecar", "script": "Original script\r\nAll lines retained", "script_format": "text", "created_at": "example-time",
                          "extra_old_metadata": {"preserve": True}}
        records = {"project": legacy_project,
                   "asset": {"id": "legacy-asset", "project_id": "legacy-project", "name": "Original asset", "relative_path": "references/original.png"},
                   "shot": {"id": "legacy-shot", "project_id": "legacy-project", "name": "Original shot", "reference_asset_ids": ["legacy-asset"]},
                   "job": {"id": "legacy-job", "project_id": "legacy-project", "shot_id": "legacy-shot", "status": "completed", "prompt_id": "legacy-prompt",
                           "script_note": "Retained job metadata", "results": [], "archived_asset_ids": ["legacy-asset"]}}
        db = sqlite3.connect(directory / "adapter.sqlite3")
        db.executescript("""
            CREATE TABLE objects(kind TEXT NOT NULL,id TEXT NOT NULL,project_id TEXT,payload TEXT NOT NULL,PRIMARY KEY(kind,id));
            CREATE TABLE job_keys(request_key TEXT PRIMARY KEY,job_id TEXT NOT NULL,fingerprint TEXT NOT NULL);
            CREATE TABLE job_identity(project_id TEXT NOT NULL,shot_id TEXT NOT NULL,attempt INTEGER NOT NULL,fingerprint TEXT NOT NULL,job_id TEXT NOT NULL,UNIQUE(project_id,shot_id,attempt),UNIQUE(project_id,shot_id,attempt,fingerprint));
            PRAGMA user_version=1;
        """)
        for kind, value in records.items():
            db.execute("INSERT INTO objects(kind,id,project_id,payload) VALUES(?,?,?,?)", (kind, value["id"], value.get("project_id"), json.dumps(value)))
        db.execute("INSERT INTO job_keys(request_key,job_id,fingerprint) VALUES(?,?,?)", ("legacy-key", "legacy-job", "legacy-fingerprint"))
        db.execute("INSERT INTO job_identity(project_id,shot_id,attempt,fingerprint,job_id) VALUES(?,?,?,?,?)", ("legacy-project", "legacy-shot", 1, "legacy-fingerprint", "legacy-job"))
        db.commit()
        original_rows = db.execute("SELECT * FROM objects ORDER BY kind,id").fetchall()
        original_keys = db.execute("SELECT * FROM job_keys").fetchall()
        original_identity = db.execute("SELECT * FROM job_identity").fetchall()
        db.close()
        for _ in range(2):
            reopened = Adapter(directory, self.client, {"mock_image": recipe()}, enabled=False)
            try:
                project = reopened.dispatch("GET", "/projects/legacy-project")
                self.assertEqual(project, {**legacy_project, "canvas_project_id": ""})
                self.assertEqual(reopened.dispatch("GET", "/projects"), [project])
                for kind in ("asset", "shot", "job"):
                    self.assertEqual(reopened.get(kind, records[kind]["id"]), records[kind])
                self.assertEqual([tuple(row) for row in reopened.db.execute("SELECT * FROM objects ORDER BY kind,id")], original_rows)
                self.assertEqual([tuple(row) for row in reopened.db.execute("SELECT * FROM job_keys")], original_keys)
                self.assertEqual([tuple(row) for row in reopened.db.execute("SELECT * FROM job_identity")], original_identity)
                self.assertEqual(reopened.db.execute("PRAGMA user_version").fetchone()[0], 1)
                self.assertEqual([row[1] for row in reopened.db.execute("PRAGMA table_info(objects)")], ["kind", "id", "project_id", "payload"])
            finally:
                reopened.close()

    def test_canvas_project_http_contract_returns_both_ids(self):
        server = make_server(self.adapter, port=0)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        url = "http://127.0.0.1:" + str(server.server_port) + PREFIX
        body = json.dumps({"name": "API linked", "upstream_project_id": "native-api-project", "canvas_project_id": "canvas-api-project"}).encode()
        try:
            with request.urlopen(request.Request(url + "/projects", data=body, headers={"Content-Type": "application/json"})) as response:
                envelope = json.load(response)
            self.assertEqual(envelope["code"], 0)
            project = envelope["data"]
            self.assertEqual(project["upstream_project_id"], "native-api-project")
            self.assertEqual(project["canvas_project_id"], "canvas-api-project")
            with request.urlopen(url + "/projects/" + project["id"]) as response:
                self.assertEqual(json.load(response)["data"], project)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_reference_upload_validation_and_no_arbitrary_path(self):
        self.assert_reason("invalid_base64", lambda: self.upload(data_base64="?"))
        self.assert_reason("image_type_mismatch", lambda: self.upload(data_base64=base64.b64encode(b"not image").decode()))
        self.assert_reason("invalid_fields", lambda: self.upload(path="/private/file"))
        self.assert_reason("invalid_asset_type", lambda: self.upload(mime_type="video/mp4"))

    def test_cross_project_references_are_rejected(self):
        asset = self.upload()
        other = self.call("POST", "/projects", {"name": "Other"})
        self.assert_reason("reference_project_mismatch", lambda: self.call("POST", "/shots", {"project_id": other["id"], "name": "Other shot", "reference_asset_ids": [asset["id"]]}))

    def test_multipart_upload_and_exact_bindings_preserve_recipe(self):
        self.adapter.recipes = {"mock_image": recipe(True)}
        asset = self.upload()
        self.call("POST", f"/shots/{self.shot['id']}/references", {"asset_ids": [asset["id"]]})
        job = self.call("POST", "/jobs", self.body)
        self.assertEqual(job["status"], "submitted")
        payload = self.state["prompts"][0]["prompt"]
        self.assertEqual(payload["1"]["inputs"]["prompt"], self.body["prompt"])
        self.assertEqual(payload["2"]["inputs"], {"seed": 42, "steps": 20})
        self.assertEqual(payload["4"]["inputs"]["image"], "refs/uploaded.png")
        self.assertIn(PNG, self.state["uploads"][0])
        self.assertIn("multipart/form-data; boundary=", self.state["upload_content_type"])
        self.assertEqual(self.adapter.recipes["mock_image"]["workflow"]["2"]["inputs"]["seed"], 0)

    def test_constrained_png_first_frame_aspect_and_resolution(self):
        value = recipe(True)
        value["reference_constraints"] = [{"role": "first_frame", "width": 8, "height": 4, "mime_types": ["image/png"]}]
        self.adapter.recipes = {"mock_image": value}
        def sized_png(width, height):
            return PNG[:16] + width.to_bytes(4, "big") + height.to_bytes(4, "big") + PNG[24:]
        wrong = self.upload(data_base64=base64.b64encode(sized_png(8, 12)).decode())
        self.assert_reason("reference_aspect_mismatch", lambda: self.call("POST", "/jobs", dict(self.body, reference_asset_ids=[wrong["id"]])))
        small = self.upload(data_base64=base64.b64encode(sized_png(4, 2)).decode())
        self.assert_reason("reference_resolution_too_small", lambda: self.call("POST", "/jobs", dict(self.body, reference_asset_ids=[small["id"]])))
        jpeg = self.upload(mime_type="image/jpeg", data_base64=base64.b64encode(b"\xff\xd8\xfftest").decode())
        self.assert_reason("reference_mime_not_supported", lambda: self.call("POST", "/jobs", dict(self.body, reference_asset_ids=[jpeg["id"]])))
        good = self.upload(data_base64=base64.b64encode(sized_png(16, 8)).decode())
        self.assertEqual((good["width"], good["height"]), (16, 8))
        job = self.call("POST", "/jobs", dict(self.body, reference_asset_ids=[good["id"]]))
        self.assertEqual(job["status"], "submitted")
        self.assertEqual(len(self.state["prompts"]), 1)
        self.assertEqual(self.call("GET", "/recipes")[0]["reference_constraints"], value["reference_constraints"])

    def test_no_reference_binding_refuses_reference_not_silently_ignored(self):
        asset = self.upload()
        self.assert_reason("recipe_has_no_reference_binding", lambda: self.call("POST", "/jobs", dict(self.body, reference_asset_ids=[asset["id"]])))
        self.assertEqual(self.state["prompts"], [])

    def test_upload_failure_is_definitive_and_prompt_not_sent(self):
        self.adapter.recipes = {"mock_image": recipe(True)}
        asset = self.upload()
        self.state["upload_error"] = True
        job = self.call("POST", "/jobs", dict(self.body, reference_asset_ids=[asset["id"]]))
        self.assertEqual(job["status"], "failed")
        self.assertEqual(job["error"], "reference_upload_failed")
        self.assertEqual(self.state["prompts"], [])

    def test_upload_response_path_traversal_is_rejected(self):
        self.adapter.recipes = {"mock_image": recipe(True)}
        asset = self.upload()
        self.state["upload_response"] = {"name": "../bad.png", "type": "input"}
        job = self.call("POST", "/jobs", dict(self.body, reference_asset_ids=[asset["id"]]))
        self.assertEqual(job["status"], "failed")
        self.assertEqual(self.state["prompts"], [])

    def test_request_key_and_shot_fingerprint_persist_dedup(self):
        first = self.call("POST", "/jobs", self.body)
        again = self.call("POST", "/jobs", self.body)
        another_key = self.call("POST", "/jobs", dict(self.body, request_key="request-2"))
        self.assertEqual({first["id"], again["id"], another_key["id"]}, {first["id"]})
        self.assertTrue(again["deduplicated"])
        self.assertEqual(len(self.state["prompts"]), 1)
        self.adapter.close()
        self.adapter = Adapter(self.temp.name, self.client, {"mock_image": recipe()}, enabled=True)
        self.assertEqual(self.call("POST", "/jobs", self.body)["id"], first["id"])
        self.assertEqual(len(self.state["prompts"]), 1)

    def test_conflicting_keys_and_implicit_changed_shot_are_rejected(self):
        self.call("POST", "/jobs", self.body)
        self.assert_reason("request_key_conflict", lambda: self.call("POST", "/jobs", dict(self.body, prompt="Changed")))
        self.assert_reason("shot_attempt_conflict", lambda: self.call("POST", "/jobs", dict(self.body, request_key="new", prompt="Changed")))
        self.assertEqual(len(self.state["prompts"]), 1)

    def test_shared_upstream_busy_and_unknown_queue_block_submission(self):
        self.state["queue"] = {"queue_running": [[0, "other-work"]], "queue_pending": []}
        self.assert_reason("upstream_busy", lambda: self.call("POST", "/jobs", self.body))
        self.state["queue_error"] = True
        self.assert_reason("comfy_unavailable", lambda: self.call("POST", "/jobs", self.body))
        self.assertEqual(self.state["prompts"], [])

    def test_malformed_queue_fail_closed_for_submit_and_health(self):
        for invalid in ({}, {"queue_running": []}, {"queue_running": [], "queue_pending": None}):
            self.state["queue"] = invalid
            self.assert_reason("comfy_unavailable", lambda: self.call("POST", "/jobs", self.body))
            self.assertFalse(self.call("GET", "/health")["comfy_reachable"])
        self.assertEqual(self.state["prompts"], [])

    def test_queue_rechecked_after_reference_upload_does_not_submit(self):
        self.adapter.recipes = {"mock_image": recipe(True)}
        asset = self.upload()
        self.state["queue_second_busy"] = True
        job = self.call("POST", "/jobs", dict(self.body, reference_asset_ids=[asset["id"]]))
        self.assertEqual(job["status"], "failed")
        self.assertEqual(job["error"], "upstream_became_busy")
        self.assertEqual(len(self.state["uploads"]), 1)
        self.assertEqual(self.state["prompts"], [])

    def test_non_object_upload_response_is_definitive_failure(self):
        self.adapter.recipes = {"mock_image": recipe(True)}
        asset = self.upload()
        for index, invalid in enumerate(([], None)):
            if index:
                shot = self.call("POST", "/shots", {"project_id": self.project["id"], "name": "Other"})
            else:
                shot = self.shot
            self.state["upload_response"] = invalid
            job = self.call("POST", "/jobs", dict(self.body, shot_id=shot["id"], request_key=f"bad-upload-{index}", reference_asset_ids=[asset["id"]]))
            self.assertEqual(job["status"], "failed")
            self.assertEqual(job["error"], "reference_upload_failed")
        self.assertEqual(self.state["prompts"], [])

    def test_local_concurrency_blocks_different_shot(self):
        self.call("POST", "/jobs", self.body)
        shot = self.call("POST", "/shots", {"project_id": self.project["id"], "name": "Shot 2"})
        self.assert_reason("local_concurrency_limit", lambda: self.call("POST", "/jobs", dict(self.body, shot_id=shot["id"], request_key="second")))
        self.assertEqual(len(self.state["prompts"]), 1)

    def test_submission_disconnect_is_unknown_and_never_replayed(self):
        self.state["disconnect"] = True
        job = self.call("POST", "/jobs", self.body)
        self.assertEqual(job["status"], "submission_unknown")
        self.assertEqual(self.call("POST", "/jobs", self.body)["id"], job["id"])
        self.assert_reason("retry_not_safe", lambda: self.call("POST", f"/jobs/{job['id']}/retry", {"request_key": "retry"}))
        self.assertEqual(len(self.state["prompts"]), 1)

    def test_restart_in_submitting_state_becomes_unknown(self):
        job = self.call("POST", "/jobs", self.body)
        job["status"], job["prompt_id"] = "submitting", None
        self.adapter.put("job", job)
        self.adapter.close()
        self.adapter = Adapter(self.temp.name, self.client, {"mock_image": recipe()}, enabled=True)
        self.assertEqual(self.call("GET", f"/jobs/{job['id']}")["status"], "submission_unknown")
        self.assertEqual(self.call("POST", "/jobs", self.body)["id"], job["id"])
        self.assertEqual(len(self.state["prompts"]), 1)

    def test_definitive_rejection_retry_creates_one_new_attempt(self):
        self.state["reject"] = True
        job = self.call("POST", "/jobs", self.body)
        self.assertEqual(job["error"], "comfy_validation_rejected")
        self.state["reject"] = False
        body = {"request_key": "retry-1", "seed": 43}
        retry = self.call("POST", f"/jobs/{job['id']}/retry", body)
        twice = self.call("POST", f"/jobs/{job['id']}/retry", body)
        self.assertEqual(retry["attempt"], 2)
        self.assertEqual(retry["parent_job_id"], job["id"])
        self.assertEqual(retry["id"], twice["id"])
        self.assertEqual(len(self.state["prompts"]), 2)

    def test_poll_tracks_running_failed_and_transient_network(self):
        job = self.call("POST", "/jobs", self.body)
        self.state["queue"] = {"queue_running": [[0, job["prompt_id"]]], "queue_pending": []}
        polled = self.call("POST", f"/jobs/{job['id']}/poll")
        self.assertEqual(polled["status"], "running")
        self.state["history_error"] = True
        polled = self.call("POST", f"/jobs/{job['id']}/poll")
        self.assertEqual(polled["status"], "running")
        self.assertEqual(polled["error"], "comfy_poll_unavailable")
        self.state["history_error"] = False
        self.state["history"] = {job["prompt_id"]: {"status": {"completed": True, "status_str": "error", "messages": [["execution_error", {}]]}}}
        self.assertEqual(self.call("POST", f"/jobs/{job['id']}/poll")["status"], "failed")

    def test_malformed_nested_history_preserves_existing_job(self):
        job = self.call("POST", "/jobs", self.body)
        for entry in ("wrong", {"status": []}, {"status": {"completed": True}, "outputs": []},
                      {"status": {"completed": True}, "outputs": {"3": {"images": {"filename": "bad"}}}}):
            self.state["history"] = {job["prompt_id"]: entry}
            polled = self.call("POST", f"/jobs/{job['id']}/poll")
            self.assertEqual(polled["status"], "submitted")
            self.assertEqual(polled["error"], "comfy_poll_unavailable")
        self.assertEqual(len(self.state["prompts"]), 1)

    def test_schema_future_version_is_not_downgraded(self):
        import sqlite3
        subdir = Path(self.temp.name) / "future-schema"
        subdir.mkdir()
        db = sqlite3.connect(subdir / "adapter.sqlite3")
        db.execute("PRAGMA user_version=99")
        db.close()
        with self.assertRaises(ValueError):
            Adapter(subdir, self.client, {"mock_image": recipe()})
        db = sqlite3.connect(subdir / "adapter.sqlite3")
        try:
            self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], 99)
        finally:
            db.close()

    def test_result_archive_hash_lineage_and_repeated_archive(self):
        job = self.complete(self.call("POST", "/jobs", self.body))
        archived = self.call("POST", f"/jobs/{job['id']}/archive")
        asset = self.call("GET", "/assets/" + archived["archived_asset_ids"][0])
        self.assertEqual(asset["sha256"], hashlib.sha256(PNG).hexdigest())
        self.assertEqual(asset["shot_id"], self.shot["id"])
        self.assertEqual(asset["job_id"], job["id"])
        self.assertEqual(asset["kind"], "result")
        self.assertEqual(self.call("POST", f"/jobs/{job['id']}/archive")["archived_asset_ids"], archived["archived_asset_ids"])
        self.assertEqual(self.state["view_calls"], 1)
        self.assertFalse((Path(self.temp.name) / "output").exists())

    def test_partial_multi_result_archive_resumes_across_restart(self):
        job = self.complete(self.call("POST", "/jobs", self.body))
        job["results"].append({"node_id": "3", "filename": "second.png", "subfolder": "", "type": "output"})
        self.adapter.put("job", job)
        original = self.client.download
        count = 0
        def second_fails(descriptor, destination, maximum):
            nonlocal count
            count += 1
            if count == 2:
                raise OSError("Mock interrupted second download")
            return original(descriptor, destination, maximum)
        self.client.download = second_fails
        self.assert_reason("result_download_failed", lambda: self.call("POST", f"/jobs/{job['id']}/archive"))
        self.assertEqual(len(self.call("GET", "/assets")), 1)
        self.adapter.close()
        self.adapter = Adapter(self.temp.name, self.client, {"mock_image": recipe()}, enabled=True)
        archived = self.call("POST", f"/jobs/{job['id']}/archive")
        self.assertEqual(len(archived["archived_asset_ids"]), 2)
        self.assertEqual(count, 3)
        self.assertEqual(self.state["view_calls"], 2)

    def test_recipe_changes_do_not_change_prior_output_snapshot(self):
        job = self.call("POST", "/jobs", self.body)
        self.adapter.recipes["mock_image"]["workflow"]["2"]["inputs"]["steps"] = 99
        self.adapter.recipes["mock_image"]["output_nodes"] = ["2"]
        self.assert_reason("request_key_conflict", lambda: self.call("POST", "/jobs", self.body))
        self.assertEqual(self.complete(job)["status"], "completed")

    def test_output_prefix_binding_uses_safe_job_id(self):
        self.adapter.recipes["mock_image"]["workflow"]["3"]["inputs"]["filename_prefix"] = "example"
        self.adapter.recipes["mock_image"]["bindings"]["output_prefix"] = {"node": "3", "field": "filename_prefix"}
        job = self.call("POST", "/jobs", self.body)
        self.assertEqual(self.state["prompts"][0]["prompt"]["3"]["inputs"]["filename_prefix"], "BeefTV/" + job["id"])

    def test_completed_without_result_is_explicit_failure(self):
        job = self.call("POST", "/jobs", self.body)
        self.state["history"] = {job["prompt_id"]: {"status": {"completed": True}, "outputs": {}}}
        polled = self.call("POST", f"/jobs/{job['id']}/poll")
        self.assertEqual(polled["status"], "failed")
        self.assertEqual(polled["error"], "comfy_completed_without_results")

    def test_mp4_in_images_output_is_identified_by_actual_file_type(self):
        self.state["result"] = MP4
        job = self.complete(self.call("POST", "/jobs", self.body), "movie.mp4")
        archived = self.call("POST", f"/jobs/{job['id']}/archive")
        self.assertEqual(self.call("GET", "/assets/" + archived["archived_asset_ids"][0])["mime_type"], "video/mp4")

    def test_incomplete_download_has_no_asset_and_can_archive_again(self):
        job = self.complete(self.call("POST", "/jobs", self.body))
        self.state["extra_length"] = 10
        self.assert_reason("incomplete_result", lambda: self.call("POST", f"/jobs/{job['id']}/archive"))
        self.assertEqual(self.call("GET", "/assets"), [])
        self.assertEqual(list((Path(self.temp.name) / "staging").iterdir()), [])
        self.state["extra_length"] = 0
        self.assertEqual(len(self.call("POST", f"/jobs/{job['id']}/archive")["archived_asset_ids"]), 1)
        self.assertEqual(len(self.state["prompts"]), 1)

    def test_result_size_limit_and_traversal_are_rejected(self):
        job = self.complete(self.call("POST", "/jobs", self.body))
        self.adapter.max_result_bytes = 10
        self.assert_reason("result_too_large", lambda: self.call("POST", f"/jobs/{job['id']}/archive"))
        stored = self.call("GET", f"/jobs/{job['id']}")
        stored["results"][0]["subfolder"] = "../private"
        self.adapter.put("job", stored)
        self.assert_reason("invalid_result_path", lambda: self.call("POST", f"/jobs/{job['id']}/archive"))
        self.assertEqual(self.call("GET", "/assets"), [])

    def test_completed_remake_is_explicit_and_parent_retains_results(self):
        job = self.complete(self.call("POST", "/jobs", self.body))
        redo = self.call("POST", f"/jobs/{job['id']}/retry", {"request_key": "redo", "prompt": "Changed frame"})
        self.assertEqual(redo["attempt"], 2)
        self.assertEqual(self.call("GET", f"/jobs/{job['id']}")["results"], job["results"])
        self.assertEqual(len(self.state["prompts"]), 2)

    def test_recipe_api_validation_rejects_editor_and_unbound_private_media(self):
        bad = recipe()
        bad["workflow"] = {"nodes": []}
        with self.assertRaises(ValueError):
            validate_recipe(bad)
        bad = recipe(True)
        bad["bindings"]["references"] = []
        with self.assertRaises(ValueError):
            validate_recipe(bad)
        bad = recipe()
        bad["workflow"]["4"] = {"class_type": "LoadVideo", "inputs": {"video": "private.mp4"}}
        with self.assertRaises(ValueError):
            validate_recipe(bad)

    def test_recipe_manifest_relative_file_and_fixed_upstream(self):
        workflow_path = Path(self.temp.name) / "workflow.json"
        value = recipe()
        workflow_path.write_text(json.dumps(value.pop("workflow")))
        value["workflow_path"] = "workflow.json"
        manifest = Path(self.temp.name) / "recipes.json"
        manifest.write_text(json.dumps({"recipes": [value]}))
        self.assertEqual(load_recipes(manifest)["mock_image"]["workflow"]["2"]["inputs"]["steps"], 20)
        for url in ("http://user:secret@example.com", "file:///private", "http://example.com/?target=private", "http://example.com/path"):
            with self.assertRaises(ValueError):
                ComfyClient(url)

    def test_http_envelope_content_and_origin_contract(self):
        server = make_server(self.adapter, port=0)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        url = "http://127.0.0.1:" + str(server.server_port) + PREFIX
        try:
            with request.urlopen(url + "/projects") as response:
                envelope = json.load(response)
                self.assertEqual(envelope["code"], 0)
                self.assertEqual(envelope["reason"], None)
                self.assertIsInstance(envelope["data"], list)
                self.assertIsNone(response.headers.get("Access-Control-Allow-Origin"))
            asset = self.upload()
            with request.urlopen(url + "/assets/" + asset["id"] + "/content") as response:
                self.assertEqual(response.read(), PNG)
                self.assertEqual(response.headers["Content-Type"], "image/png")
            req = request.Request(url + "/projects", data=b'{"name":"Cross origin"}', headers={"Content-Type": "application/json", "Origin": "https://foreign.example"})
            with self.assertRaises(error.HTTPError) as raised:
                request.urlopen(req)
            self.assertEqual(raised.exception.code, 403)
            self.assertEqual(json.load(raised.exception)["reason"], "origin_not_allowed")
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_recipe_version_freezes_workflow_output_and_policy(self):
        metadata = self.call("GET", "/recipes")[0]
        frozen = dict(self.body, recipe_version=metadata["recipe_version"])
        self.adapter.recipes["mock_image"]["name"] = "Renamed label"
        self.assertEqual(self.call("GET", "/recipes")[0]["recipe_version"], frozen["recipe_version"])
        self.adapter.recipes["mock_image"]["output"] = {"width": 512, "height": 512}
        self.assert_reason("recipe_version_changed", lambda: self.call("POST", "/jobs", frozen))
        self.assert_reason("recipe_version_changed", lambda: self.adapter.dispatch("POST", "/jobs", body=self.body))
        self.assertEqual(self.state["prompts"], [])
        self.assertEqual(self.call("GET", "/jobs"), [])
        current = self.call("GET", "/recipes")[0]
        self.assertEqual(current["output"], {"width": 512, "height": 512})
        job = self.call("POST", "/jobs", dict(frozen, recipe_version=current["recipe_version"]))
        self.assertEqual(job["recipe_version"], current["recipe_version"])
        self.assertEqual(len(self.state["prompts"]), 1)

    def test_recipe_output_validation(self):
        for output in ({"width": True, "height": 512}, {"width": 9000, "height": 512},
                       {"width": 512, "height": 512, "fps": float("nan")},
                       {"width": 512, "height": 512, "duration_seconds": -1}):
            with self.subTest(output=output), self.assertRaises(ValueError):
                validate_recipe(dict(recipe(), output=output))
        with self.assertRaises(ValueError):
            validate_recipe(dict(recipe(), mode="t2v", output={"width": 512, "height": 512}))
        validate_recipe(dict(recipe(), mode="t2v", output={"width": 512, "height": 512, "fps": 24, "duration_seconds": 5}))

    def test_original_result_survives_disabled_generation_and_removed_recipe(self):
        job = self.call("POST", "/jobs", self.body)
        self.adapter.enabled = False
        self.adapter.recipes = {}
        completed = self.complete(job)
        self.assertEqual(completed["status"], "completed")
        archived = self.call("POST", f"/jobs/{job['id']}/archive")
        self.assertEqual(len(archived["archived_asset_ids"]), 1)
        self.assertEqual(self.call("POST", f"/jobs/{job['id']}/archive")["archived_asset_ids"], archived["archived_asset_ids"])
        self.assertEqual(len(self.state["prompts"]), 1)

    def test_mapping_retries_reuse_internal_objects(self):
        project = self.call("POST", "/projects", {"name": "Updated label", "upstream_project_id": "upstream-example"})
        self.assertEqual(project["id"], self.project["id"])
        shot = self.call("POST", "/shots", {"project_id": project["id"], "name": "Updated shot", "upstream_shot_id": "shot-example"})
        self.assertEqual(shot["id"], self.shot["id"])
        asset = self.upload(upstream_asset_id="native-resource")
        self.assertEqual(self.upload(upstream_asset_id="native-resource")["id"], asset["id"])
        self.assert_reason("asset_binding_conflict", lambda: self.upload(upstream_asset_id="native-resource", kind="scene"))
        self.assert_reason("shot_binding_conflict", lambda: self.call("POST", "/shots", {
            "project_id": project["id"], "name": "Shot", "upstream_shot_id": "shot-example", "reference_asset_ids": [asset["id"]]}))
        self.assertEqual(len(self.call("GET", "/projects")), 1)
        self.assertEqual(len(self.call("GET", "/shots")), 1)
        self.assertEqual(len(self.call("GET", "/assets")), 1)

    def test_adapter_service_auth_and_dns_rebinding(self):
        with self.assertRaises(ValueError):
            make_server(self.adapter, host="0.0.0.0", port=0)
        for token in ("", "test-only-service-token-0123456789abcdef"):
            server = make_server(self.adapter, port=0, auth_token=token)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            url = "http://127.0.0.1:" + str(server.server_port) + PREFIX + "/config"
            try:
                headers = {"Authorization": "Bearer " + token} if token else {}
                with request.urlopen(request.Request(url, headers=headers)) as response:
                    self.assertEqual(json.load(response)["code"], 0)
                bad = {"Host": "attacker.invalid", "Origin": "http://attacker.invalid"}
                with self.assertRaises(error.HTTPError) as raised:
                    request.urlopen(request.Request(url, headers=bad))
                self.assertEqual(raised.exception.code, 401 if token else 403)
                if token:
                    with self.assertRaises(error.HTTPError) as raised:
                        request.urlopen(request.Request(url, headers={**headers, "Origin": "http://127.0.0.1"}))
                    self.assertEqual(raised.exception.code, 403)
            finally:
                server.shutdown()
                server.server_close()
                thread.join()


if __name__ == "__main__":
    unittest.main()
