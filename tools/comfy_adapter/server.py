#!/usr/bin/env python3
"""Explicitly enabled ComfyUI adapter. No cloud providers or GPU workers."""
from __future__ import annotations

import argparse
import base64
import binascii
import copy
import hashlib
import http.client
import json
import mimetypes
import os
from pathlib import Path
import re
import sqlite3
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib import error, parse, request
import uuid

PREFIX = "/api/local-comfy/v1"
MAX_REFERENCE_BYTES = 10 * 1024 * 1024
MAX_BODY_BYTES = 15 * 1024 * 1024
MAX_RESULT_BYTES = 256 * 1024 * 1024
ACTIVE = {"submitting", "submitted", "running", "submission_unknown"}
IMAGE_MIMES = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"}
RESULT_MIMES = {**IMAGE_MIMES, "image/gif": ".gif", "video/mp4": ".mp4", "video/webm": ".webm"}


class ApiError(Exception):
    def __init__(self, status, reason, msg=None, data=None):
        self.status, self.reason = status, reason
        self.msg, self.data = msg or reason.replace("_", " "), data
        super().__init__(self.msg)


class ComfyRejected(Exception):
    """A definitive validation rejection; an unavailable response is ambiguous."""


def now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def uid():
    return uuid.uuid4().hex


def text_field(value, name, maximum=1000, allow_empty=False):
    if not isinstance(value, str) or len(value) > maximum or (not allow_empty and not value.strip()):
        raise ApiError(400, "invalid_field", f"Invalid {name}")
    return value


def fields(body, allowed):
    if not isinstance(body, dict) or set(body) - set(allowed):
        raise ApiError(400, "invalid_fields", "Unsupported request fields")


def image_matches(data, mime):
    if mime == "image/png":
        return data.startswith(b"\x89PNG\r\n\x1a\n")
    if mime == "image/jpeg":
        return data.startswith(b"\xff\xd8\xff")
    if mime == "image/webp":
        return data[:4] == b"RIFF" and data[8:12] == b"WEBP"
    if mime == "image/gif":
        return data[:6] in (b"GIF87a", b"GIF89a")
    if mime == "video/mp4":
        return data[4:8] == b"ftyp"
    if mime == "video/webm":
        return data[:4] == b"\x1aE\xdf\xa3"
    return False


def png_dimensions(data):
    if len(data) < 24 or data[:8] != b"\x89PNG\r\n\x1a\n" or data[12:16] != b"IHDR":
        raise ApiError(400, "invalid_png_dimensions")
    width, height = int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")
    if not (0 < width <= 32768 and 0 < height <= 32768) or width * height > 268435456:
        raise ApiError(400, "invalid_png_dimensions")
    return width, height


def safe_descriptor(value):
    if not isinstance(value, dict):
        raise ApiError(502, "invalid_result", "Invalid Comfy result descriptor")
    filename, subfolder, kind = value.get("filename"), value.get("subfolder", ""), value.get("type", "output")
    if (not isinstance(filename, str) or not filename or len(filename) > 255
            or any(c in filename for c in "/\\:\x00") or filename in (".", "..")):
        raise ApiError(502, "invalid_result_path")
    if (not isinstance(subfolder, str) or len(subfolder) > 1000 or "\\" in subfolder or ":" in subfolder
            or "\x00" in subfolder or subfolder.startswith("/")
            or any(part in (".", "..") for part in subfolder.split("/"))):
        raise ApiError(502, "invalid_result_path")
    if kind not in ("output", "temp"):
        raise ApiError(502, "invalid_result_type")
    return {"filename": filename, "subfolder": subfolder, "type": kind}


def validate_queue(value):
    if not isinstance(value, dict) or any(not isinstance(value.get(k), list) for k in ("queue_running", "queue_pending")):
        raise ValueError("Comfy queue state must include running and pending arrays")
    return value


class NoRedirect(request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class ComfyClient:
    def __init__(self, url="", timeout=15):
        parsed = parse.urlsplit(url)
        if url and (parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username
                    or parsed.password or parsed.query or parsed.fragment or parsed.path not in ("", "/")):
            raise ValueError("BEEFTV_COMFY_URL must be a fixed HTTP(S) origin without credentials")
        self.url, self.timeout = url.rstrip("/"), timeout
        self.opener = request.build_opener(request.ProxyHandler({}), NoRedirect())

    def _open(self, path, data=None, headers=None):
        if not self.url:
            raise ApiError(503, "comfy_not_configured")
        return self.opener.open(request.Request(self.url + path, data=data, headers=headers or {}), timeout=self.timeout)

    def json(self, path, payload=None):
        data = None if payload is None else json.dumps(payload).encode()
        try:
            with self._open(path, data, {"Content-Type": "application/json"}) as response:
                raw = response.read(4 * 1024 * 1024 + 1)
                if len(raw) > 4 * 1024 * 1024:
                    raise ValueError("Comfy response too large")
                value = json.loads(raw)
                if not isinstance(value, dict):
                    raise ValueError("Comfy object required")
                return value
        except error.HTTPError as exc:
            if path == "/prompt" and exc.code in (400, 422):
                raise ComfyRejected("comfy_validation_rejected") from None
            raise

    def upload(self, data, filename, mime):
        boundary = "beeftv" + uid()
        head = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"{filename}\"\r\n"
                f"Content-Type: {mime}\r\n\r\n").encode()
        tail = (f"\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"type\"\r\n\r\ninput\r\n"
                f"--{boundary}\r\nContent-Disposition: form-data; name=\"overwrite\"\r\n\r\nfalse\r\n--{boundary}--\r\n").encode()
        with self._open("/upload/image", head + data + tail, {"Content-Type": f"multipart/form-data; boundary={boundary}"}) as response:
            raw = response.read(65537)
        if len(raw) > 65536:
            raise ValueError("Invalid upload response")
        value = json.loads(raw)
        if not isinstance(value, dict):
            raise ValueError("Upload response must be an object")
        descriptor = safe_descriptor({"filename": value.get("name"), "subfolder": value.get("subfolder", ""), "type": "output"})
        if value.get("type", "input") != "input":
            raise ValueError("Upload was not stored as input")
        return "/".join(filter(None, [descriptor["subfolder"], descriptor["filename"]]))

    def download(self, descriptor, destination, maximum):
        query = parse.urlencode(safe_descriptor(descriptor))
        digest, count, prefix = hashlib.sha256(), 0, b""
        with self._open("/view?" + query) as response, destination.open("xb") as output:
            declared = response.headers.get("Content-Length")
            if declared and (not declared.isdigit() or int(declared) > maximum):
                raise ApiError(502, "result_too_large")
            while chunk := response.read(64 * 1024):
                count += len(chunk)
                if count > maximum:
                    raise ApiError(502, "result_too_large")
                if len(prefix) < 32:
                    prefix = (prefix + chunk)[:32]
                digest.update(chunk)
                output.write(chunk)
            output.flush()
            os.fsync(output.fileno())
            if declared and count != int(declared):
                raise ApiError(502, "incomplete_result")
            if not count:
                raise ApiError(502, "empty_result")
        return count, digest.hexdigest(), prefix


def load_recipes(path):
    if not path:
        return {}
    manifest_path = Path(path).resolve()
    manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
    recipes = {}
    for entry in manifest.get("recipes", []):
        rid = text_field(entry.get("id"), "recipe id", 100)
        if rid in recipes or not re.fullmatch(r"[A-Za-z0-9_-]+", rid):
            raise ValueError("Recipe IDs must be unique identifiers")
        item = copy.deepcopy(entry)
        workflow_path = Path(item["workflow_path"])
        if not workflow_path.is_absolute():
            workflow_path = manifest_path.parent / workflow_path
        item["workflow"] = json.loads(workflow_path.read_text(encoding="utf-8-sig"))
        validate_recipe(item)
        recipes[rid] = item
    return recipes


def validate_recipe(item):
    workflow, bindings = item["workflow"], item["bindings"]
    if not isinstance(workflow, dict) or not workflow or "nodes" in workflow:
        raise ValueError("Recipe must contain a Comfy API prompt, not an editor graph")
    for node in workflow.values():
        if not isinstance(node, dict) or not isinstance(node.get("class_type"), str) or not isinstance(node.get("inputs"), dict):
            raise ValueError("Invalid API workflow node")
    refs = bindings.get("references", [])
    if not isinstance(refs, list) or len(refs) > 8:
        raise ValueError("Reference bindings must be a bounded ordered list")
    other = [bindings["output_prefix"]] if bindings.get("output_prefix") else []
    for binding in [bindings["prompt"], bindings["seed"], *refs, *other]:
        if not isinstance(binding, dict) or binding.get("field") not in workflow.get(str(binding.get("node")), {}).get("inputs", {}):
            raise ValueError("Binding must identify an existing node input")
    bound_media = {(str(b["node"]), b["field"]) for b in refs}
    for node_id, node in workflow.items():
        if "load" in node["class_type"].lower():
            for field in ("image", "video", "audio", "filename"):
                value = node["inputs"].get(field)
                if isinstance(value, str) and (str(node_id), field) not in bound_media:
                    raise ValueError("Media loaders require explicit reference bindings; fixed private media are not allowed")
    if any(binding["field"] != "image" for binding in refs):
        raise ValueError("This adapter supports image references only; video/audio references require a separate reviewed implementation")
    constraints = item.get("reference_constraints", [])
    if not isinstance(constraints, list) or (constraints and len(constraints) != len(refs)):
        raise ValueError("Reference constraints must match the ordered reference bindings")
    for constraint in constraints:
        if (not isinstance(constraint, dict) or set(constraint) != {"role", "width", "height", "mime_types"}
                or constraint.get("role") != "first_frame" or constraint.get("mime_types") != ["image/png"]
                or any(type(constraint.get(k)) is not int or not 0 < constraint[k] <= 32768 for k in ("width", "height"))):
            raise ValueError("Constrained first frames currently require explicit PNG width/height")
    if not item.get("output_nodes") or any(str(node) not in workflow for node in item["output_nodes"]):
        raise ValueError("Output nodes must exist in the recipe")


class Adapter:
    def __init__(self, state_dir, client=None, recipes=None, enabled=False, max_result_bytes=MAX_RESULT_BYTES):
        self.state = Path(state_dir).resolve()
        self.state.mkdir(parents=True, exist_ok=True)
        for name in ("references", "results", "staging"):
            (self.state / name).mkdir(exist_ok=True)
            if not (self.state / name).resolve().is_relative_to(self.state):
                raise ValueError("Adapter state directories must not point outside the persistent state root")
        self.client, self.recipes = client or ComfyClient(), recipes or {}
        for recipe in self.recipes.values():
            validate_recipe(recipe)
        self.enabled, self.max_result_bytes = enabled, max_result_bytes
        self.lock = threading.RLock()
        database_path = self.state / "adapter.sqlite3"
        if not database_path.resolve().is_relative_to(self.state):
            raise ValueError("Adapter database must stay inside the persistent state root")
        self.db = sqlite3.connect(database_path, check_same_thread=False, timeout=10)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA foreign_keys=ON")
        if self.db.execute("PRAGMA user_version").fetchone()[0] not in (0, 1):
            self.db.close()
            raise ValueError("Unsupported adapter schema version; preserve the database and use a compatible adapter")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS objects(kind TEXT NOT NULL,id TEXT NOT NULL,project_id TEXT,payload TEXT NOT NULL,PRIMARY KEY(kind,id));
            CREATE TABLE IF NOT EXISTS job_keys(request_key TEXT PRIMARY KEY,job_id TEXT NOT NULL,fingerprint TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS job_identity(project_id TEXT NOT NULL,shot_id TEXT NOT NULL,attempt INTEGER NOT NULL,fingerprint TEXT NOT NULL,job_id TEXT NOT NULL,UNIQUE(project_id,shot_id,attempt),UNIQUE(project_id,shot_id,attempt,fingerprint));
            PRAGMA user_version=1;
        """)
        # A crash after sending /prompt cannot safely be replayed without a prompt ID.
        for job in self.list_objects("job"):
            if job["status"] == "submitting":
                job.update(status="submission_unknown", error="restart_during_submission", updated_at=now())
                self.put("job", job)
        self.db.commit()

    def close(self):
        with self.lock:
            self.db.close()

    def put(self, kind, value):
        self.db.execute("INSERT OR REPLACE INTO objects(kind,id,project_id,payload) VALUES(?,?,?,?)",
                        (kind, value["id"], value.get("project_id"), json.dumps(value, ensure_ascii=False)))
        self.db.commit()

    def get(self, kind, identifier):
        row = self.db.execute("SELECT payload FROM objects WHERE kind=? AND id=?", (kind, identifier)).fetchone()
        if row is None:
            raise ApiError(404, "not_found", f"{kind} not found")
        return json.loads(row["payload"])

    def list_objects(self, kind, project_id=None):
        rows = self.db.execute("SELECT payload FROM objects WHERE kind=? ORDER BY rowid", (kind,))
        values = [json.loads(row["payload"]) for row in rows]
        return [v for v in values if project_id is None or v.get("project_id") == project_id]

    def public_asset(self, asset):
        return {k: v for k, v in asset.items() if k != "relative_path"}

    def content(self, asset):
        path = (self.state / asset["relative_path"]).resolve()
        if not path.is_relative_to(self.state) or not path.is_file():
            raise ApiError(404, "asset_file_unavailable")
        return path

    def validate_refs(self, ids, project_id):
        if not isinstance(ids, list) or len(ids) > 8 or len(set(map(str, ids))) != len(ids):
            raise ApiError(400, "invalid_references")
        for identifier in ids:
            asset = self.get("asset", text_field(identifier, "asset id", 100))
            if asset["project_id"] != project_id or asset["mime_type"] not in IMAGE_MIMES:
                raise ApiError(400, "reference_project_mismatch")
        return ids

    def config(self):
        return {"generation_enabled": self.enabled, "storage_scope": "sidecar", "concurrency": 1,
                "max_reference_bytes": MAX_REFERENCE_BYTES, "recipe_count": len(self.recipes)}

    def health(self):
        try:
            queue = validate_queue(self.client.json("/queue"))
            return {"adapter": "ok", "comfy_reachable": True, "queue_running": len(queue.get("queue_running", [])),
                    "queue_pending": len(queue.get("queue_pending", [])), "generation_enabled": self.enabled}
        except (OSError, ValueError, ApiError, http.client.HTTPException):
            return {"adapter": "ok", "comfy_reachable": False, "queue_running": None, "queue_pending": None,
                    "generation_enabled": self.enabled}

    def create_asset(self, body):
        fields(body, {"project_id", "name", "kind", "mime_type", "data_base64", "upstream_asset_id"})
        project_id = self.get("project", body.get("project_id"))["id"]
        name = text_field(body.get("name"), "name", 300)
        if body.get("kind") not in ("character", "scene", "prop", "reference") or body.get("mime_type") not in IMAGE_MIMES:
            raise ApiError(400, "invalid_asset_type")
        encoded = text_field(body.get("data_base64"), "data_base64", (MAX_REFERENCE_BYTES + 2) // 3 * 4)
        try:
            data = base64.b64decode(encoded, validate=True)
        except (ValueError, binascii.Error):
            raise ApiError(400, "invalid_base64") from None
        if not data or len(data) > MAX_REFERENCE_BYTES:
            raise ApiError(413, "reference_too_large")
        if not image_matches(data, body["mime_type"]):
            raise ApiError(400, "image_type_mismatch")
        dimensions = png_dimensions(data) if body["mime_type"] == "image/png" else None
        upstream = body.get("upstream_asset_id")
        if upstream is not None:
            text_field(upstream, "upstream_asset_id", 200)
        identifier = uid()
        relative = f"references/{identifier}{IMAGE_MIMES[body['mime_type']]}"
        destination = self.state / relative
        if not destination.resolve().is_relative_to(self.state):
            raise ApiError(500, "invalid_reference_path")
        with destination.open("xb") as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        asset = {"id": identifier, "project_id": project_id, "name": name, "kind": body["kind"],
                 "mime_type": body["mime_type"], "size": len(data), "sha256": hashlib.sha256(data).hexdigest(),
                 "source": "reference_upload", "upstream_asset_id": upstream, "job_id": None, "shot_id": None,
                 "relative_path": relative, "content_url": f"{PREFIX}/assets/{identifier}/content", "created_at": now()}
        if dimensions:
            asset.update(width=dimensions[0], height=dimensions[1])
        self.put("asset", asset)
        return self.public_asset(asset)

    def fingerprint(self, spec):
        return hashlib.sha256(json.dumps(spec, sort_keys=True, separators=(",", ":")).encode()).hexdigest()

    def submit(self, body, parent=None):
        if not self.enabled:
            raise ApiError(403, "generation_disabled", "Generation is disabled by the service operator")
        fields(body, {"project_id", "shot_id", "recipe_id", "prompt", "seed", "reference_asset_ids", "request_key"})
        key = text_field(body.get("request_key"), "request_key", 200)
        project_id = self.get("project", body.get("project_id"))["id"]
        shot = self.get("shot", body.get("shot_id"))
        if shot["project_id"] != project_id:
            raise ApiError(400, "shot_project_mismatch")
        recipe_id = text_field(body.get("recipe_id"), "recipe_id", 100)
        recipe = self.recipes.get(recipe_id)
        if recipe is None:
            raise ApiError(400, "recipe_not_available")
        prompt = text_field(body.get("prompt"), "prompt", 30000)
        seed = body.get("seed")
        if type(seed) is not int or not 0 <= seed <= 9007199254740991:
            raise ApiError(400, "invalid_seed")
        refs = self.validate_refs(body.get("reference_asset_ids", shot["reference_asset_ids"]), project_id)
        slots = len(recipe["bindings"].get("references", []))
        if refs and slots == 0:
            raise ApiError(400, "recipe_has_no_reference_binding")
        if len(refs) != slots:
            raise ApiError(400, "reference_count_mismatch")
        for asset_id, constraint in zip(refs, recipe.get("reference_constraints", [])):
            asset = self.get("asset", asset_id)
            if asset["mime_type"] not in constraint["mime_types"]:
                raise ApiError(400, "reference_mime_not_supported", "This first-frame recipe requires PNG for verified dimensions")
            with self.content(asset).open("rb") as source:
                width, height = png_dimensions(source.read(24))
            target_width, target_height = constraint["width"], constraint["height"]
            if width * target_height != height * target_width:
                raise ApiError(400, "reference_aspect_mismatch", "First frame must match the recipe aspect ratio; prepare a scene frame first")
            if width < target_width or height < target_height:
                raise ApiError(400, "reference_resolution_too_small", "First frame must be at least the recipe output size")
        attempt = parent["attempt"] + 1 if parent else 1
        spec = {"project_id": project_id, "shot_id": shot["id"], "recipe_id": recipe_id, "prompt": prompt,
                "seed": seed, "reference_asset_ids": refs, "attempt": attempt, "parent_job_id": parent["id"] if parent else None,
                "workflow_sha256": self.fingerprint(recipe["workflow"]),
                "recipe_sha256": self.fingerprint({k: recipe.get(k, []) for k in ("workflow", "bindings", "output_nodes", "reference_constraints")}),
                "output_nodes": [str(n) for n in recipe["output_nodes"]]}
        fingerprint = self.fingerprint(spec)
        previous = self.db.execute("SELECT * FROM job_keys WHERE request_key=?", (key,)).fetchone()
        if previous:
            if previous["fingerprint"] != fingerprint:
                raise ApiError(409, "request_key_conflict")
            return dict(self.get("job", previous["job_id"]), deduplicated=True)
        identity = self.db.execute("SELECT * FROM job_identity WHERE project_id=? AND shot_id=? AND attempt=?",
                                   (project_id, shot["id"], attempt)).fetchone()
        if identity:
            if identity["fingerprint"] != fingerprint:
                raise ApiError(409, "shot_attempt_conflict", "Use the explicit retry operation to create a new shot attempt")
            self.db.execute("INSERT INTO job_keys VALUES(?,?,?)", (key, identity["job_id"], fingerprint))
            self.db.commit()
            return dict(self.get("job", identity["job_id"]), deduplicated=True)
        if any(job["status"] in ACTIVE for job in self.list_objects("job")):
            raise ApiError(409, "local_concurrency_limit", "An existing local job must be reconciled first")
        try:
            queue = validate_queue(self.client.json("/queue"))
        except (OSError, ValueError, ApiError, http.client.HTTPException):
            raise ApiError(503, "comfy_unavailable", "Cannot verify Comfy queue; no job was submitted") from None
        if queue.get("queue_running") or queue.get("queue_pending"):
            raise ApiError(409, "upstream_busy", "The shared Comfy queue is busy; no job was submitted")
        identifier = uid()
        job = {"id": identifier, **spec, "request_key": key, "prompt_id": None, "status": "submitting", "error": None,
               "results": [], "archived_asset_ids": [], "created_at": now(), "updated_at": now()}
        # Commit all dedup guards before any network mutation, including after restart.
        self.db.execute("INSERT INTO objects VALUES(?,?,?,?)", ("job", identifier, project_id, json.dumps(job)))
        self.db.execute("INSERT INTO job_keys VALUES(?,?,?)", (key, identifier, fingerprint))
        self.db.execute("INSERT INTO job_identity VALUES(?,?,?,?,?)", (project_id, shot["id"], attempt, fingerprint, identifier))
        self.db.commit()
        workflow = copy.deepcopy(recipe["workflow"])
        for field, value in (("prompt", prompt), ("seed", seed)):
            binding = recipe["bindings"][field]
            workflow[str(binding["node"])]["inputs"][binding["field"]] = value
        if recipe["bindings"].get("output_prefix"):
            binding = recipe["bindings"]["output_prefix"]
            workflow[str(binding["node"])]["inputs"][binding["field"]] = "BeefTV/" + identifier
        try:
            for binding, asset_id in zip(recipe["bindings"].get("references", []), refs):
                asset = self.get("asset", asset_id)
                filename = asset["id"] + IMAGE_MIMES[asset["mime_type"]]
                uploaded = self.client.upload(self.content(asset).read_bytes(), filename, asset["mime_type"])
                workflow[str(binding["node"])]["inputs"][binding["field"]] = uploaded
        except (OSError, ValueError, ApiError, http.client.HTTPException):
            job.update(status="failed", error="reference_upload_failed", updated_at=now())
            self.put("job", job)
            return job
        # Uploads can take time; check the shared queue again before the only /prompt POST.
        try:
            queue = validate_queue(self.client.json("/queue"))
        except (OSError, ValueError, ApiError, http.client.HTTPException):
            job.update(status="failed", error="comfy_queue_check_failed", updated_at=now())
            self.put("job", job)
            return job
        if queue["queue_running"] or queue["queue_pending"]:
            job.update(status="failed", error="upstream_became_busy", updated_at=now())
            self.put("job", job)
            return job
        try:
            response = self.client.json("/prompt", {"prompt": workflow, "client_id": "beeftv-" + identifier})
            if response.get("node_errors") and not response.get("prompt_id"):
                raise ComfyRejected("comfy_validation_rejected")
            prompt_id = response.get("prompt_id")
            if not isinstance(prompt_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,200}", prompt_id):
                raise ValueError("Missing prompt ID")
            job.update(prompt_id=prompt_id, status="submitted", error=None)
        except ComfyRejected:
            job.update(status="failed", error="comfy_validation_rejected")
        except (OSError, ValueError, ApiError, http.client.HTTPException):
            job.update(status="submission_unknown", error="submission_outcome_unknown")
        job["updated_at"] = now()
        self.put("job", job)
        return job

    def poll(self, job):
        if job["status"] not in ("submitted", "running"):
            return job
        try:
            history = self.client.json("/history/" + parse.quote(job["prompt_id"], safe=""))
            entry = history.get(job["prompt_id"])
            if entry:
                if not isinstance(entry, dict):
                    raise ValueError("Invalid history entry")
                status = entry.get("status", {})
                if not isinstance(status, dict) or not isinstance(status.get("messages", []), list):
                    raise ValueError("Invalid history status")
                messages = status.get("messages", [])
                if status.get("status_str") == "error" or any(isinstance(m, list) and m and m[0] in ("execution_error", "execution_interrupted") for m in messages):
                    job.update(status="failed", error="comfy_execution_failed")
                elif status.get("completed") is True:
                    results = []
                    outputs = entry.get("outputs", {})
                    if not isinstance(outputs, dict):
                        raise ValueError("Invalid history outputs")
                    for node_id in job["output_nodes"]:
                        node_output = outputs.get(str(node_id), {})
                        if not isinstance(node_output, dict):
                            raise ValueError("Invalid node outputs")
                        for key in ("images", "gifs", "videos", "audio"):
                            media = node_output.get(key, [])
                            if not isinstance(media, list):
                                raise ValueError("Invalid output media")
                            for raw in media:
                                descriptor = safe_descriptor(raw)
                                descriptor["node_id"] = str(node_id)
                                if descriptor not in results:
                                    results.append(descriptor)
                    if len(results) > 16:
                        raise ApiError(502, "too_many_results")
                    if results:
                        job.update(status="completed", error=None, results=results)
                    else:
                        job.update(status="failed", error="comfy_completed_without_results", results=[])
                else:
                    job.update(status="running", error=None)
            else:
                queue = validate_queue(self.client.json("/queue"))
                def contains(items):
                    return any(isinstance(item, list) and len(item) > 1 and item[1] == job["prompt_id"] for item in items)
                if contains(queue.get("queue_running", [])):
                    job.update(status="running", error=None)
                elif contains(queue.get("queue_pending", [])):
                    job.update(status="submitted", error=None)
                else:
                    # Missing history is not definitive evidence of failure or permission to resubmit.
                    job["error"] = "history_not_available"
        except (OSError, ValueError, ApiError, http.client.HTTPException):
            job["error"] = "comfy_poll_unavailable"
        job["updated_at"] = now()
        self.put("job", job)
        return job

    def archive(self, job):
        if job["status"] != "completed":
            raise ApiError(409, "job_not_completed")
        for index, result in enumerate(job["results"]):
            existing = [a for a in self.list_objects("asset", job["project_id"])
                        if a.get("job_id") == job["id"] and a.get("result_index") == index]
            if existing:
                if existing[0]["id"] not in job["archived_asset_ids"]:
                    job["archived_asset_ids"].append(existing[0]["id"])
                continue
            descriptor = safe_descriptor(result)
            extension = Path(descriptor["filename"]).suffix.lower()
            mime = mimetypes.guess_type("file" + extension)[0]
            if mime not in RESULT_MIMES:
                raise ApiError(502, "unsupported_result_media")
            identifier = uid()
            temporary = self.state / "staging" / (identifier + ".part")
            if not temporary.resolve().is_relative_to(self.state):
                raise ApiError(500, "invalid_archive_path")
            try:
                size, digest, prefix = self.client.download(descriptor, temporary, self.max_result_bytes)
                if not image_matches(prefix, mime):
                    raise ApiError(502, "result_type_mismatch")
                directory = self.state / "results" / job["project_id"] / job["shot_id"] / job["id"]
                if not directory.resolve().is_relative_to(self.state):
                    raise ApiError(500, "invalid_archive_path")
                directory.mkdir(parents=True, exist_ok=True)
                final = directory / (identifier + RESULT_MIMES[mime])
                temporary.rename(final)
            except ApiError:
                temporary.unlink(missing_ok=True)
                raise
            except (OSError, ValueError, http.client.HTTPException):
                temporary.unlink(missing_ok=True)
                raise ApiError(502, "result_download_failed", "Result was not fully archived; retry archive, not generation") from None
            asset = {"id": identifier, "project_id": job["project_id"], "name": descriptor["filename"], "kind": "result",
                     "mime_type": mime, "size": size, "sha256": digest, "source": "comfy_result", "upstream_asset_id": None,
                     "job_id": job["id"], "shot_id": job["shot_id"], "result_index": index,
                     "relative_path": final.relative_to(self.state).as_posix(),
                     "content_url": f"{PREFIX}/assets/{identifier}/content", "created_at": now()}
            self.put("asset", asset)
            job["archived_asset_ids"].append(identifier)
            job["updated_at"] = now()
            self.put("job", job)
        self.put("job", job)
        return job

    def dispatch(self, method, path, query=None, body=None):
        query, body = query or {}, body or {}
        with self.lock:
            if path == "/config" and method == "GET":
                return self.config()
            if path == "/health" and method == "GET":
                return self.health()
            if path == "/recipes" and method == "GET":
                return [{"id": r["id"], "name": r.get("name", r["id"]), "mode": r.get("mode", "t2i"),
                         "reference_slots": len(r["bindings"].get("references", [])), "ready": True,
                         "reference_constraints": r.get("reference_constraints", [])} for r in self.recipes.values()]
            parts = path.strip("/").split("/")
            if len(parts) == 1 and method == "GET" and parts[0] in ("projects", "assets", "shots", "jobs"):
                project_id = query.get("project_id")
                if project_id:
                    self.get("project", project_id)
                result = self.list_objects(parts[0][:-1], project_id)
                for key in ("kind", "shot_id"):
                    if query.get(key):
                        result = [v for v in result if v.get(key) == query[key]]
                return [self.public_asset(v) for v in result] if parts[0] == "assets" else result
            if path == "/projects" and method == "POST":
                fields(body, {"name", "upstream_project_id"})
                upstream = body.get("upstream_project_id")
                if upstream is not None:
                    text_field(upstream, "upstream_project_id", 200)
                project = {"id": uid(), "name": text_field(body.get("name"), "name", 300), "upstream_project_id": upstream,
                           "storage_scope": "sidecar", "script": "", "script_format": "text", "created_at": now()}
                self.put("project", project)
                return project
            if path == "/assets" and method == "POST":
                return self.create_asset(body)
            if path == "/shots" and method == "POST":
                fields(body, {"project_id", "name", "upstream_shot_id", "reference_asset_ids"})
                project_id = self.get("project", body.get("project_id"))["id"]
                upstream = body.get("upstream_shot_id")
                if upstream is not None:
                    text_field(upstream, "upstream_shot_id", 200)
                shot = {"id": uid(), "project_id": project_id, "name": text_field(body.get("name"), "name", 300),
                        "upstream_shot_id": upstream, "reference_asset_ids": self.validate_refs(body.get("reference_asset_ids", []), project_id),
                        "created_at": now()}
                self.put("shot", shot)
                return shot
            if path == "/jobs" and method == "POST":
                return self.submit(body)
            if len(parts) >= 2 and parts[0] in ("projects", "assets", "shots", "jobs"):
                kind = parts[0][:-1]
                entity = self.get(kind, parts[1])
                if len(parts) == 2 and method == "GET":
                    return self.public_asset(entity) if kind == "asset" else entity
                if len(parts) == 3 and parts[2] == "content" and kind == "asset" and method == "GET":
                    return self.content(entity), entity
                if len(parts) == 3 and method == "POST":
                    action = parts[2]
                    if kind == "project" and action == "script":
                        fields(body, {"script", "format"})
                        if body.get("format", "text") != "text":
                            raise ApiError(400, "unsupported_script_format")
                        entity.update(script=text_field(body.get("script"), "script", 1024 * 1024, True), script_format="text")
                        self.put(kind, entity)
                        return entity
                    if kind == "shot" and action == "references":
                        fields(body, {"asset_ids"})
                        entity["reference_asset_ids"] = self.validate_refs(body.get("asset_ids"), entity["project_id"])
                        self.put(kind, entity)
                        return entity
                    if kind == "job" and action in ("poll", "archive"):
                        fields(body, set())
                        return self.poll(entity) if action == "poll" else self.archive(entity)
                    if kind == "job" and action == "retry":
                        fields(body, {"request_key", "prompt", "seed"})
                        if entity["status"] not in ("failed", "completed"):
                            raise ApiError(409, "retry_not_safe", "Retry requires a definitive failure or a completed shot; unknown submissions need manual reconciliation")
                        spec = {k: entity[k] for k in ("project_id", "shot_id", "recipe_id", "prompt", "seed", "reference_asset_ids")}
                        spec.update(body)
                        return self.submit(spec, parent=entity)
            raise ApiError(404, "route_not_found")


class Handler(BaseHTTPRequestHandler):
    server_version = "BeefTVComfyAdapter/1"
    protocol_version = "HTTP/1.0"

    def log_message(self, format, *args):
        # Request paths, private prompts and credentials never enter access logs.
        pass

    def send_json(self, status, data=None, reason=None, msg="ok"):
        raw = json.dumps({"code": 0 if status < 400 else status, "data": data, "msg": msg, "reason": reason}, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(raw)

    def handle_api(self):
        try:
            parsed = parse.urlsplit(self.path)
            if not parsed.path.startswith(PREFIX + "/"):
                raise ApiError(404, "route_not_found")
            body = {}
            if self.command == "POST":
                origin = self.headers.get("Origin")
                allowed = self.server.allowed_origins
                if origin and origin not in allowed and origin not in ("http://" + self.headers.get("Host", ""), "https://" + self.headers.get("Host", "")):
                    raise ApiError(403, "origin_not_allowed")
                if self.headers.get("Content-Type", "").split(";")[0].strip().lower() != "application/json":
                    raise ApiError(415, "json_required")
                length = self.headers.get("Content-Length", "")
                if not length.isdigit():
                    raise ApiError(411, "content_length_required")
                if int(length) > MAX_BODY_BYTES:
                    raise ApiError(413, "request_too_large")
                try:
                    body = json.loads(self.rfile.read(int(length)))
                except (ValueError, UnicodeDecodeError):
                    raise ApiError(400, "invalid_json") from None
                if not isinstance(body, dict):
                    raise ApiError(400, "json_object_required")
            query = {key: values[-1] for key, values in parse.parse_qs(parsed.query, max_num_fields=10).items()}
            result = self.server.adapter.dispatch(self.command, parsed.path[len(PREFIX):], query, body)
            if isinstance(result, tuple):
                path, asset = result
                with path.open("rb") as stream:
                    self.send_response(200)
                    self.send_header("Content-Type", asset["mime_type"])
                    self.send_header("Content-Length", str(path.stat().st_size))
                    self.send_header("Content-Disposition", f'inline; filename="{asset["id"]}{RESULT_MIMES[asset["mime_type"]]}"')
                    self.send_header("X-Content-Type-Options", "nosniff")
                    self.send_header("Cache-Control", "private, no-store")
                    self.end_headers()
                    while chunk := stream.read(64 * 1024):
                        self.wfile.write(chunk)
            else:
                self.send_json(200, result)
        except ApiError as exc:
            self.send_json(exc.status, exc.data, exc.reason, exc.msg)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            self.send_json(500, reason="adapter_internal_error", msg="Adapter operation failed")

    do_GET = handle_api
    do_POST = handle_api


def make_server(adapter, host="127.0.0.1", port=6007, allowed_origins=()):
    server = ThreadingHTTPServer((host, port), Handler)
    server.adapter, server.allowed_origins = adapter, set(allowed_origins)
    return server


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default=os.getenv("BEEFTV_COMFY_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.getenv("BEEFTV_COMFY_PORT", "6007")))
    parser.add_argument("--state-dir", default=os.getenv("BEEFTV_COMFY_STATE_DIR"))
    args = parser.parse_args()
    if not args.state_dir:
        parser.error("--state-dir or BEEFTV_COMFY_STATE_DIR is required (use a private persistent directory)")
    try:
        adapter = Adapter(args.state_dir, ComfyClient(os.getenv("BEEFTV_COMFY_URL", "")),
                          load_recipes(os.getenv("BEEFTV_COMFY_RECIPES", "")),
                          enabled=os.getenv("BEEFTV_COMFY_ENABLE_GENERATION", "0") == "1")
    except (OSError, ValueError, KeyError, ApiError):
        parser.error("Invalid or unavailable private adapter configuration; check workflow files and bindings")
    origins = [o for o in os.getenv("BEEFTV_COMFY_ALLOWED_ORIGINS", "").split(",") if o]
    server = make_server(adapter, args.host, args.port, origins)
    try:
        print(f"BeefTV Comfy adapter ready on port {server.server_port}; generation_enabled={adapter.enabled}", flush=True)
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        adapter.close()


if __name__ == "__main__":
    main()
