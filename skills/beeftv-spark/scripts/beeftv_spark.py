#!/usr/bin/env python3
"""Short-lived stdlib client for BeefTV's local ComfyUI sidecar API."""

from __future__ import annotations

import argparse
import base64
import hashlib
import http.client
import json
import mimetypes
import os
from pathlib import Path
import socket
import time
from urllib import error, parse, request

PREFIX = "/api/local-comfy/v1"
TERMINAL = {"completed", "failed", "submission_unknown"}
MAX_RESULT_BYTES = 256 * 1024 * 1024
MAX_JSON_BYTES = 8 * 1024 * 1024


class ClientError(Exception):
    def __init__(self, reason, message, *, data=None, status=None):
        super().__init__(message)
        self.reason, self.message, self.data, self.status = reason, message, data, status


class NoRedirect(request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Client:
    def __init__(self, base_url, timeout=20, state_dir=None):
        parsed = parse.urlsplit(base_url)
        if (parsed.scheme not in {"http", "https"} or not parsed.hostname
                or parsed.username or parsed.password or parsed.query or parsed.fragment
                or parsed.path.rstrip("/") not in {"", PREFIX}):
            raise ClientError("invalid_config", "Use an HTTP(S) service origin or API prefix without credentials/query/fragment.")
        try:
            parsed.port
        except ValueError as exc:
            raise ClientError("invalid_config", "Invalid service port.") from exc
        self.base_url = base_url.rstrip("/")
        if not self.base_url.endswith(PREFIX):
            self.base_url += PREFIX
        self.origin_url = parsed.scheme + "://" + parsed.netloc
        self.timeout = timeout
        self.state_dir = Path(state_dir) if state_dir else None
        self.opener = request.build_opener(request.ProxyHandler({}), NoRedirect())

    def call(self, method, path, body=None, query=None, raw=False, upstream=False):
        suffix = "?" + parse.urlencode({k: v for k, v in (query or {}).items() if v is not None}) if query else ""
        payload = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
        root = self.origin_url + "/api" if upstream else self.base_url
        req = request.Request(root + path + suffix, data=payload, method=method,
                              headers={"Accept": "application/json" if not raw else "*/*"})
        if payload is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with self.opener.open(req, timeout=self.timeout) as response:
                limit = MAX_RESULT_BYTES if raw else MAX_JSON_BYTES
                content = read_bounded(response, limit, "result_too_large" if raw else "invalid_response")
        except error.HTTPError as exc:
            try:
                envelope = json.loads(exc.read())
            except (ValueError, UnicodeError):
                envelope = {}
            if not isinstance(envelope, dict):
                envelope = {}
            reason = envelope.get("reason") or "http_error"
            raise ClientError(reason, "API rejected the request.", data=envelope.get("data"), status=exc.code) from exc
        except (error.URLError, TimeoutError, socket.timeout, ConnectionError, OSError, http.client.HTTPException) as exc:
            raise ClientError("transport_error", "Service did not return a complete response; check its availability.") from exc
        if raw:
            return content
        try:
            envelope = json.loads(content)
        except (ValueError, UnicodeError) as exc:
            raise ClientError("invalid_response", "Service response is not a JSON envelope.") from exc
        if not isinstance(envelope, dict) or "code" not in envelope or "data" not in envelope:
            raise ClientError("invalid_response", "Service response is not a versioned API envelope.")
        if envelope["code"] != 0:
            raise ClientError(envelope.get("reason") or "api_error", "API returned a nonzero business code.", data=envelope.get("data"))
        return envelope["data"]

    def upstream_scope(self):
        scope = self.call("GET", "/workspace/bootstrap", upstream=True)
        if (scope.get("profile") != "local" or not scope.get("workspace", {}).get("id")
                or not scope.get("user", {}).get("id")):
            raise ClientError("unsupported_workspace_scope", "Canonical operations require a real local workspace bootstrap; no default IDs or credentials are supplied.")
        return scope

    def upstream_call(self, method, path, body=None, query=None):
        self.upstream_scope()
        try:
            return self.call(method, path, body, query=query, upstream=True)
        except ClientError as exc:
            if method != "GET" and (exc.reason in {"transport_error", "invalid_response"}
                                    or exc.status is not None and exc.status >= 500):
                raise ClientError("request_outcome_unknown", "Canonical mutation may have succeeded; query the project before repeating. This upstream API has no client request-key deduplication.") from exc
            raise

    def generation_gate(self, allowed, recipe_id):
        if not allowed:
            raise ClientError("generation_not_authorized", "Generation requires --allow-generation and authorization for this shot.")
        config = self.call("GET", "/config")
        if config.get("generation_enabled") is not True:
            raise ClientError("generation_disabled", "Server generation is disabled; do not enable it through this client.")
        recipe = next((item for item in self.call("GET", "/recipes") if item["id"] == recipe_id), None)
        if recipe is None or recipe.get("ready") is not True:
            raise ClientError("recipe_unavailable", "The selected recipe is absent or not ready.")

    def mutation(self, path, body, command):
        if self.state_dir is None:
            raise ClientError("missing_state_dir", "Generation needs a private --state-dir or config state_dir.")
        key = body["request_key"]
        if not key.strip():
            raise ClientError("invalid_request_key", "request_key must not be empty.")
        digest = hashlib.sha256(json.dumps({"path": path, "body": body}, sort_keys=True,
                                         ensure_ascii=False).encode("utf-8")).hexdigest()
        self.state_dir.mkdir(parents=True, exist_ok=True)
        ledger = self.state_dir / (hashlib.sha256(key.encode("utf-8")).hexdigest() + ".json")
        if ledger.exists():
            old = read_ledger(ledger)
            if old["body_sha256"] != digest:
                raise ClientError("request_key_conflict", "This local request key already identifies different input.")
            if old["state"] in {"pending", "request_outcome_unknown"}:
                raise ClientError("request_outcome_unknown", "Check jobs for this shot before further submission; the local ledger outcome is unknown.", data={"request_key": key})
            if old.get("job_id"):
                return self.call("GET", "/jobs/" + component(old["job_id"]))
        try:
            saved_ledgers = [saved for saved in self.state_dir.iterdir() if saved.suffix == ".json"]
        except OSError as exc:
            raise ClientError("invalid_request_ledger", "Private request ledgers cannot be enumerated. Reconcile access before generation writes.") from exc
        for saved in saved_ledgers:
            previous = read_ledger(saved)
            if previous["state"] in {"pending", "request_outcome_unknown"}:
                raise ClientError("request_outcome_unknown", "An unresolved submission exists in this private ledger. Query and reconcile it before any new generation write.")
        record = {"request_key": key, "command": command, "body_sha256": digest, "state": "pending"}
        atomic_json(ledger, record)
        try:
            job = self.call("POST", path, body)
            if not isinstance(job, dict) or not job.get("id"):
                raise ClientError("invalid_response", "Submission did not return a job ID.")
        except ClientError as exc:
            unknown = exc.reason in {"transport_error", "invalid_response"} or exc.status is not None and exc.status >= 500
            record["state"] = "request_outcome_unknown" if unknown else "rejected"
            atomic_json(ledger, record)
            if unknown:
                raise ClientError("request_outcome_unknown", "Submission may have been accepted. Query jobs; do not retry with a new key.", data={"request_key": key}) from exc
            raise
        record.update(state="submitted", job_id=job["id"])
        try:
            atomic_json(ledger, record)
        except OSError as exc:
            raise ClientError("request_outcome_unknown", "Job was accepted but the local ledger could not be finalized. Query this job before further submission.",
                              data={"request_key": key, "job_id": job["id"]}) from exc
        return job


def component(value):
    return parse.quote(str(value), safe="")


def read_bounded(response, limit, reason):
    declared = response.headers.get("Content-Length")
    try:
        expected = int(declared) if declared is not None else None
    except ValueError as exc:
        raise ClientError("invalid_response", "Response Content-Length is invalid.") from exc
    if expected is not None and (expected < 0 or expected > limit):
        raise ClientError(reason, "Response exceeds the client byte limit.")
    chunks, count = [], 0
    while True:
        chunk = response.read(min(64 * 1024, limit - count + 1))
        if not chunk:
            break
        chunks.append(chunk)
        count += len(chunk)
        if count > limit:
            raise ClientError(reason, "Response exceeds the client byte limit.")
    if expected is not None and count != expected:
        raise ClientError("transport_error", "Response body is incomplete.")
    return b"".join(chunks)


def atomic_json(path, value):
    temporary = path.with_suffix(".pending")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def read_ledger(path):
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, UnicodeError) as exc:
        raise ClientError("invalid_request_ledger", "A private request ledger cannot be read or parsed. Reconcile it before generation writes.") from exc
    if (not isinstance(value, dict) or value.get("state") not in {"pending", "request_outcome_unknown", "submitted", "rejected"}
            or not isinstance(value.get("request_key"), str) or not value["request_key"].strip()
            or not isinstance(value.get("body_sha256"), str) or len(value["body_sha256"]) != 64
            or any(letter not in "0123456789abcdef" for letter in value["body_sha256"])
            or value["state"] == "submitted" and not isinstance(value.get("job_id"), str)
            or value["state"] == "submitted" and not value["job_id"]):
        raise ClientError("invalid_request_ledger", "A private request ledger has invalid fields. Reconcile it before generation writes.")
    return value


def save_new(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with path.open("xb") as stream:
            stream.write(content)
    except FileExistsError as exc:
        raise ClientError("destination_exists", "Destination already exists; choose a new file path.") from exc
    return str(path)


def download_asset(client, asset_id, asset=None):
    asset = asset or client.call("GET", "/assets/" + component(asset_id))
    expected_size, expected_hash = asset.get("size"), asset.get("sha256")
    if (not isinstance(expected_size, int) or isinstance(expected_size, bool) or expected_size < 0
            or not isinstance(expected_hash, str) or len(expected_hash) != 64
            or any(letter not in "0123456789abcdef" for letter in expected_hash.lower())):
        raise ClientError("invalid_asset_metadata", "Asset needs an exact byte size and SHA-256 before download.")
    if expected_size > MAX_RESULT_BYTES:
        raise ClientError("result_too_large", "Asset exceeds the 256 MiB client download limit.")
    content = client.call("GET", "/assets/" + component(asset_id) + "/content", raw=True)
    if len(content) != expected_size:
        raise ClientError("result_size_mismatch", "Downloaded bytes do not match asset metadata; no output file was written.")
    if hashlib.sha256(content).hexdigest() != expected_hash.lower():
        raise ClientError("result_hash_mismatch", "Downloaded bytes do not match asset SHA-256; no output file was written.")
    return content


def read_text(path):
    return Path(path).read_text(encoding="utf-8-sig")


def build_parser():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", help="Private JSON config; base_url and optional state_dir")
    parser.add_argument("--base-url", help="Service origin, otherwise BEEFTV_SPARK_URL/config")
    parser.add_argument("--state-dir", help="Private local request ledger directory")
    parser.add_argument("--timeout", type=float, default=20)
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("health", "config", "recipes", "projects"):
        sub.add_parser(name)
    for name in ("upstream-bootstrap", "upstream-projects"):
        sub.add_parser(name)
    command = sub.add_parser("upstream-project-create")
    command.add_argument("--name", required=True)
    command.add_argument("--type", required=True)
    command.add_argument("--aspect-ratio", required=True)
    command.add_argument("--source-type", required=True)
    command.add_argument("--description")
    command.add_argument("--style-preset-id")
    for name in ("upstream-project-get", "upstream-units", "upstream-assets"):
        command = sub.add_parser(name)
        command.add_argument("--project", required=True)
        if name == "upstream-assets":
            command.add_argument("--category", choices=["character", "environment", "prop", "material", "other"])
            command.add_argument("--page", type=int, default=1)
            command.add_argument("--page-size", type=int, default=40)
    command = sub.add_parser("upstream-script-import")
    command.add_argument("--project", required=True)
    command.add_argument("--file", required=True)
    command.add_argument("--kind", required=True, choices=["chapter", "episode"])
    command.add_argument("--title", required=True)
    command = sub.add_parser("upstream-shot-create")
    command.add_argument("--project", required=True)
    command.add_argument("--unit")
    command.add_argument("--title", required=True)
    command.add_argument("--description-file", required=True)
    command.add_argument("--duration-ms", type=int, required=True)
    command.add_argument("--position", type=int, required=True)
    command = sub.add_parser("upstream-shot-link")
    command.add_argument("--project", required=True)
    command.add_argument("--shot", required=True)
    command.add_argument("--asset-version", required=True)
    command.add_argument("--role", required=True, choices=["reference", "start_frame", "end_frame", "keyframe", "storyboard", "output"])
    command = sub.add_parser("upstream-character-get")
    command.add_argument("--project", required=True)
    command.add_argument("--asset", required=True)
    command = sub.add_parser("project-create")
    command.add_argument("--name", required=True)
    command.add_argument("--upstream-project-id")
    command = sub.add_parser("script-import")
    command.add_argument("--project", required=True)
    command.add_argument("--file", required=True)
    command = sub.add_parser("assets")
    command.add_argument("--project")
    command.add_argument("--kind", choices=["character", "scene", "prop", "reference", "result"])
    for name in ("asset-get", "asset-download"):
        command = sub.add_parser(name)
        command.add_argument("--asset", required=True)
        if name.endswith("download"):
            command.add_argument("--output", required=True)
    command = sub.add_parser("asset-upload")
    command.add_argument("--project", required=True)
    command.add_argument("--name", required=True)
    command.add_argument("--kind", required=True, choices=["character", "scene", "prop", "reference"])
    command.add_argument("--file", required=True)
    command.add_argument("--upstream-asset-id")
    command = sub.add_parser("shots")
    command.add_argument("--project")
    command = sub.add_parser("shot-create")
    command.add_argument("--project", required=True)
    command.add_argument("--name", required=True)
    command.add_argument("--upstream-shot-id")
    command.add_argument("--reference", action="append", default=[])
    command = sub.add_parser("shot-references")
    command.add_argument("--shot", required=True)
    command.add_argument("--asset", action="append", default=[])
    command = sub.add_parser("jobs")
    command.add_argument("--project")
    command.add_argument("--shot")
    command = sub.add_parser("job-submit")
    command.add_argument("--project", required=True)
    command.add_argument("--shot", required=True)
    command.add_argument("--recipe", required=True)
    command.add_argument("--prompt-file", required=True)
    command.add_argument("--seed", type=int, required=True)
    command.add_argument("--reference", action="append", default=[])
    command.add_argument("--request-key", required=True)
    command.add_argument("--allow-generation", action="store_true")
    for name in ("job-get", "job-poll", "job-watch", "job-archive", "job-retry", "job-redo", "result-download"):
        command = sub.add_parser(name)
        command.add_argument("--job", required=True)
        if name in {"job-retry", "job-redo"}:
            command.add_argument("--request-key", required=True)
            command.add_argument("--prompt-file")
            command.add_argument("--seed", type=int)
            command.add_argument("--allow-generation", action="store_true")
        if name == "job-watch":
            command.add_argument("--interval", type=float, default=2)
            command.add_argument("--max-wait", type=float, default=55)
        if name == "result-download":
            command.add_argument("--directory", required=True)
    return parser


def make_client(args):
    config = {}
    if args.config:
        config = json.loads(read_text(args.config))
        if not isinstance(config, dict):
            raise ClientError("invalid_config", "Config must be a JSON object.")
    base_url = args.base_url or os.environ.get("BEEFTV_SPARK_URL") or config.get("base_url")
    if not base_url:
        raise ClientError("missing_base_url", "Set --config, --base-url or BEEFTV_SPARK_URL.")
    state_dir = args.state_dir or config.get("state_dir")
    if state_dir and not args.state_dir and args.config and not Path(state_dir).is_absolute():
        state_dir = str(Path(args.config).resolve().parent / state_dir)
    if args.timeout <= 0 or args.timeout > 120:
        raise ClientError("invalid_timeout", "HTTP timeout must be between 0 and 120 seconds.")
    return Client(base_url, args.timeout, state_dir)


def execute(client, args):
    cmd = args.command
    if cmd == "upstream-bootstrap":
        return client.upstream_scope()
    if cmd == "upstream-projects":
        return client.upstream_call("GET", "/projects")
    if cmd == "upstream-project-create":
        return client.upstream_call("POST", "/projects", {"name": args.name, "type": args.type,
                                    "aspectRatio": args.aspect_ratio, "sourceType": args.source_type,
                                    **optional(description=args.description, stylePresetId=args.style_preset_id)})
    if cmd.startswith("upstream-"):
        project_path = "/projects/" + component(args.project)
        if cmd == "upstream-project-get":
            return client.upstream_call("GET", project_path + "/core")
        if cmd == "upstream-units":
            return client.upstream_call("GET", project_path + "/units")
        if cmd == "upstream-assets":
            if args.page < 1 or not 1 <= args.page_size <= 100:
                raise ClientError("invalid_page", "Use a positive page and page-size between 1 and 100.")
            return client.upstream_call("GET", project_path + "/assets",
                                        query=optional(category=args.category, page=args.page, pageSize=args.page_size))
        if cmd == "upstream-script-import":
            return client.upstream_call("POST", project_path + "/units/import",
                                        {"units": [{"kind": args.kind, "title": args.title, "sourceText": read_text(args.file)}]})
        if cmd == "upstream-shot-create":
            if args.duration_ms < 0 or args.position < 0:
                raise ClientError("invalid_shot", "Shot duration and position must be nonnegative.")
            description = read_text(args.description_file)
            return client.upstream_call("POST", project_path + "/shots",
                                        {"title": args.title, "description": description,
                                         "position": args.position, "durationMs": args.duration_ms,
                                         "revision": {"plotDescription": description},
                                         **optional(unitId=args.unit)})
        if cmd == "upstream-shot-link":
            return client.upstream_call("POST", project_path + "/shots/" + component(args.shot) + "/assets",
                                        {"assetVersionId": args.asset_version, "role": args.role})
        if cmd == "upstream-character-get":
            return client.upstream_call("GET", project_path + "/characters/" + component(args.asset))
    if cmd in {"health", "config", "recipes", "projects"}:
        return client.call("GET", "/" + cmd)
    if cmd == "project-create":
        return client.call("POST", "/projects", {"name": args.name, **optional(upstream_project_id=args.upstream_project_id)})
    if cmd == "script-import":
        return client.call("POST", "/projects/" + component(args.project) + "/script", {"script": read_text(args.file), "format": "text"})
    if cmd in {"assets", "shots", "jobs"}:
        return client.call("GET", "/" + cmd, query=optional(project_id=args.project, kind=getattr(args, "kind", None), shot_id=getattr(args, "shot", None)))
    if cmd == "asset-get":
        return client.call("GET", "/assets/" + component(args.asset))
    if cmd == "asset-download":
        content = download_asset(client, args.asset)
        return {"asset_id": args.asset, "path": save_new(Path(args.output), content)}
    if cmd == "asset-upload":
        path = Path(args.file)
        mime = mimetypes.guess_type(path.name)[0]
        if mime not in {"image/png", "image/jpeg", "image/webp"}:
            raise ClientError("unsupported_image", "Reference upload requires PNG, JPEG or WebP.")
        config = client.call("GET", "/config")
        if path.stat().st_size > config["max_reference_bytes"]:
            raise ClientError("reference_too_large", "Reference exceeds the server upload limit.")
        return client.call("POST", "/assets", {"project_id": args.project, "name": args.name, "kind": args.kind,
                           "mime_type": mime, "data_base64": base64.b64encode(path.read_bytes()).decode("ascii"),
                           **optional(upstream_asset_id=args.upstream_asset_id)})
    if cmd == "shot-create":
        return client.call("POST", "/shots", {"project_id": args.project, "name": args.name,
                           "reference_asset_ids": args.reference, **optional(upstream_shot_id=args.upstream_shot_id)})
    if cmd == "shot-references":
        return client.call("POST", "/shots/" + component(args.shot) + "/references", {"asset_ids": args.asset})
    if cmd == "job-submit":
        client.generation_gate(args.allow_generation, args.recipe)
        return client.mutation("/jobs", {"project_id": args.project, "shot_id": args.shot, "recipe_id": args.recipe,
                               "prompt": read_text(args.prompt_file), "seed": args.seed,
                               "reference_asset_ids": args.reference, "request_key": args.request_key}, cmd)
    job_path = "/jobs/" + component(args.job)
    if cmd == "job-get":
        return client.call("GET", job_path)
    if cmd in {"job-poll", "job-archive"}:
        return client.call("POST", job_path + ("/poll" if cmd == "job-poll" else "/archive"), {})
    if cmd == "job-watch":
        if args.interval < 1 or args.max_wait < 0:
            raise ClientError("invalid_wait", "Watch interval must be at least one second and max-wait nonnegative.")
        deadline = time.monotonic() + args.max_wait
        job = client.call("GET", job_path)
        while job["status"] not in TERMINAL and time.monotonic() < deadline:
            job = client.call("POST", job_path + "/poll", {})
            if job["status"] not in TERMINAL:
                time.sleep(min(args.interval, max(0, deadline - time.monotonic())))
        if job["status"] not in TERMINAL:
            raise ClientError("wait_timeout", "Task remains pending; continue polling the same job.", data=job)
        return job
    if cmd in {"job-retry", "job-redo"}:
        job = client.call("GET", job_path)
        required_status = "failed" if cmd == "job-retry" else "completed"
        if job["status"] != required_status:
            raise ClientError("retry_state_conflict", "Retry needs explicit failed; redo needs explicit completed. Unknown submissions cannot be retried.")
        if args.request_key == job.get("request_key"):
            raise ClientError("retry_key_conflict", "A new attempt needs a new request key.")
        client.generation_gate(args.allow_generation, job["recipe_id"])
        body = {"request_key": args.request_key, **optional(prompt=read_text(args.prompt_file) if args.prompt_file else None, seed=args.seed)}
        return client.mutation(job_path + "/retry", body, cmd)
    if cmd == "result-download":
        job = client.call("GET", job_path)
        if job["status"] != "completed" or not job.get("archived_asset_ids"):
            raise ClientError("result_not_archived", "Complete and archive the job before downloading its result assets.")
        directory = Path(args.directory)
        files = []
        for asset_id in job["archived_asset_ids"]:
            asset = client.call("GET", "/assets/" + component(asset_id))
            suffix = mimetypes.guess_extension(asset.get("mime_type", "")) or ".bin"
            if suffix == ".jpe":
                suffix = ".jpg"
            filename = hashlib.sha256(str(asset_id).encode("utf-8")).hexdigest()[:20] + suffix
            content = download_asset(client, asset_id, asset)
            files.append({"asset_id": asset_id, "path": save_new(directory / filename, content)})
        return {"job_id": args.job, "files": files}
    raise ClientError("unsupported_command", "Unsupported operation.")


def optional(**values):
    return {key: value for key, value in values.items() if value is not None}


def main(argv=None):
    args = build_parser().parse_args(argv)
    try:
        data = execute(make_client(args), args)
        output, code = {"ok": True, "data": data}, 0
    except ClientError as exc:
        output, code = {"ok": False, "reason": exc.reason, "message": exc.message,
                        **optional(data=exc.data, status=exc.status)}, 1
    except (OSError, ValueError, KeyError, TypeError):
        output, code = {"ok": False, "reason": "invalid_local_input", "message": "Check local files, config and API response fields."}, 1
    print(json.dumps(output, ensure_ascii=True))
    return code


if __name__ == "__main__":
    raise SystemExit(main())
