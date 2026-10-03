import copy
import json
import unittest

from model_catalog import CatalogError, ModelCatalog, _recipe_checks, parse_comfy_recipes, parse_rh_llm, parse_rh_standard


STAMP = "2026-10-03T00:00:00Z"


def rh_snapshot():
    return {"version": "example-v1", "total": 3, "endpoints": [
        {"endpoint": "vendor/image-edit", "name_cn": "示例图片编辑", "task": "image-to-image", "output_type": "image",
         "params": [{"key": "image_url", "type": "IMAGE", "required": True, "multiple": True, "maxCount": 2, "maxSizeMB": 10},
                    {"key": "text_prompt", "type": "STRING", "required": False, "maxLength": 1000}]},
        {"endpoint": "vendor/video", "name_en": "Example video", "task": "text-to-video", "output_type": "video",
         "params": [{"key": "text_prompt", "type": "STRING", "required": True},
                    {"key": "duration", "type": "LIST", "required": True, "options": [5, 10], "default": 5}]},
        {"endpoint": "vendor/text", "name_en": "Example text", "task": "text-to-text", "output_type": "string",
         "params": [{"key": "text", "type": "STRING", "required": True}, {"key": "max_tokens", "type": "INT", "required": False, "max": 1000}]}
    ]}


def recipe_fixture(reference=False):
    value = {"id": "registered_example", "name": "Registered example", "mode": "i2v" if reference else "t2i",
             "workflow": {"1": {"class_type": "TextPrompt", "inputs": {"prompt": "private-prompt-placeholder"}},
                          "2": {"class_type": "CheckpointLoader", "inputs": {"ckpt_name": "selected-example.safetensors"}},
                          "3": {"class_type": "Sampler", "inputs": {"seed": 7, "model": ["2", 0], "prompt": ["1", 0]}},
                          "4": {"class_type": "SaveImage", "inputs": {"images": ["3", 0], "filename_prefix": "private-prefix-placeholder"}}},
             "bindings": {"prompt": {"node": "1", "field": "prompt"}, "seed": {"node": "3", "field": "seed"},
                          "references": [], "output_prefix": {"node": "4", "field": "filename_prefix"}},
             "output_nodes": ["4"]}
    if reference:
        value["workflow"]["5"] = {"class_type": "LoadImage", "inputs": {"image": "private-image-placeholder.png"}}
        value["workflow"]["3"]["inputs"]["image"] = ["5", 0]
        value["bindings"]["references"] = [{"node": "5", "field": "image"}]
        value["reference_constraints"] = [{"role": "first_frame", "width": 864, "height": 480, "mime_types": ["image/png"]}]
    return value


def object_info_fixture():
    return {"TextPrompt": {"input": {"required": {"prompt": ["STRING"]}}, "output": ["STRING"], "output_node": False},
            "CheckpointLoader": {"input": {"required": {"ckpt_name": [["selected-example.safetensors", "unregistered-example.safetensors"]]}}, "output": ["MODEL"], "output_node": False},
            "Sampler": {"input": {"required": {"seed": ["INT"], "model": ["MODEL"], "prompt": ["STRING"]}, "optional": {"image": ["IMAGE"]}}, "output": ["IMAGE"], "output_node": False},
            "SaveImage": {"input": {"required": {"images": ["IMAGE"], "filename_prefix": ["STRING"]}}, "output": [], "output_node": True},
            "LoadImage": {"input": {"required": {"image": [["some-uploaded-image.png"]]}}, "output": ["IMAGE"], "output_node": False}}


class RunningHubParserTests(unittest.TestCase):
    def test_string_outputs_are_not_text_or_chat_capabilities(self):
        tasks = ("music-generation", "text-to-speech", "short-play-video", "video-extend", "upload-character", "layer-separation", "text-to-text")
        snapshot = {"version": "example-string-v1", "endpoints": [
            {"endpoint": "vendor/" + task, "name_en": "Result string " + task, "task": task,
             "output_type": "string", "params": [{"key": "prompt", "type": "STRING", "required": True}]}
            for task in tasks
        ]}
        rows = parse_rh_standard(snapshot, fetched_at=STAMP)
        self.assertEqual({row["task"] for row in rows}, set(tasks))
        for row in rows:
            self.assertEqual(row["outputKind"], "string")
            self.assertEqual(row["capability"], "unknown")
            self.assertEqual(row["entryType"], "standard_endpoint")
            self.assertFalse(row["availability"]["callable"])

    def test_standard_types_and_required_inputs(self):
        rows = parse_rh_standard(rh_snapshot(), fetched_at=STAMP)
        image = next(v for v in rows if v["capability"] == "image")
        self.assertTrue(image["needsImage"])
        self.assertFalse(image["needsText"])
        self.assertEqual(image["inputs"][0]["maxCount"], 2)
        self.assertTrue(image["inputs"][0]["multiple"])
        video = next(v for v in rows if v["capability"] == "video")
        self.assertTrue(video["needsText"])
        self.assertFalse(video["needsVideo"])
        self.assertEqual(video["inputs"][1]["options"], [5, 10])
        self.assertNotIn("default", video["inputs"][1])
        for row in rows:
            self.assertFalse(row["ready"])
            self.assertFalse(row["generationEnabled"])
            self.assertFalse(row["billingAuthorized"])
            self.assertFalse(row["gpuVerified"])
            self.assertEqual(row["cost"]["status"], "unknown")
            self.assertEqual(row["availability"]["status"], "account_unknown")

    def test_ids_stable_across_version_order_and_fetched_time(self):
        before = {v["modelId"]: v["id"] for v in parse_rh_standard(rh_snapshot(), fetched_at=STAMP)}
        snapshot = rh_snapshot()
        snapshot["version"] = "example-v2"
        snapshot["endpoints"].reverse()
        after = parse_rh_standard(snapshot, fetched_at="2026-10-04T00:00:00Z")
        self.assertEqual(before, {v["modelId"]: v["id"] for v in after})
        self.assertEqual(after[0]["sourceVersion"], "example-v2")

    def test_empty_contract_and_deprecated_are_not_available(self):
        snapshot = {"version": "sample", "endpoints": [{"endpoint": "vendor/deprecated-model", "name_cn": "示例已下架", "output_type": "video", "params": []}]}
        row = parse_rh_standard(snapshot, fetched_at=STAMP)[0]
        self.assertEqual(row["availability"]["status"], "deprecated")
        self.assertFalse(row["availability"]["callable"])
        self.assertFalse(row["inputRequirementsKnown"])
        self.assertTrue(row["needsContractReview"])
        self.assertIsNone(row["needsImage"])
        self.assertIsNone(row["needsText"])

    def test_snapshot_json_and_bounded_malformed_shapes(self):
        self.assertEqual(len(parse_rh_standard(json.dumps(rh_snapshot()), fetched_at=STAMP)), 3)
        for invalid in (None, [], "not-json", {"endpoints": {}}, {"endpoints": [None]}):
            with self.assertRaises(CatalogError):
                parse_rh_standard(invalid, fetched_at=STAMP)
        snapshot = rh_snapshot()
        snapshot["endpoints"][0]["params"][0]["type"] = []
        with self.assertRaises(CatalogError):
            parse_rh_standard(snapshot, fetched_at=STAMP)

    def test_duplicate_and_community_entries_fail_closed(self):
        snapshot = rh_snapshot()
        snapshot["endpoints"].append(copy.deepcopy(snapshot["endpoints"][0]))
        with self.assertRaises(CatalogError):
            parse_rh_standard(snapshot, fetched_at=STAMP)
        for key in ("webappId", "workflowId", "resourceId", "applicationId"):
            snapshot = rh_snapshot()
            snapshot["endpoints"][0][key] = "community-id"
            with self.assertRaises(CatalogError) as caught:
                parse_rh_standard(snapshot, fetched_at=STAMP)
            self.assertEqual(caught.exception.reason, "nonstandard_directory")

    def test_cost_ignores_unverified_price_and_secret_defaults(self):
        snapshot = rh_snapshot()
        snapshot["endpoints"][0]["price"] = 0
        snapshot["endpoints"][0]["params"][0]["default"] = "not-for-directory"
        rows = parse_rh_standard(snapshot, fetched_at=STAMP)
        self.assertNotIn("not-for-directory", json.dumps(rows))
        self.assertTrue(all(v["cost"]["amount"] is None for v in rows))
        snapshot["endpoints"][0]["params"].append({"key": "api_key", "type": "STRING", "required": True})
        with self.assertRaises(CatalogError):
            parse_rh_standard(snapshot, fetched_at=STAMP)

    def test_llm_preserves_public_metadata_without_guessing_media(self):
        snapshot = {"object": "list", "data": [{"id": "example-video-image-name", "object": "model", "owned_by": "sample",
                    "pricing": {"input_tokens": "0.1", "output_tokens": "0.2", "unit": "per million", "currency": "USD", "apiKey": "never-return"},
                    "capabilities": ["vision", "text"], "apiKey": "never-return"}]}
        row = parse_rh_llm(snapshot, fetched_at=STAMP)[0]
        self.assertEqual(row["capability"], "text")
        self.assertFalse(row["capabilityVerified"])
        self.assertEqual(row["officialPricing"]["input_tokens"], "0.1")
        self.assertEqual(row["officialCapabilities"], ["vision", "text"])
        self.assertNotIn("never-return", json.dumps(row))
        self.assertEqual(row["cost"]["status"], "unknown")
        self.assertIsNone(row["needsImage"])
        self.assertTrue(row["needsContractReview"])

    def test_llm_is_separate_source_and_schema(self):
        llm = parse_rh_llm({"data": [{"id": "vendor/text"}]}, fetched_at=STAMP)[0]
        standard = next(v for v in parse_rh_standard(rh_snapshot(), fetched_at=STAMP) if v["modelId"] == "vendor/text")
        self.assertNotEqual(llm["id"], standard["id"])
        with self.assertRaises(CatalogError):
            parse_rh_llm(rh_snapshot(), fetched_at=STAMP)
        with self.assertRaises(CatalogError):
            parse_rh_llm({"data": [{"id": "same"}, {"id": "same"}]}, fetched_at=STAMP)

    def test_llm_metadata_drops_auth_containers_and_header_keys(self):
        value = {"data": [{"id": "example", "pricing": {"input_tokens": 2, "headers": {"x-api-key": "synthetic-secret-marker"},
                 "x-api-key": "synthetic-secret-marker", "api_keys": ["synthetic-secret-marker"],
                 "request": {"body": "synthetic-secret-marker"}, "config": {"value": "synthetic-secret-marker"}},
                 "capabilities": {"chat": True, "auth": {"bearer": "synthetic-secret-marker"}}}]}
        row = parse_rh_llm(value, fetched_at=STAMP)[0]
        self.assertEqual(row["officialPricing"], {"input_tokens": 2})
        self.assertEqual(row["officialCapabilities"], {"chat": True})
        self.assertNotIn("synthetic-secret-marker", json.dumps(row))

    def test_llm_tiered_public_pricing_retained_with_bounded_depth(self):
        pricing = {"dimensions": {"cache_read": {"tiers": [{"rangeStart": 0, "rangeEnd": None,
                   "pricing": {"tiers": [{"unitPrice": 0.001, "unit": "1K_TOKENS"}]}}]}}, "priceVersion": "example-public-version"}
        row = parse_rh_llm({"data": [{"id": "example", "pricing": pricing}]}, fetched_at=STAMP)[0]
        self.assertEqual(row["officialPricing"], pricing)
        self.assertEqual(row["cost"]["status"], "unknown")
        value = {}
        for _ in range(12):
            value = {"child": value}
        with self.assertRaises(CatalogError):
            parse_rh_llm({"data": [{"id": "example", "pricing": value}]}, fetched_at=STAMP)


class ComfyParserTests(unittest.TestCase):
    def row(self, recipe=None, info=None):
        return parse_comfy_recipes([recipe or recipe_fixture()], object_info_fixture() if info is None else info, fetched_at=STAMP)[0]

    def fixed_parameter(self, value, definition):
        recipe, info = recipe_fixture(), object_info_fixture()
        recipe["workflow"]["3"]["inputs"]["steps"] = value
        info["Sampler"]["input"]["required"]["steps"] = definition
        return recipe, info

    def test_fixed_primitive_types_fail_instead_of_reporting_static_success(self):
        cases = (("INT", [1, 10], ["TEST-not-an-integer", True, 1.5, None, {}]),
                 ("FLOAT", [1, 1.5], ["1.5", True, None, {}]),
                 ("BOOLEAN", [True, False], [0, 1, "true", None, {}]),
                 ("STRING", ["", "valid text"], [1, True, None, {}]))
        for kind, valid, invalid in cases:
            for value in valid + invalid:
                with self.subTest(kind=kind, value=value):
                    recipe, info = self.fixed_parameter(value, [kind])
                    row = self.row(recipe, info)
                    checks = row["staticChecks"]
                    if any(type(value) is type(candidate) and value == candidate for candidate in valid):
                        self.assertEqual(checks["objectInfo"], "passed")
                    else:
                        self.assertEqual(checks["objectInfo"], "failed")
                        self.assertIn("parameter_type_mismatch", [issue["code"] for issue in checks["issues"]])
                        self.assertFalse(row["gpuVerified"])
                    self.assertNotIn("TEST-not-an-integer", json.dumps(row))

    def test_fixed_integer_and_float_ranges_are_inclusive_and_not_ignored(self):
        for kind, minimum, maximum, values in (("INT", 1, 10000, [0, 1, 10000, 10001]), ("FLOAT", 0.1, 2.5, [0.09, 0.1, 2.5, 2.51])):
            for value in values:
                with self.subTest(kind=kind, value=value):
                    recipe, info = self.fixed_parameter(value, [kind, {"min": minimum, "max": maximum}])
                    checks = self.row(recipe, info)["staticChecks"]
                    self.assertEqual(checks["objectInfo"], "passed" if minimum <= value <= maximum else "failed")
                    if not minimum <= value <= maximum:
                        self.assertIn("parameter_out_of_range", [issue["code"] for issue in checks["issues"]])

    def test_unknown_or_malformed_primitive_schema_is_unavailable(self):
        definitions = (["UNKNOWN_CUSTOM_LITERAL"], [None], [{}], ["INT", None], ["INT", []],
                       ["INT", {"min": True}], ["INT", {"min": "1"}], ["FLOAT", {"max": float("inf")}],
                       ["FLOAT", {"min": float("nan")}], ["INT", {"min": 10, "max": 2}],
                       ["STRING", {"min": 0}], ["INT", {}, {}])
        for definition in definitions:
            with self.subTest(definition=definition):
                recipe, info = self.fixed_parameter(2, definition)
                checks = self.row(recipe, info)["staticChecks"]
                self.assertEqual(checks["objectInfo"], "unavailable")
                self.assertTrue(any(issue["code"] in {"literal_type_schema_unavailable", "primitive_schema_unavailable"} for issue in checks["issues"]))

    def test_fixed_floats_must_be_finite(self):
        for value in (float("nan"), float("inf"), -float("inf"), 10 ** 500):
            with self.subTest(value=value):
                recipe, info = self.fixed_parameter(value, ["FLOAT"])
                checks = _recipe_checks(recipe, info)
                self.assertEqual(checks["objectInfo"], "failed")
                self.assertIn("parameter_type_mismatch", [issue["code"] for issue in checks["issues"]])
                if isinstance(value, float):
                    with self.assertRaises(CatalogError):
                        self.row(recipe, info)

    def test_runtime_bound_placeholders_are_not_checked_as_fixed_primitives(self):
        recipe, info = recipe_fixture(True), object_info_fixture()
        recipe["workflow"]["1"]["inputs"]["prompt"] = None
        recipe["workflow"]["3"]["inputs"]["seed"] = "runtime-placeholder"
        recipe["workflow"]["4"]["inputs"]["filename_prefix"] = False
        info["Sampler"]["input"]["required"]["seed"] = ["INT", {"min": 0, "max": 2}]
        self.assertEqual(self.row(recipe, info)["staticChecks"]["objectInfo"], "passed")

    def test_registered_recipes_only_and_hashes_no_private_values(self):
        recipe = recipe_fixture()
        row = self.row(recipe)
        self.assertEqual(row["staticChecks"]["recipe"], "passed")
        self.assertEqual(row["staticChecks"]["objectInfo"], "passed")
        self.assertEqual(row["staticChecks"]["modelChecks"], [{"nodeId": "2", "input": "ckpt_name", "status": "passed"}])
        self.assertEqual(len(row["workflowSha256"]), 64)
        self.assertNotIn("private-", json.dumps(row))
        self.assertNotIn("selected-example.safetensors", json.dumps(row))
        self.assertNotIn("unregistered-example.safetensors", json.dumps(row))
        self.assertEqual(len(parse_comfy_recipes([recipe], object_info_fixture(), fetched_at=STAMP)), 1)
        self.assertFalse(row["ready"])
        self.assertFalse(row["gpuVerified"])

    def test_prompt_changes_hash_not_stable_id(self):
        recipe = recipe_fixture()
        before = self.row(recipe)
        recipe["workflow"]["1"]["inputs"]["prompt"] = "different-private-placeholder"
        after = self.row(recipe)
        self.assertEqual(before["id"], after["id"])
        self.assertNotEqual(before["workflowSha256"], after["workflowSha256"])

    def test_missing_and_malformed_object_info_are_unavailable(self):
        for info in (None, {}, {"TextPrompt": None}):
            row = parse_comfy_recipes([recipe_fixture()], info, fetched_at=STAMP)[0]
            self.assertNotEqual(row["staticChecks"]["objectInfo"], "passed")
            self.assertFalse(row["ready"])
        with self.assertRaises(CatalogError):
            parse_comfy_recipes([recipe_fixture()], [], fetched_at=STAMP)

    def test_missing_class_required_model_and_output_fail(self):
        variants = []
        info = object_info_fixture()
        del info["Sampler"]
        variants.append((recipe_fixture(), info, "missing_class"))
        recipe = recipe_fixture()
        del recipe["workflow"]["3"]["inputs"]["model"]
        variants.append((recipe, object_info_fixture(), "missing_required_input"))
        info = object_info_fixture()
        info["CheckpointLoader"]["input"]["required"]["ckpt_name"] = [[]]
        variants.append((recipe_fixture(), info, "model_not_in_enum"))
        info = object_info_fixture()
        info["CheckpointLoader"]["input"]["required"]["ckpt_name"] = [["other-file.safetensors"]]
        variants.append((recipe_fixture(), info, "model_not_in_enum"))
        info = object_info_fixture()
        info["SaveImage"]["output_node"] = False
        variants.append((recipe_fixture(), info, "not_output_node"))
        for recipe, info, code in variants:
            row = self.row(recipe, info)
            self.assertEqual(row["staticChecks"]["objectInfo"], "failed")
            self.assertIn(code, [v["code"] for v in row["staticChecks"]["issues"]])

    def test_reference_placeholder_and_mutable_literals_are_not_model_enums(self):
        info = object_info_fixture()
        info["TextPrompt"]["input"]["required"]["prompt"] = [["enum-placeholder"]]
        info["Sampler"]["input"]["required"]["seed"] = [[0]]
        info["SaveImage"]["input"]["required"]["filename_prefix"] = [["other-prefix"]]
        row = self.row(recipe_fixture(True), info)
        self.assertEqual(row["staticChecks"]["objectInfo"], "passed")
        self.assertEqual(len(row["staticChecks"]["modelChecks"]), 1)
        frame = row["inputs"][-1]
        self.assertEqual(frame["minimumWidth"], 864)
        self.assertEqual(frame["minimumHeight"], 480)
        self.assertTrue(frame["sameAspect"])
        self.assertEqual(frame["mimeTypes"], ["image/png"])
        self.assertNotIn("exactWidth", frame)
        self.assertTrue(row["needsImage"])
        self.assertEqual(row["supportedReferenceKinds"], ["image"])

    def test_video_audio_refs_and_fixed_media_remain_unsupported(self):
        for kind in ("video", "audio"):
            recipe = recipe_fixture(True)
            recipe["workflow"]["5"]["inputs"] = {kind: "private-media-placeholder"}
            recipe["bindings"]["references"][0]["field"] = kind
            row = self.row(recipe)
            self.assertEqual(row["staticChecks"]["recipe"], "failed")
            self.assertIn("unsupported_video_audio_reference", [v["code"] for v in row["staticChecks"]["issues"]])
            self.assertTrue(row["needs" + kind.title()])
        recipe = recipe_fixture(True)
        recipe["bindings"]["references"] = []
        recipe.pop("reference_constraints")
        row = self.row(recipe)
        self.assertIn("unbound_media_input", [v["code"] for v in row["staticChecks"]["issues"]])

    def test_links_indices_and_malformed_nodes_fail_closed(self):
        for link in (["missing", 0], ["2", 9], ["2", -1], ["2", True]):
            recipe = recipe_fixture()
            recipe["workflow"]["3"]["inputs"]["model"] = link
            self.assertEqual(self.row(recipe)["staticChecks"]["objectInfo"], "failed")
        recipe = recipe_fixture()
        recipe["workflow"]["1"] = None
        self.assertEqual(self.row(recipe)["staticChecks"]["recipe"], "failed")

    def test_invalid_constraints_are_never_projected(self):
        for change in ({"role": "private-prompt-marker"}, {"mime_types": ["G:\\private\\asset.png"]}, {"width": "private-width-marker"}, {"extra": "private-extra-marker"}):
            recipe = recipe_fixture(True)
            recipe["reference_constraints"][0].update(change)
            row = self.row(recipe)
            self.assertEqual(row["staticChecks"]["recipe"], "failed")
            self.assertNotIn("private-", json.dumps(row))
            self.assertNotIn("role", row["inputs"][-1])
            self.assertNotIn("mimeTypes", row["inputs"][-1])

    def test_prompt_binding_cannot_authorize_media_loader(self):
        recipe = recipe_fixture(True)
        recipe["bindings"]["prompt"] = {"node": "5", "field": "image"}
        recipe["bindings"]["references"] = []
        recipe.pop("reference_constraints")
        row = self.row(recipe)
        self.assertEqual(row["staticChecks"]["recipe"], "failed")
        self.assertIn("unbound_media_input", [v["code"] for v in row["staticChecks"]["issues"]])

    def test_malformed_reference_field_returns_failed_dto(self):
        recipe = recipe_fixture(True)
        recipe["bindings"]["references"][0]["field"] = []
        row = self.row(recipe)
        self.assertEqual(row["inputs"][-1]["kind"], "unknown")
        self.assertEqual(row["staticChecks"]["recipe"], "failed")

    def test_link_types_and_non_link_lists_cannot_pass(self):
        for link, code in ((["1", 0], "link_type_mismatch"), (["2"], "invalid_link"), ([2, 0], "invalid_link")):
            recipe = recipe_fixture()
            recipe["workflow"]["3"]["inputs"]["model"] = link
            row = self.row(recipe)
            self.assertEqual(row["staticChecks"]["objectInfo"], "failed")
            self.assertIn(code, [v["code"] for v in row["staticChecks"]["issues"]])


class CatalogCacheTests(unittest.TestCase):
    def setUp(self):
        self.calls, self.now = [], 1000.0
        self.payloads = {"rh.standard": rh_snapshot(), "rh.llm": {"data": [{"id": "example-llm"}]}, "comfy.recipes": object_info_fixture()}

        def read(source):
            self.calls.append(source)
            payload = self.payloads[source]
            if isinstance(payload, Exception):
                raise payload
            return copy.deepcopy(payload)
        self.catalog = ModelCatalog(read, registered_recipes=[recipe_fixture()], clock=lambda: self.now, ttl_seconds=60)

    def test_query_never_reads_and_refresh_is_explicit(self):
        self.assertEqual(self.catalog.query("rh.standard")["cacheStatus"], "empty")
        self.assertEqual(self.calls, [])
        self.catalog.refresh("rh.standard")
        self.assertEqual(self.calls, ["rh.standard"])
        self.assertEqual(self.catalog.query("rh.standard")["cacheStatus"], "fresh")
        self.now += 61
        result = self.catalog.query("rh.standard")
        self.assertEqual(result["cacheStatus"], "stale")
        self.assertTrue(all(v["cacheStatus"] == "stale" for v in result["items"]))
        self.assertEqual(self.calls, ["rh.standard"])

    def test_refresh_failure_preserves_last_snapshot_and_safe_error(self):
        before = self.catalog.refresh("rh.standard")
        self.now += 3
        self.payloads["rh.standard"] = RuntimeError("synthetic-private-value-do-not-return")
        after = self.catalog.refresh("rh.standard")
        self.assertEqual(after["cacheStatus"], "stale")
        self.assertEqual(after["fetchedAt"], before["fetchedAt"])
        self.assertEqual(after["sourceVersion"], before["sourceVersion"])
        self.assertEqual(after["lastError"], "read_failed")
        self.assertEqual(after["total"], 3)
        self.assertNotIn("synthetic-private", json.dumps(after))
        self.payloads["rh.standard"] = {"endpoints": "bad-shape"}
        self.assertEqual(self.catalog.refresh("rh.standard")["lastError"], "invalid_snapshot")
        self.payloads["rh.standard"] = rh_snapshot()
        refreshed = self.catalog.refresh("rh.standard")
        self.assertEqual(refreshed["cacheStatus"], "fresh")
        self.assertIsNone(refreshed["lastError"])

    def test_pagination_search_types_and_separate_sources(self):
        self.catalog.refresh("rh.standard")
        first = self.catalog.query("rh.standard", page_size=2)
        second = self.catalog.query("rh.standard", page=2, page_size=2)
        self.assertEqual(len(first["items"]), 2)
        self.assertTrue(first["hasMore"])
        self.assertEqual(len(second["items"]), 1)
        self.assertFalse(second["hasMore"])
        self.assertEqual(len(self.catalog.query("rh.standard", search="图片")["items"]), 1)
        self.assertEqual(self.catalog.query("rh.standard", capability="video", task="text-to-video")["total"], 1)
        self.catalog.refresh("rh.llm")
        self.assertEqual(self.catalog.query("rh.llm")["total"], 1)
        self.assertEqual(self.catalog.query("rh.standard")["total"], 3)
        self.catalog.refresh("comfy.recipes")
        self.assertEqual(self.catalog.query("comfy.recipes")["total"], 1)
        self.assertEqual(self.calls, ["rh.standard", "rh.llm", "comfy.recipes"])

    def test_unregistered_sources_filters_and_pages_are_rejected(self):
        for source in ("rh.apps", "rh.workflows", "rh.resources", "https://remote.invalid", "../snapshot"):
            with self.assertRaises(CatalogError):
                self.catalog.refresh(source)
        for options in ({"page": 0}, {"page": True}, {"page_size": 201}, {"page_size": 0}, {"search": []}, {"capability": "all"}, {"capability": []}, {"capability": {}}):
            with self.assertRaises(CatalogError):
                self.catalog.query("rh.standard", **options)
        self.assertEqual(self.calls, [])

    def test_return_values_do_not_mutate_cached_snapshot(self):
        result = self.catalog.refresh("rh.standard")
        result["items"][0]["name"] = "caller-change"
        result["items"][0]["cost"]["amount"] = 0
        reread = self.catalog.query("rh.standard")
        self.assertNotEqual(reread["items"][0]["name"], "caller-change")
        self.assertIsNone(reread["items"][0]["cost"]["amount"])

    def test_empty_official_snapshot_can_be_fresh(self):
        self.payloads["rh.llm"] = {"data": []}
        result = self.catalog.refresh("rh.llm")
        self.assertEqual(result["total"], 0)
        self.assertEqual(result["cacheStatus"], "fresh")
        self.assertIsNotNone(result["fetchedAt"])


if __name__ == "__main__":
    unittest.main()
