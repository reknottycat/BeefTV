"""Pure directory parsing and cache. No credentials, I/O or jobs.

The caller supplies public directory snapshots and already registered recipes.
``ModelCatalog.refresh`` only invokes an injected read function with a fixed
source token; ``query`` never reads implicitly. Static checks do not authorize
billing, enable a recipe or prove GPU execution.
"""

import copy
import datetime as dt
import hashlib
import json
import math
import re
import time


SOURCES = ("rh.standard", "rh.llm", "comfy.recipes")
MAX_SNAPSHOT_BYTES = 16 << 20
MAX_ENTRIES = 10000
CAPABILITIES = {"text", "image", "video", "audio", "3d", "unknown"}
MODEL_FIELDS = {"ckpt_name", "unet_name", "clip_name", "vae_name", "lora_name", "model_name", "diffusion_model", "text_encoder"}
_UNKNOWN_COST = {"status": "unknown", "amount": None, "currency": None}


def _secret_key(name):
    normalized = re.sub(r"[^a-z0-9]", "", name.lower())
    return normalized in {"apikey", "apikeys", "xapikey", "secretkey", "token", "accesstoken", "refreshtoken", "authtoken", "secret", "password", "authorization", "credential", "credentials", "cookie", "cookies", "account", "accountid"}


def _valid_reference_constraint(value):
    return (isinstance(value, dict) and set(value) == {"role", "width", "height", "mime_types"}
            and value.get("role") == "first_frame" and value.get("mime_types") == ["image/png"]
            and all(type(value.get(k)) is int and 0 < value[k] <= 32768 for k in ("width", "height")))


class CatalogError(ValueError):
    def __init__(self, reason):
        self.reason = reason
        super().__init__(reason)


def _object(value):
    if isinstance(value, (str, bytes)):
        if len(value.encode("utf-8") if isinstance(value, str) else value) > MAX_SNAPSHOT_BYTES:
            raise CatalogError("snapshot_too_large")
        try:
            value = json.loads(value)
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise CatalogError("invalid_snapshot") from None
    if not isinstance(value, dict):
        raise CatalogError("invalid_snapshot")
    return value


def _digest(value):
    try:
        encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
    except (TypeError, ValueError):
        raise CatalogError("invalid_snapshot") from None
    if len(encoded) > MAX_SNAPSHOT_BYTES:
        raise CatalogError("snapshot_too_large")
    return hashlib.sha256(encoded).hexdigest()


def _text(value, maximum=500, required=False):
    if not isinstance(value, str) or len(value) > maximum or any(ord(c) < 32 for c in value):
        if required:
            raise CatalogError("invalid_snapshot")
        return ""
    value = value.strip()
    if required and not value:
        raise CatalogError("invalid_snapshot")
    return value


def _rows(value):
    if not isinstance(value, list) or len(value) > MAX_ENTRIES or any(not isinstance(v, dict) for v in value):
        raise CatalogError("invalid_snapshot")
    return value


def _base(source, model_id, name, version, fetched_at, capability):
    return {"id": source.replace(".", "-") + "-" + hashlib.sha256(model_id.encode()).hexdigest()[:24],
            "modelId": model_id, "name": name, "source": source, "sourceVersion": version,
            "fetchedAt": _text(fetched_at, 80, required=True), "capability": capability,
            "cost": copy.deepcopy(_UNKNOWN_COST), "billingAuthorized": False,
            "generationEnabled": False, "gpuVerified": False, "ready": False,
            "availability": {"status": "account_unknown", "callable": False, "accountVerified": False}}


def _requirements(parameters):
    if not isinstance(parameters, list) or len(parameters) > 128:
        raise CatalogError("invalid_snapshot")
    result, seen = [], set()
    types = {"IMAGE": "image", "VIDEO": "video", "AUDIO": "audio", "STRING": "string",
             "INT": "integer", "FLOAT": "number", "BOOLEAN": "boolean", "LIST": "enum", "SIZE": "size"}
    for parameter in parameters:
        if not isinstance(parameter, dict):
            raise CatalogError("invalid_snapshot")
        name = _text(parameter.get("key"), 120, required=True)
        if name in seen or _secret_key(name):
            raise CatalogError("invalid_snapshot")
        seen.add(name)
        required = parameter.get("required", False)
        multiple = parameter.get("multiple", False)
        if type(required) is not bool or type(multiple) is not bool:
            raise CatalogError("invalid_snapshot")
        raw_type = parameter.get("type")
        if not isinstance(raw_type, str):
            raise CatalogError("invalid_snapshot")
        item = {"name": name, "kind": types.get(raw_type, "unknown"),
                "required": required, "multiple": multiple}
        for field in ("min", "max", "maxCount", "maxLength", "maxSizeMB"):
            value = parameter.get(field)
            if value is not None:
                if type(value) not in (int, float) or not math.isfinite(value):
                    raise CatalogError("invalid_snapshot")
                item[field] = value
        options = parameter.get("options")
        if options is not None:
            if not isinstance(options, list) or len(options) > 500 or any(type(v) not in (str, int, float, bool) for v in options):
                raise CatalogError("invalid_snapshot")
            item["options"] = copy.deepcopy(options)
        # Defaults can contain operator-specific values; this directory DTO
        # exposes requirements/options only, never credential or payload values.
        result.append(item)
    return result


def _needs(inputs, known=True):
    return {"needs" + kind.title(): any((v.get("kind") == kind or (kind == "text" and v.get("kind") == "string" and re.search(r"prompt|text", v.get("name", ""), re.I))) and v.get("required") is True for v in inputs) if known else None
            for kind in ("text", "image", "video", "audio")}


def _public_metadata(value, depth=0):
    """Bounded public pricing/capability metadata, never auth/account objects."""
    if depth > 10:
        raise CatalogError("invalid_snapshot")
    if value is None or type(value) in (bool, int, float):
        if type(value) is float and not math.isfinite(value):
            raise CatalogError("invalid_snapshot")
        return value
    if isinstance(value, str):
        if len(value) > 500 or any(ord(c) < 32 for c in value):
            raise CatalogError("invalid_snapshot")
        return value
    if isinstance(value, list) and len(value) <= 200:
        return [_public_metadata(v, depth + 1) for v in value]
    if isinstance(value, dict) and len(value) <= 100:
        result = {}
        for key, child in value.items():
            key = _text(key, 120, required=True)
            normalized = re.sub(r"[^a-z0-9]", "", key.lower())
            if _secret_key(key) or normalized in {"headers", "auth", "authentication", "request", "requests", "config", "configuration", "default", "defaults", "accounts"}:
                continue
            result[key] = _public_metadata(child, depth + 1)
        return result
    raise CatalogError("invalid_snapshot")


def _availability(item):
    if re.search(r"deprecated|已下架|已弃用|停用|下线", item["modelId"] + " " + item["name"], re.I):
        item["availability"] = {"status": "deprecated", "callable": False, "accountVerified": False}


def parse_rh_standard(snapshot, *, fetched_at):
    """Parse the official capabilities.json endpoints, not apps/workflows."""
    payload = _object(snapshot)
    entries = _rows(payload.get("endpoints"))
    content_hash = _digest(payload)
    version = _text(payload.get("version"), 120) or "sha256:" + content_hash
    result, seen = [], set()
    for entry in entries:
        if any(key in entry for key in ("webappId", "workflowId", "resourceId", "applicationId")):
            raise CatalogError("nonstandard_directory")
        model_id = _text(entry.get("endpoint"), 500, required=True)
        if model_id in seen or "?" in model_id or "://" in model_id or "\\" in model_id:
            raise CatalogError("invalid_snapshot")
        seen.add(model_id)
        output = entry.get("output_type")
        if not isinstance(output, str):
            raise CatalogError("invalid_snapshot")
        # A string may be a media URL or an operation result, not a chat model.
        capability = output if output in CAPABILITIES else "unknown"
        item = _base("rh.standard", model_id, _text(entry.get("name_cn")) or _text(entry.get("name_en")) or model_id,
                     version, fetched_at, capability)
        inputs = _requirements(entry.get("params", []))
        item.update({"snapshotSha256": content_hash, "entryType": "standard_endpoint", "task": _text(entry.get("task")),
                     "inputs": inputs, "inputRequirementsKnown": bool(inputs), "needsContractReview": not bool(inputs),
                     "outputKind": output, "directoryVerified": True})
        item.update(_needs(item["inputs"], known=bool(inputs)))
        _availability(item)
        result.append(item)
    return sorted(result, key=lambda v: v["modelId"])


def parse_rh_llm(snapshot, *, fetched_at):
    """Parse only /v1/models data[].id; names prove no media capability."""
    payload = _object(snapshot)
    rows = _rows(payload.get("data"))
    content_hash = _digest(payload)
    result, seen = [], set()
    for entry in rows:
        model_id = _text(entry.get("id"), 500, required=True)
        if model_id in seen:
            raise CatalogError("invalid_snapshot")
        seen.add(model_id)
        item = _base("rh.llm", model_id, model_id, "sha256:" + content_hash, fetched_at, "text")
        item.update({"snapshotSha256": content_hash, "entryType": "llm_directory_model", "task": "",
                     "inputs": [], "inputRequirementsKnown": False, "outputKind": "text",
                     "directoryVerified": True, "capabilityVerified": False, "needsContractReview": True})
        for field, target in (("pricing", "officialPricing"), ("capabilities", "officialCapabilities")):
            if field in entry:
                item[target] = _public_metadata(entry[field])
        item.update(_needs([], known=False))
        _availability(item)
        result.append(item)
    return sorted(result, key=lambda v: v["modelId"])


def _issue(issues, code, node_id=None, field=None):
    value = {"code": code}
    if node_id is not None:
        value["nodeId"] = str(node_id)
    if field is not None:
        value["input"] = str(field)
    issues.append(value)


def _finite_number(value):
    if type(value) not in (int, float):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def _primitive_issue(value, definition):
    """Check fixed literals only. Node links and runtime bindings are separate."""
    kind = definition[0]
    if not isinstance(kind, str) or kind not in {"INT", "FLOAT", "BOOLEAN", "STRING"}:
        return "literal_type_schema_unavailable", False
    options = definition[1] if len(definition) > 1 else {}
    if len(definition) > 2 or not isinstance(options, dict):
        return "primitive_schema_unavailable", False
    bounds = {key: options[key] for key in ("min", "max") if key in options}
    if bounds and (kind not in {"INT", "FLOAT"} or any(not _finite_number(bound) for bound in bounds.values())
                   or ("min" in bounds and "max" in bounds and bounds["min"] > bounds["max"])):
        return "primitive_schema_unavailable", False
    valid_type = (type(value) is int if kind == "INT" else _finite_number(value) if kind == "FLOAT"
                  else type(value) is bool if kind == "BOOLEAN" else isinstance(value, str))
    if not valid_type:
        return "parameter_type_mismatch", True
    if ("min" in bounds and value < bounds["min"]) or ("max" in bounds and value > bounds["max"]):
        return "parameter_out_of_range", True
    return None, False


def _enum_options(definition):
    """Recognize classic enums and the observed single-select V3 COMBO."""
    if len(definition) > 2 or (len(definition) == 2 and not isinstance(definition[1], dict)):
        return None
    if isinstance(definition[0], list):
        values = definition[0]
    elif definition[0] == "COMBO" and len(definition) == 2 and definition[1].get("multiselect") is False:
        metadata = definition[1]
        if (set(metadata) - {"multiselect", "options", "tooltip", "default", "advanced"}
                or ("tooltip" in metadata and not isinstance(metadata["tooltip"], str))
                or ("advanced" in metadata and type(metadata["advanced"]) is not bool)):
            return None
        values = definition[1].get("options")
    else:
        return None
    if (not isinstance(values, list) or len(values) > 10000
            or any(type(v) not in (str, int, float, bool) or (type(v) in (int, float) and not _finite_number(v)) for v in values)):
        return None
    if definition[0] == "COMBO" and "default" in definition[1] and not _in_enum(definition[1]["default"], values):
        return None
    return values


def _in_enum(value, options):
    # Python considers True == 1; a serialized choice must also match its type.
    return any(type(value) is type(choice) and value == choice for choice in options)


def _autogrow_minimum(definition):
    """Only the observed named IMAGE template has known omission semantics."""
    if (len(definition) != 2 or not isinstance(definition[1], dict)
            or "template" not in definition[1] or set(definition[1]) - {"template", "tooltip"}
            or ("tooltip" in definition[1] and not isinstance(definition[1]["tooltip"], str))):
        return None
    template = definition[1]["template"]
    if (not isinstance(template, dict) or set(template) != {"input", "names", "min"}
            or template["input"] != {"required": {"image": ["IMAGE", {}]}}):
        return None
    names, minimum = template["names"], template["min"]
    if (not isinstance(names, list) or not names or len(names) > 128
            or any(not isinstance(v, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,119}", v) for v in names)
            or len(set(names)) != len(names) or type(minimum) is not int or not 0 <= minimum <= len(names)):
        return None
    return minimum


def _dynamic_inputs(required, optional, inputs, unknown, node_id):
    """Resolve only selected V3 dynamic combo branches into dotted API fields."""
    required, optional = dict(required), dict(optional)
    pending = [(name, definition, 0) for name, definition in {**required, **optional}.items()]
    enums = {}
    for field, definition, depth in pending:
        if not isinstance(definition, list) or not definition or definition[0] != "COMFY_DYNAMICCOMBO_V3":
            continue
        valid = (depth < 8 and len(definition) == 2 and isinstance(definition[1], dict)
                 and not set(definition[1]) - {"options", "display_name", "tooltip", "hidden"}
                 and all(isinstance(definition[1][key], str) for key in ("display_name", "tooltip") if key in definition[1])
                 and ("hidden" not in definition[1] or type(definition[1]["hidden"]) is bool)
                 and isinstance(definition[1].get("options"), list) and len(definition[1]["options"]) <= 500)
        choices = {}
        for choice in definition[1]["options"] if valid else ():
            if (not isinstance(choice, dict) or set(choice) != {"key", "inputs"}
                    or not isinstance(choice["key"], str) or not choice["key"] or len(choice["key"]) > 120
                    or choice["key"] in choices or not isinstance(choice["inputs"], dict)
                    or "required" not in choice["inputs"] or set(choice["inputs"]) - {"required", "optional"}):
                valid = False
                break
            branch = choice["inputs"]
            if any(not isinstance(branch.get(kind, {}), dict) for kind in ("required", "optional")):
                valid = False
                break
            choices[choice["key"]] = branch
        if not valid:
            _issue(unknown, "dynamic_combo_schema_unavailable", node_id, field)
            continue
        enums[field] = list(choices)
        selection = inputs.get(field)
        if not isinstance(selection, str) or selection not in choices:
            continue
        branch = choices[selection]
        if set(branch.get("required", {})) & set(branch.get("optional", {})):
            _issue(unknown, "dynamic_combo_schema_unavailable", node_id, field)
            continue
        for kind, target in (("required", required), ("optional", optional)):
            for name, child in branch.get(kind, {}).items():
                flattened = field + "." + str(name)
                if (not isinstance(name, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,119}", name)
                        or flattened in required or flattened in optional or len(required) + len(optional) >= 512
                        or not isinstance(child, list) or not child):
                    _issue(unknown, "dynamic_combo_schema_unavailable", node_id, field)
                    continue
                target[flattened] = child
                pending.append((flattened, child, depth + 1))
    return required, optional, enums


def _recipe_checks(recipe, object_info):
    issues, unknown, model_checks = [], [], []
    workflow, bindings = recipe.get("workflow"), recipe.get("bindings")
    if not isinstance(workflow, dict) or not workflow or "nodes" in workflow or len(workflow) > 2000 or not isinstance(bindings, dict):
        return {"recipe": "failed", "objectInfo": "unavailable", "issues": [{"code": "invalid_recipe"}], "modelChecks": []}
    refs = bindings.get("references", [])
    if not isinstance(refs, list) or len(refs) > 8:
        return {"recipe": "failed", "objectInfo": "unavailable", "issues": [{"code": "invalid_bindings"}], "modelChecks": []}
    mutable, bound_media = set(), set()
    bound = [bindings.get("prompt"), bindings.get("seed"), *refs]
    if bindings.get("output_prefix"):
        bound.append(bindings["output_prefix"])
    for binding in bound:
        if not isinstance(binding, dict):
            _issue(issues, "invalid_binding")
            continue
        node_id, field = str(binding.get("node")), binding.get("field")
        bound_node = workflow.get(node_id)
        bound_inputs = bound_node.get("inputs", {}) if isinstance(bound_node, dict) else {}
        if not isinstance(field, str) or not isinstance(bound_inputs, dict) or field not in bound_inputs:
            _issue(issues, "invalid_binding", node_id)
        else:
            mutable.add((node_id, field))
    for binding in refs:
        if isinstance(binding, dict):
            field = binding.get("field")
            if isinstance(field, str):
                bound_media.add((str(binding.get("node")), field))
            if field != "image":
                _issue(issues, "unsupported_video_audio_reference")
    constraints = recipe.get("reference_constraints", [])
    if not isinstance(constraints, list) or (constraints and len(constraints) != len(refs)):
        _issue(issues, "invalid_reference_constraints")
    else:
        for value in constraints:
            if not _valid_reference_constraint(value):
                _issue(issues, "invalid_reference_constraints")
    outputs = recipe.get("output_nodes")
    if not isinstance(outputs, list) or not outputs or any(str(v) not in workflow for v in outputs):
        _issue(issues, "invalid_output_nodes")
        outputs = []
    recipe_failed = bool(issues)
    info_available = isinstance(object_info, dict) and bool(object_info)
    for node_id, node in workflow.items():
        if not isinstance(node, dict) or not isinstance(node.get("class_type"), str) or not isinstance(node.get("inputs"), dict):
            _issue(issues, "invalid_node", node_id)
            recipe_failed = True
            continue
        class_name, inputs = node["class_type"], node["inputs"]
        if "load" in class_name.lower():
            for field in ("image", "video", "audio", "filename"):
                if isinstance(inputs.get(field), str) and (str(node_id), field) not in bound_media:
                    _issue(issues, "unbound_media_input", node_id, field)
                    recipe_failed = True
        if not info_available:
            continue
        if class_name not in object_info:
            _issue(issues, "missing_class", node_id)
            continue
        schema = object_info[class_name]
        if not isinstance(schema, dict) or not isinstance(schema.get("input"), dict) or not isinstance(schema["input"].get("required", {}), dict):
            _issue(unknown, "node_schema_unavailable", node_id)
            continue
        required, optional = schema["input"].get("required", {}), schema["input"].get("optional", {})
        if not isinstance(optional, dict):
            _issue(unknown, "node_schema_unavailable", node_id)
            continue
        required, optional, dynamic_enums = _dynamic_inputs(required, optional, inputs, unknown, node_id)
        declared = {**required, **optional}
        for field, definition in required.items():
            if field not in inputs:
                if isinstance(definition, list) and definition and definition[0] == "COMFY_AUTOGROW_V3":
                    minimum = _autogrow_minimum(definition)
                    if minimum is None:
                        _issue(unknown, "autogrow_schema_unavailable", node_id, field)
                        continue
                    if minimum == 0:
                        continue
                _issue(issues, "missing_required_input", node_id, field)
        for field, value in inputs.items():
            definition = declared.get(field)
            if not isinstance(definition, list) or not definition:
                _issue(unknown, "input_schema_unavailable", node_id, field)
                continue
            if (str(node_id), field) in mutable:
                continue
            model_field = field in MODEL_FIELDS and any(token in class_name.lower() for token in ("load", "lora", "checkpoint"))
            if model_field:
                enum = _enum_options(definition)
                matched = enum is not None and isinstance(value, str) and _in_enum(value, enum)
                model_checks.append({"nodeId": str(node_id), "input": field, "status": "passed" if matched else "failed" if enum is not None else "unavailable"})
                if enum is None:
                    _issue(unknown, "model_enum_unavailable", node_id, field)
                elif not matched:
                    _issue(issues, "model_not_in_enum", node_id, field)
                continue
            if definition[0] == "COMFY_DYNAMICCOMBO_V3":
                if field in dynamic_enums and not _in_enum(value, dynamic_enums[field]):
                    _issue(issues, "parameter_not_in_enum", node_id, field)
                continue
            if definition[0] == "COMFY_AUTOGROW_V3":
                # Present aggregate values need their own link/shape contract;
                # recognizing min:0 only authorizes omission, not arbitrary data.
                _issue(unknown, "autogrow_value_schema_unavailable", node_id, field)
                continue
            enum = _enum_options(definition)
            if enum is not None:
                if not _in_enum(value, enum):
                    _issue(issues, "parameter_not_in_enum", node_id, field)
                continue
            if definition[0] == "COMBO":
                _issue(unknown, "combo_schema_unavailable", node_id, field)
                continue
            if isinstance(value, list):
                if len(value) != 2 or not isinstance(value[0], str) or type(value[1]) is not int:
                    _issue(issues, "invalid_link", node_id, field)
                    continue
                linked = workflow.get(value[0])
                if linked is None or value[1] < 0:
                    _issue(issues, "invalid_link", node_id, field)
                    continue
                source_schema = object_info.get(linked.get("class_type"), {}) if isinstance(linked, dict) else {}
                source_outputs = source_schema.get("output") if isinstance(source_schema, dict) else None
                if not isinstance(source_outputs, list):
                    _issue(unknown, "link_output_schema_unavailable", node_id, field)
                elif value[1] >= len(source_outputs):
                    _issue(issues, "link_output_out_of_range", node_id, field)
                else:
                    source_type, target_type = source_outputs[value[1]], definition[0]
                    if not isinstance(source_type, str) or not isinstance(target_type, str) or not source_type or not target_type:
                        _issue(unknown, "link_type_schema_unavailable", node_id, field)
                    elif source_type != "*" and target_type != "*" and source_type not in [v.strip() for v in target_type.split(",")]:
                        _issue(issues, "link_type_mismatch", node_id, field)
            else:
                code, failed = _primitive_issue(value, definition)
                if code:
                    _issue(issues if failed else unknown, code, node_id, field)
        if str(node_id) in [str(v) for v in outputs] and schema.get("output_node") is not True:
            _issue(issues, "not_output_node", node_id)
    if not info_available:
        _issue(unknown, "object_info_unavailable")
    object_failed = any(v["code"] in {"missing_class", "missing_required_input", "model_not_in_enum", "parameter_not_in_enum", "parameter_type_mismatch", "parameter_out_of_range", "invalid_link", "link_output_out_of_range", "link_type_mismatch", "not_output_node"} for v in issues)
    return {"recipe": "failed" if recipe_failed else "passed", "objectInfo": "failed" if object_failed else "unavailable" if unknown else "passed",
            "issues": issues + unknown, "modelChecks": model_checks}


def parse_comfy_recipes(registered_recipes, object_info, *, fetched_at):
    """Describe registered recipes only; never enable models from object_info."""
    if isinstance(registered_recipes, dict):
        registered_recipes = list(registered_recipes.values())
    elif isinstance(registered_recipes, tuple):
        registered_recipes = list(registered_recipes)
    recipes = _rows(registered_recipes)
    if object_info is not None and not isinstance(object_info, dict):
        raise CatalogError("invalid_snapshot")
    result, seen = [], set()
    for recipe in recipes:
        recipe_id = _text(recipe.get("id"), 100, required=True)
        if recipe_id in seen or not re.fullmatch(r"[A-Za-z0-9_-]+", recipe_id):
            raise CatalogError("invalid_snapshot")
        seen.add(recipe_id)
        workflow_hash = _digest(recipe.get("workflow"))
        recipe_hash = _digest({k: recipe.get(k, []) for k in ("workflow", "bindings", "output_nodes", "reference_constraints")})
        mode = _text(recipe.get("mode"), 80)
        capability = "image" if mode in ("t2i", "i2i") else "video" if mode in ("i2v", "t2v", "ref2va") else "unknown"
        item = _base("comfy.recipes", recipe_id, _text(recipe.get("name")) or recipe_id, "sha256:" + recipe_hash, fetched_at, capability)
        bindings = recipe.get("bindings") if isinstance(recipe.get("bindings"), dict) else {}
        refs = bindings.get("references") if isinstance(bindings.get("references"), list) else []
        inputs = [{"name": "prompt", "kind": "text", "required": True}, {"name": "seed", "kind": "integer", "required": True}]
        constraints = recipe.get("reference_constraints", [])
        for index, binding in enumerate(refs):
            field = binding.get("field") if isinstance(binding, dict) else None
            value = {"name": "reference_" + str(index + 1), "kind": field if isinstance(field, str) and field in {"image", "video", "audio"} else "unknown", "required": True}
            if isinstance(constraints, list) and len(constraints) == len(refs) and _valid_reference_constraint(constraints[index]):
                constraint = constraints[index]
                value.update({"role": constraint.get("role"), "mimeTypes": constraint.get("mime_types"), "sameAspect": True,
                              "minimumWidth": constraint.get("width"), "minimumHeight": constraint.get("height")})
            inputs.append(value)
        outputs = recipe.get("output_nodes") if isinstance(recipe.get("output_nodes"), list) else []
        item.update({"entryType": "registered_recipe", "registered": True, "mode": mode, "task": mode,
                     "workflowSha256": workflow_hash, "recipeSha256": recipe_hash, "inputs": inputs,
                     "inputRequirementsKnown": True, "needsContractReview": True, "referenceSlots": len(refs), "outputKind": capability,
                     "supportedReferenceKinds": ["image"],
                     "outputs": [{"nodeId": str(v), "kind": capability, "verification": "declared_recipe_mode"} for v in outputs],
                     "staticChecks": _recipe_checks(recipe, object_info), "directoryVerified": True})
        item.update(_needs(inputs))
        result.append(item)
    return sorted(result, key=lambda v: v["modelId"])


class ModelCatalog:
    """Read-only in-memory cache. No environment, credentials or persistence.

    read(source) returns capabilities JSON, models JSON, or object_info snapshot.
    Querying an empty/stale cache never invokes read; refresh is always explicit.
    """
    def __init__(self, read, *, registered_recipes=(), clock=time.time, ttl_seconds=600):
        if not callable(read) or not callable(clock) or type(ttl_seconds) not in (int, float) or not math.isfinite(ttl_seconds) or ttl_seconds <= 0:
            raise CatalogError("invalid_catalog_configuration")
        self._read, self._clock, self._ttl = read, clock, ttl_seconds
        self._recipes, self._cache = copy.deepcopy(registered_recipes), {}

    def _source(self, source):
        if source not in SOURCES:
            raise CatalogError("unsupported_source")

    def refresh(self, source):
        self._source(source)
        instant = self._clock()
        fetched_at = dt.datetime.fromtimestamp(instant, dt.timezone.utc).isoformat().replace("+00:00", "Z")
        try:
            payload = self._read(source)
        except Exception:
            self._failure(source, "read_failed")
            return self.query(source)
        try:
            if source == "rh.standard":
                items = parse_rh_standard(payload, fetched_at=fetched_at)
            elif source == "rh.llm":
                items = parse_rh_llm(payload, fetched_at=fetched_at)
            else:
                items = parse_comfy_recipes(self._recipes, payload, fetched_at=fetched_at)
            version = "sha256:" + _digest({"recipes": self._recipes, "object_info": payload}) if source == "comfy.recipes" else items[0]["sourceVersion"] if items else "sha256:" + _digest(payload)
            self._cache[source] = {"items": items, "instant": instant, "fetchedAt": fetched_at, "sourceVersion": version, "lastError": None}
        except (CatalogError, TypeError, ValueError, KeyError, AttributeError):
            self._failure(source, "invalid_snapshot")
        return self.query(source)

    def _failure(self, source, reason):
        self._cache.setdefault(source, {"items": [], "instant": None, "fetchedAt": None, "sourceVersion": None})["lastError"] = reason

    def query(self, source, *, page=1, page_size=40, search="", capability=None, task=None):
        self._source(source)
        if type(page) is not int or page < 1 or type(page_size) is not int or not 1 <= page_size <= 200:
            raise CatalogError("invalid_pagination")
        if not isinstance(search, str) or len(search) > 200 or (capability is not None and (not isinstance(capability, str) or capability not in CAPABILITIES)) or (task is not None and not isinstance(task, str)):
            raise CatalogError("invalid_filter")
        record = self._cache.get(source, {"items": [], "instant": None, "fetchedAt": None, "sourceVersion": None, "lastError": None})
        status = "empty" if record["instant"] is None else "stale" if record.get("lastError") or self._clock() - record["instant"] >= self._ttl else "fresh"
        needle = search.strip().casefold()
        items = [v for v in record["items"] if (capability is None or v["capability"] == capability) and (task is None or v["task"] == task)
                 and (not needle or any(needle in str(v.get(k, "")).casefold() for k in ("name", "modelId", "task")))]
        start = (page - 1) * page_size
        rows = copy.deepcopy(items[start:start + page_size])
        for row in rows:
            row["cacheStatus"] = status
        return {"source": source, "sourceVersion": record["sourceVersion"], "fetchedAt": record["fetchedAt"], "cacheStatus": status,
                "lastError": record.get("lastError"), "items": rows, "total": len(items), "page": page, "pageSize": page_size,
                "hasMore": start + page_size < len(items), "prototypeOnly": True, "generationEnabled": False}
