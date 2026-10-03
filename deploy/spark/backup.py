"""Cold application snapshot, with SQLite backup API instead of raw WAL copies."""

import argparse
from contextlib import closing
import datetime
import json
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import uuid


def sqlite_snapshot(source: Path, target: Path) -> None:
    with closing(sqlite3.connect(source.as_uri() + "?mode=ro", uri=True)) as origin:
        with closing(sqlite3.connect(target)) as destination:
            origin.backup(destination, pages=256)
            # A portable snapshot must be self-contained, even when its source
            # used WAL. The application's normal DSN re-enables WAL on restore.
            destination.execute("PRAGMA journal_mode=DELETE")
            result = destination.execute("PRAGMA integrity_check").fetchall()
            if result != [("ok",)]:
                raise RuntimeError(f"SQLite backup integrity check failed: {source.name}")


def snapshot_tree(source: Path, destination: Path) -> int:
    source = source.resolve(strict=True)
    destination.mkdir(parents=True, exist_ok=False, mode=0o700)
    databases = 0
    for item in sorted(source.rglob("*")):
        if item.is_symlink():
            raise ValueError(f"Refusing a symlink in persistent state: {item.relative_to(source)}")
        relative = item.relative_to(source)
        target = destination / relative
        if item.is_dir():
            target.mkdir(exist_ok=True)
            continue
        if item.name.endswith(("-wal", "-shm", "-journal")):
            continue
        with item.open("rb") as stream:
            header = stream.read(16)
        if header == b"SQLite format 3\x00":
            sqlite_snapshot(item, target)
            databases += 1
        elif item.suffix.lower() in {".db", ".sqlite", ".sqlite3"}:
            raise ValueError(f"Invalid SQLite file: {relative}")
        else:
            shutil.copy2(item, target)
    return databases


def assert_stopped_project(project: str, sources: dict[str, Path]) -> None:
    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]*", project):
        raise ValueError("Invalid Compose project name")
    result = subprocess.run(
        ["docker", "ps", "--all", "--filter", f"label=com.docker.compose.project={project}",
         "--format", "{{.ID}}"], check=True, text=True, capture_output=True,
    )
    containers = [value for value in result.stdout.splitlines() if value]
    services = {}
    for container in containers:
        detail = subprocess.run(
            ["docker", "inspect", "--format",
             '{{json .State.Status}}|{{json (index .Config.Labels "com.docker.compose.service")}}|{{json .Mounts}}',
             container], check=True, text=True, capture_output=True,
        )
        status, service, mounts = (json.loads(value) for value in detail.stdout.strip().split("|", 2))
        if status not in {"exited", "created"}:
            raise RuntimeError(f"Stop all project containers first: {service} is {status}")
        services[service] = mounts
    if not {"backend", "comfy-adapter", "web"}.issubset(services):
        raise RuntimeError("Expected stopped project containers are missing; use compose stop, not down")
    for service, source in sources.items():
        target = "/data" if service == "backend" else "/state"
        matched = [mount for mount in services[service] if mount["Destination"] == target]
        if len(matched) != 1 or Path(matched[0]["Source"]).resolve() != source:
            raise RuntimeError(f"Persistent mount does not match the requested runtime root: {service}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime-root", required=True, type=Path)
    parser.add_argument("--project", default="beeftv-spark")
    args = parser.parse_args()
    root = args.runtime_root.resolve(strict=True)
    sources = {
        "backend": (root / "state" / "backend-data").resolve(strict=True),
        "comfy-adapter": (root / "state" / "comfy-state").resolve(strict=True),
    }
    if any(not source.is_relative_to(root) for source in sources.values()):
        raise ValueError("State directories must remain within the runtime root")
    assert_stopped_project(args.project, sources)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup = root / "backups" / f"{stamp}-{uuid.uuid4().hex[:8]}"
    backup.mkdir(parents=True, exist_ok=False, mode=0o700)
    counts = {service: snapshot_tree(source, backup / service) for service, source in sources.items()}
    (backup / "complete.json").write_text(json.dumps({
        "project": args.project, "created_utc": stamp, "sqlite_databases": counts,
        "method": "stopped containers; SQLite backup API plus asset copies",
    }, indent=2) + "\n", encoding="utf-8")
    print(backup)


if __name__ == "__main__":
    main()
