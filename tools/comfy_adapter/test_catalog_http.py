"""Read-only directory HTTP tests. Temporary loopback mocks, never a GPU/cloud job."""
import copy
import io
import json
import os
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib import error, request

from server import Adapter, ApiError, MAX_CATALOG_BYTES, NoRedirect, PREFIX, PUBLIC_CATALOG_URLS, RH_STANDARD_FALLBACK_URL, make_server, read_public_catalog
from model_catalog import CatalogError, parse_rh_standard
from test_model_catalog import object_info_fixture, recipe_fixture, rh_snapshot


class DirectoryClient:
    def __init__(self):
        self.paths = []
        self.info = object_info_fixture()

    def json(self, path, payload=None):
        self.paths.append(path)
        if payload is not None or not path.startswith("/object_info/"):
            raise AssertionError("A directory must only read node schemas")
        name = path.removeprefix("/object_info/")
        return {name: copy.deepcopy(self.info[name])} if name in self.info else {}


class CatalogHttpTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.client = DirectoryClient()
        self.reads, self.instant = [], 1_800_000_000
        self.failure = False

        def reader(source):
            self.reads.append(source)
            if self.failure:
                raise RuntimeError("TEST-secret-value and private path must never be exposed")
            return self.adapter.read_catalog(source) if source == "comfy.recipes" else rh_snapshot() if source == "rh.standard" else {"data": [{"id": "example-text"}]}

        self.adapter = Adapter(self.temp.name, self.client, {"registered_example": recipe_fixture(True)}, enabled=False,
                               catalog_reader=reader, catalog_clock=lambda: self.instant)
        self.server = make_server(self.adapter, port=0)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = "http://127.0.0.1:" + str(self.server.server_port)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.adapter.close()
        self.temp.cleanup()

    def call(self, path, body=None, origin=None):
        headers = {"Content-Type": "application/json"}
        if origin:
            headers["Origin"] = origin
        req = request.Request(self.base + PREFIX + path, data=json.dumps(body).encode() if body is not None else None, headers=headers)
        try:
            with request.urlopen(req, timeout=3) as response:
                return response.status, json.load(response)
        except error.HTTPError as exc:
            with exc:
                return exc.code, json.load(exc)

    def test_query_is_cache_only_including_stale_queries(self):
        status, reply = self.call("/model-catalog?source=rh.standard")
        self.assertEqual(status, 200)
        self.assertEqual(reply["data"]["cacheStatus"], "empty")
        self.assertEqual(self.reads, [])
        self.call("/model-catalog/refresh", {"source": "rh.standard"})
        self.instant += 601
        status, reply = self.call("/model-catalog?source=rh.standard&capability=image&search=vendor&page_size=1")
        self.assertEqual(status, 200)
        self.assertEqual(reply["data"]["total"], 1)
        self.assertEqual(reply["data"]["cacheStatus"], "stale")
        self.assertEqual(self.reads, ["rh.standard"])

    def test_registered_workflows_only_no_values_no_gpu_no_database_writes(self):
        before = self.adapter.db.execute("SELECT count(*) FROM objects").fetchone()[0]
        status, reply = self.call("/model-catalog/refresh", {"source": "comfy.recipes"})
        data = reply["data"]
        self.assertEqual(status, 200)
        self.assertTrue(data["readOnly"])
        self.assertNotIn("prototypeOnly", data)
        self.assertFalse(data["generationEnabled"])
        self.assertEqual(data["total"], 1)
        row = data["items"][0]
        self.assertEqual(row["staticChecks"]["objectInfo"], "passed")
        self.assertFalse(row["gpuVerified"])
        self.assertFalse(row["availability"]["callable"])
        self.assertTrue(row["inputs"][2]["sameAspect"])
        self.assertEqual(row["inputs"][2]["minimumWidth"], 864)
        encoded = json.dumps(data)
        for value in ("private-prompt-placeholder", "selected-example.safetensors", "unregistered-example.safetensors", "private-image-placeholder"):
            self.assertNotIn(value, encoded)
        self.assertEqual(set(self.client.paths), {"/object_info/" + key for key in object_info_fixture()})
        self.assertEqual(self.adapter.db.execute("SELECT count(*) FROM objects").fetchone()[0], before)
        self.assertEqual(self.adapter.db.execute("PRAGMA user_version").fetchone()[0], 1)

    def test_refresh_error_retains_cache_and_redacts_detail(self):
        self.call("/model-catalog/refresh", {"source": "rh.standard"})
        self.failure = True
        status, reply = self.call("/model-catalog/refresh", {"source": "rh.standard"})
        self.assertEqual(status, 200)
        self.assertEqual(reply["data"]["cacheStatus"], "stale")
        self.assertEqual(reply["data"]["lastError"], "read_failed")
        self.assertEqual(reply["data"]["total"], 3)
        self.assertNotIn("TEST-secret", json.dumps(reply))

    def test_only_selected_registered_class_schemas_are_read(self):
        self.client.info.pop("CheckpointLoader")
        status, reply = self.call("/model-catalog/refresh", {"source": "comfy.recipes"})
        self.assertEqual(status, 200)
        self.assertEqual(reply["data"]["items"][0]["staticChecks"]["objectInfo"], "failed")
        self.assertEqual(reply["data"]["items"][0]["staticChecks"]["issues"][0]["code"], "missing_class")
        self.assertTrue(all(path.startswith("/object_info/") for path in self.client.paths))

    def test_comfy_class_count_size_and_read_deadline_are_bounded(self):
        original = copy.deepcopy(self.adapter.recipes)
        self.adapter.recipes = {"budget": {"workflow": {str(index): {"class_type": "Class" + str(index)} for index in range(129)}}}
        with self.assertRaises(ValueError):
            self.adapter.read_catalog("comfy.recipes")
        self.assertEqual(self.client.paths, [])
        self.adapter.recipes = original
        with patch("server.time.monotonic", side_effect=[0, 26]):
            with self.assertRaises(ValueError):
                self.adapter.read_catalog("comfy.recipes")
        self.assertEqual(self.client.paths, [])
        self.client.info["CheckpointLoader"]["extra"] = "x" * MAX_CATALOG_BYTES
        with self.assertRaises(ValueError):
            self.adapter.read_catalog("comfy.recipes")

    def test_comfy_missing_class_http_404_is_a_static_failure_not_an_error_body(self):
        original = self.client.json

        def read(path, payload=None):
            if path == "/object_info/CheckpointLoader":
                raise error.HTTPError("http://example.invalid/private-path", 404, "private-error", {}, None)
            return original(path, payload)

        self.client.json = read
        _, reply = self.call("/model-catalog/refresh", {"source": "comfy.recipes"})
        self.assertIsNone(reply["data"]["lastError"])
        self.assertEqual(reply["data"]["items"][0]["staticChecks"]["objectInfo"], "failed")
        self.assertNotIn("private-path", json.dumps(reply))

    def test_invalid_snapshot_empty_and_failure_are_distinct(self):
        self.adapter.catalog._read = lambda _: {"endpoints": "invalid"}
        status, reply = self.call("/model-catalog/refresh", {"source": "rh.standard"})
        self.assertEqual(status, 200)
        self.assertEqual(reply["data"]["cacheStatus"], "empty")
        self.assertEqual(reply["data"]["lastError"], "invalid_snapshot")

    def test_origin_and_parameters_do_not_allow_arbitrary_urls_or_keys(self):
        for path, body, origin in [
            ("/model-catalog/refresh", {"source": "rh.standard"}, "https://untrusted.invalid"),
            ("/model-catalog/refresh", {"source": "rh.standard", "apiKey": "TEST-value"}, None),
            ("/model-catalog/refresh", {"source": "https://untrusted.invalid"}, None),
            ("/model-catalog?source=rh.standard&url=https://untrusted.invalid", None, None),
            ("/model-catalog?source=rh.standard&page=0", None, None),
            ("/model-catalog?source=rh.standard&page_size=201", None, None),
            ("/model-catalog?source=rh.standard&capability=vision-guessed", None, None),
            ("/model-catalog/refresh?source=rh.standard", {"source": "rh.standard"}, None),
        ]:
            self.assertIn(self.call(path, body, origin)[0], (400, 403))
        self.assertEqual(self.reads, [])

    def test_refresh_does_not_hold_jobs_lock_or_duplicate_source_refresh(self):
        entered, finish = threading.Event(), threading.Event()

        def blocked(_):
            entered.set()
            finish.wait(3)
            return {"data": [{"id": "example-text"}]}

        self.adapter.catalog._read = blocked
        worker = threading.Thread(target=lambda: self.adapter.dispatch("POST", "/model-catalog/refresh", body={"source": "rh.llm"}))
        worker.start()
        try:
            self.assertTrue(entered.wait(1))
            self.assertEqual(self.call("/config")[0], 200)
            self.assertEqual(self.call("/model-catalog?source=rh.llm")[0], 200)
            self.assertEqual(self.call("/model-catalog/refresh", {"source": "rh.llm"})[0], 409)
        finally:
            finish.set()
            worker.join(3)


class PublicReaderTests(unittest.TestCase):
    def response(self, payload=b"{}", *, size=None, url=None):
        value = io.BytesIO(payload)
        value.headers = {} if size is None else {"Content-Length": str(size)}
        value.geturl = lambda: url or PUBLIC_CATALOG_URLS["rh.llm"]
        return value

    def test_fixed_https_get_has_no_auth_cookie_proxy_environment_or_redirect(self):
        with patch("server.request.build_opener") as build:
            build.return_value.open.return_value = self.response()
            self.assertEqual(read_public_catalog("rh.llm"), b"{}")
            handlers = build.call_args.args
            self.assertIsInstance(handlers[0], request.ProxyHandler)
            self.assertEqual(handlers[0].proxies, {})
            self.assertIsInstance(handlers[1], NoRedirect)
            req = build.return_value.open.call_args.args[0]
            self.assertEqual(req.full_url, PUBLIC_CATALOG_URLS["rh.llm"])
            self.assertEqual(req.get_method(), "GET")
            self.assertIsNone(req.data)
            self.assertNotIn("authorization", {key.lower() for key, _ in req.header_items()})
            self.assertNotIn("cookie", {key.lower() for key, _ in req.header_items()})
            self.assertIsNone(NoRedirect().redirect_request(req, None, 302, "redirect", {}, "https://untrusted.invalid"))
            with self.assertRaises(ValueError):
                read_public_catalog("https://untrusted.invalid")
            self.assertEqual(build.call_count, 1)

    def test_size_mismatch_large_response_and_final_url_are_rejected(self):
        for response in (self.response(size=MAX_CATALOG_BYTES + 1), self.response(b"x" * (MAX_CATALOG_BYTES + 1)),
                         self.response(size=3), self.response(url="https://untrusted.invalid")):
            with patch("server.request.build_opener") as build:
                build.return_value.open.return_value = response
                with self.assertRaises(ValueError):
                    read_public_catalog("rh.llm")

    def test_standard_primary_success_preserves_bytes_without_fallback(self):
        payload = json.dumps(rh_snapshot()).encode()
        with patch("server.request.build_opener") as build:
            response = self.response(payload, url=PUBLIC_CATALOG_URLS["rh.standard"])
            build.return_value.open.return_value = response
            self.assertEqual(read_public_catalog("rh.standard"), payload)
            self.assertEqual(build.return_value.open.call_count, 1)
            self.assertTrue(response.closed)

    def test_standard_transport_failure_uses_fixed_official_raw_rest_once(self):
        payload = json.dumps(rh_snapshot()).encode()
        failures = (error.URLError(ConnectionResetError(104, "TEST-transport")),
                    OSError("TEST-transport"),
                    error.HTTPError(PUBLIC_CATALOG_URLS["rh.standard"], 503, "TEST-transport", {}, None))
        for failure in failures:
            with self.subTest(failure=type(failure).__name__), patch("server.request.build_opener") as build:
                build.return_value.open.side_effect = [failure, self.response(payload, url=RH_STANDARD_FALLBACK_URL)]
                self.assertEqual(read_public_catalog("rh.standard"), payload)
                calls = build.return_value.open.call_args_list
                self.assertEqual(len(calls), 2)
                self.assertEqual([call.args[0].full_url for call in calls],
                                 [PUBLIC_CATALOG_URLS["rh.standard"], RH_STANDARD_FALLBACK_URL])
                self.assertTrue(all(call.kwargs == {"timeout": 15} for call in calls))
                req = calls[1].args[0]
                self.assertEqual(req.get_method(), "GET")
                self.assertIsNone(req.data)
                self.assertEqual({key.lower(): value for key, value in req.header_items()}, {
                    "accept": "application/vnd.github.raw+json", "accept-encoding": "identity",
                    "user-agent": "BeefTV-read-only-catalog"})

    def test_standard_body_transport_failure_closes_response_and_falls_back_once(self):
        class InterruptedResponse(io.BytesIO):
            def read(self, _):
                raise OSError("TEST-interrupted-read")

        broken = InterruptedResponse()
        broken.headers = {}
        broken.geturl = lambda: PUBLIC_CATALOG_URLS["rh.standard"]
        with patch("server.request.build_opener") as build:
            build.return_value.open.side_effect = [broken, self.response(b"{}", url=RH_STANDARD_FALLBACK_URL)]
            self.assertEqual(read_public_catalog("rh.standard"), b"{}")
            self.assertEqual(build.return_value.open.call_count, 2)
            self.assertTrue(broken.closed)

    def test_standard_validation_and_redirect_failures_never_fall_back(self):
        primary = PUBLIC_CATALOG_URLS["rh.standard"]
        invalid = (self.response(size=MAX_CATALOG_BYTES + 1, url=primary),
                   self.response(b"x" * (MAX_CATALOG_BYTES + 1), url=primary),
                   self.response(size=3, url=primary), self.response(size="invalid", url=primary),
                   self.response(url="https://untrusted.invalid"))
        for response in invalid:
            with self.subTest(headers=response.headers), patch("server.request.build_opener") as build:
                build.return_value.open.return_value = response
                with self.assertRaises(ValueError):
                    read_public_catalog("rh.standard")
                self.assertEqual(build.return_value.open.call_count, 1)
                self.assertTrue(response.closed)
        for code in (300, 301, 302, 303, 307, 308):
            with self.subTest(code=code), patch("server.request.build_opener") as build:
                build.return_value.open.side_effect = error.HTTPError(primary, code, "TEST-redirect", {}, None)
                with self.assertRaisesRegex(ValueError, "^catalog_redirect_not_allowed$"):
                    read_public_catalog("rh.standard")
                self.assertEqual(build.return_value.open.call_count, 1)

    def test_standard_http_client_failures_never_fall_back(self):
        primary = PUBLIC_CATALOG_URLS["rh.standard"]
        for code in (400, 401, 403, 404, 408, 409, 422, 429, 499):
            with self.subTest(code=code), patch("server.request.build_opener") as build:
                build.return_value.open.side_effect = error.HTTPError(primary, code, "TEST-client-error", {}, None)
                with self.assertRaisesRegex(ValueError, "^catalog_read_failed$"):
                    read_public_catalog("rh.standard")
                self.assertEqual(build.return_value.open.call_count, 1)

    def test_standard_malformed_content_is_rejected_by_parser_without_retry(self):
        for payload in (b"not-json", b"\xff", b'{"endpoints":"invalid"}'):
            with self.subTest(payload=payload), patch("server.request.build_opener") as build:
                build.return_value.open.return_value = self.response(payload, url=PUBLIC_CATALOG_URLS["rh.standard"])
                raw = read_public_catalog("rh.standard")
                self.assertEqual(raw, payload)
                with self.assertRaises(CatalogError):
                    parse_rh_standard(raw, fetched_at="2026-10-03T00:00:00Z")
                self.assertEqual(build.return_value.open.call_count, 1)

    def test_fallback_validation_and_transport_failure_have_no_third_attempt(self):
        failures = (OSError("TEST-last"), error.URLError("TEST-last"),
                    error.HTTPError(RH_STANDARD_FALLBACK_URL, 500, "TEST-last", {}, None),
                    error.HTTPError(RH_STANDARD_FALLBACK_URL, 302, "TEST-redirect", {}, None))
        for failure in failures:
            with self.subTest(failure=type(failure).__name__), patch("server.request.build_opener") as build:
                build.return_value.open.side_effect = [error.URLError("TEST-first"), failure]
                reason = "catalog_redirect_not_allowed" if isinstance(failure, error.HTTPError) and failure.code == 302 else "catalog_read_failed"
                with self.assertRaisesRegex(ValueError, "^" + reason + "$"):
                    read_public_catalog("rh.standard")
                self.assertEqual(build.return_value.open.call_count, 2)
        for response in (self.response(size=MAX_CATALOG_BYTES + 1, url=RH_STANDARD_FALLBACK_URL),
                         self.response(url="https://untrusted.invalid")):
            with patch("server.request.build_opener") as build:
                build.return_value.open.side_effect = [error.URLError("TEST-first"), response]
                with self.assertRaises(ValueError):
                    read_public_catalog("rh.standard")
                self.assertEqual(build.return_value.open.call_count, 2)

    def test_fallback_does_not_copy_environment_credentials_proxy_or_client_targets(self):
        environment = {"HTTP_PROXY": "http://untrusted.invalid", "HTTPS_PROXY": "http://untrusted.invalid",
                       "RUNNINGHUB_API_KEY": "TEST-never-forward", "GITHUB_TOKEN": "TEST-never-forward"}
        with patch.dict(os.environ, environment), patch("server.request.build_opener") as build:
            build.return_value.open.side_effect = [error.URLError("TEST-first"), self.response(url=RH_STANDARD_FALLBACK_URL)]
            read_public_catalog("rh.standard")
            self.assertEqual(build.call_args.args[0].proxies, {})
            self.assertIsInstance(build.call_args.args[1], NoRedirect)
            self.assertEqual(len(build.call_args.args), 2)
            for call in build.return_value.open.call_args_list:
                headers = {key.lower(): value for key, value in call.args[0].header_items()}
                self.assertTrue(set(headers) <= {"accept", "accept-encoding", "user-agent"})
                self.assertNotIn("TEST-never-forward", headers.values())
            for source in (RH_STANDARD_FALLBACK_URL, "rh.standard?url=https://untrusted.invalid", "comfy.recipes"):
                with self.assertRaisesRegex(ValueError, "^unsupported_source$"):
                    read_public_catalog(source)
            self.assertEqual(build.return_value.open.call_count, 2)

    def test_llm_transport_failure_still_has_only_one_attempt(self):
        with patch("server.request.build_opener") as build:
            build.return_value.open.side_effect = error.URLError("TEST-unavailable")
            with self.assertRaisesRegex(ValueError, "^catalog_read_failed$"):
                read_public_catalog("rh.llm")
            self.assertEqual(build.return_value.open.call_count, 1)


if __name__ == "__main__":
    unittest.main()
