"""Short-lived loopback adapter check; the real Comfy client permits GET only."""

import argparse
from collections import Counter
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
from urllib import request

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools" / "comfy_adapter"))
from server import Adapter, ComfyClient, PREFIX, load_recipes, make_server, validate_queue


class ReadOnlyComfyClient(ComfyClient):
    def __init__(self, url):
        super().__init__(url)
        self.requests = Counter()

    def _open(self, path, data=None, headers=None):
        if data is not None or path not in {"/queue", "/system_stats"}:
            raise RuntimeError("Read-only smoke refuses every upstream write or other endpoint")
        self.requests[path] += 1
        return super()._open(path, data, headers)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--comfy-url", default=os.getenv("BEEFTV_COMFY_URL"))
    parser.add_argument("--recipes", default=os.getenv("BEEFTV_COMFY_RECIPES"))
    parser.add_argument("--temporary-root", required=True, type=Path)
    parser.add_argument("--skill-client", type=Path, help="Optional reviewed standard-library skill CLI module")
    args = parser.parse_args()
    if not args.comfy_url:
        parser.error("Set the existing authorized ComfyUI URL explicitly")
    root = args.temporary_root.resolve(strict=True)
    client = ReadOnlyComfyClient(args.comfy_url)
    queue = validate_queue(client.json("/queue"))
    system = client.json("/system_stats").get("system", {})
    report = {"upstream_methods": ["GET"], "upstream_post_count": 0,
              "comfy_version": system.get("comfyui_version"),
              "queue_running": len(queue["queue_running"]),
              "queue_pending": len(queue["queue_pending"]),
              "checks": {}, "generation_enabled": False}
    recipes = load_recipes(args.recipes) if args.recipes else {}
    with tempfile.TemporaryDirectory(prefix="adapter-smoke-state-", dir=root) as state:
        adapter = Adapter(state, client, recipes, enabled=False)
        server = make_server(adapter, host="127.0.0.1", port=0)
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        try:
            opener = request.build_opener(request.ProxyHandler({}))
            for endpoint in ("config", "health", "projects", "assets", "recipes"):
                with opener.open(f"http://127.0.0.1:{server.server_port}{PREFIX}/{endpoint}", timeout=15) as response:
                    value = json.load(response)
                if value.get("code") != 0:
                    raise RuntimeError(f"Adapter GET {endpoint} failed")
                data = value["data"]
                if endpoint in {"config", "health"} and data.get("generation_enabled") is not False:
                    raise RuntimeError("Generation must remain disabled")
                if endpoint == "health" and data.get("comfy_reachable") is not True:
                    raise RuntimeError("The existing ComfyUI is unreachable")
                report["checks"][endpoint] = {"passed": True,
                    "count": len(data) if isinstance(data, list) else None}
            if args.skill_client:
                spec = importlib.util.spec_from_file_location("beeftv_skill_client", args.skill_client.resolve(strict=True))
                module = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(module)
                cli = module.Client(f"http://127.0.0.1:{server.server_port}")
                checks = {}
                for endpoint in ("config", "projects", "assets", "recipes", "health"):
                    data = cli.call("GET", "/" + endpoint)
                    if endpoint in {"config", "health"} and data.get("generation_enabled") is not False:
                        raise RuntimeError("Skill client must observe disabled generation")
                    if endpoint == "health" and data.get("comfy_reachable") is not True:
                        raise RuntimeError("Skill client could not confirm the existing ComfyUI")
                    checks[endpoint] = {"passed": True, "count": len(data) if isinstance(data, list) else None}
                report["skill_cli_readonly"] = {
                    "target": "temporary_sidecar_not_deployed_native_BeefTV",
                    "checks": checks, "native_Go_workspace_validated": False,
                }
        finally:
            server.shutdown()
            thread.join(timeout=10)
            server.server_close()
            adapter.close()
            if thread.is_alive():
                raise RuntimeError("Smoke server thread did not exit")
    report["upstream_get_counts"] = dict(client.requests)
    report["loopback_server_closed"] = True
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
