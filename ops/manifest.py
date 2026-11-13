#!/usr/bin/env python3
"""Immutable release manifest and compatibility validator for SimpleIM (aligned with zzqDeco/teamie)."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import pathlib
import re
import shlex
import sys
from typing import Any

SEMVER_RE = re.compile(r"^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$")
SHA40_RE = re.compile(r"^[0-9a-f]{40}$")
DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
HOST_RE = re.compile(r"^[a-z0-9][a-z0-9.-]*[a-z0-9]$")
NS_RE = re.compile(r"^[a-z0-9][a-z0-9._-]*$")

REQUIRED_SERVICES = ("server", "web", "caddy", "coturn")
CURRENT_SQLITE_SCHEMA_VERSION = 1


def parse_semver(value: str) -> tuple[int, int, int]:
    match = SEMVER_RE.fullmatch(value)
    if not match:
        raise ValueError(f"Version must be vMAJOR.MINOR.PATCH without leading zeroes: {value!r}")
    return int(match.group(1)), int(match.group(2)), int(match.group(3))


def validate_acr(public_host: str, pull_host: str, namespace: str) -> bool:
    """Validate ACR variables if configured; returns True when ACR mode is active."""
    vals = [public_host.strip(), pull_host.strip(), namespace.strip()]
    if not any(vals):
        return False
    if not all(vals):
        raise ValueError(
            "Partial ACR configuration: ACR_REGISTRY_PUBLIC_HOST, ACR_REGISTRY_PULL_HOST, "
            "and ACR_NAMESPACE must either all be set or all be empty."
        )
    if not HOST_RE.fullmatch(vals[0]) or not HOST_RE.fullmatch(vals[1]):
        raise ValueError("Invalid ACR registry hostname.")
    if not NS_RE.fullmatch(vals[2]):
        raise ValueError("Invalid ACR namespace.")
    return True


def validate_manifest_data(data: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(data, dict) or data.get("schemaVersion") != 1:
        raise ValueError("Unsupported manifest schemaVersion (expected 1).")
    ver = str(data.get("version", ""))
    parse_semver(ver)

    sha = str(data.get("sha", ""))
    main_sha = str(data.get("mainSha", sha))
    if not SHA40_RE.fullmatch(sha):
        raise ValueError(f"Invalid 40-char commit sha: {sha!r}")
    if sha != main_sha:
        raise ValueError("Manifest sha must equal mainSha.")

    ref = str(data.get("ref", f"refs/heads/release/{ver}"))
    if ref != f"refs/heads/release/{ver}":
        raise ValueError(f"Release ref mismatch: {ref!r}")

    repo = str(data.get("repository", ""))
    if not repo or "/" not in repo:
        raise ValueError("Invalid source repository in manifest.")

    sqlite_ver = data.get("sqliteSchemaVersion")
    if type(sqlite_ver) is not int or sqlite_ver < 1:
        raise ValueError("Invalid sqliteSchemaVersion in manifest.")

    delivery_mode = data.get("deliveryMode")
    if delivery_mode not in ("acr", "bundle"):
        raise ValueError(f"Unsupported deliveryMode: {delivery_mode!r}")

    images = data.get("images")
    if not isinstance(images, dict) or set(images.keys()) != set(REQUIRED_SERVICES):
        raise ValueError(f"Manifest images must contain exactly {REQUIRED_SERVICES}.")

    for svc in REQUIRED_SERVICES:
        image_ref = str(images.get(svc, "")).strip()
        if not image_ref:
            raise ValueError(f"Empty image reference for {svc}.")
        if delivery_mode == "acr":
            if "@" not in image_ref:
                raise ValueError(f"ACR mode requires immutable @sha256 digest for {svc}: {image_ref}")
            _, digest = image_ref.rsplit("@", 1)
            if not DIGEST_RE.fullmatch(digest):
                raise ValueError(f"Invalid image digest for {svc}: {image_ref}")
        elif "@" in image_ref:
            _, digest = image_ref.rsplit("@", 1)
            if not DIGEST_RE.fullmatch(digest):
                raise ValueError(f"Invalid image digest for {svc}: {image_ref}")

    created_raw = str(data.get("createdAt", ""))
    created = dt.datetime.fromisoformat(created_raw.replace("Z", "+00:00"))
    if created.tzinfo is None:
        raise ValueError("Manifest createdAt requires UTC timezone.")

    if "registry" in data and data["registry"] is not None:
        reg = data["registry"]
        if not isinstance(reg, dict):
            raise ValueError("Invalid registry metadata object.")
        validate_acr(
            str(reg.get("pushHost", "")),
            str(reg.get("pullHost", "")),
            str(reg.get("namespace", "")),
        )

    return data


def check_transition(
    candidate: dict[str, Any],
    current: dict[str, Any] | None = None,
    highwater: dict[str, Any] | None = None,
    rollback: bool = False,
) -> None:
    validate_manifest_data(candidate)
    cand_ver = parse_semver(candidate["version"])

    if rollback:
        if current is None:
            raise ValueError("No current deployment exists to roll back from.")
        validate_manifest_data(current)
        curr_ver = parse_semver(current["version"])
        if cand_ver > curr_ver:
            raise ValueError("Rollback target version must not be newer than current version.")
        if candidate["sqliteSchemaVersion"] != current["sqliteSchemaVersion"]:
            raise ValueError(
                "Image rollback requires identical sqliteSchemaVersion; forward SQLite migrations are never reversed."
            )
        return

    created = dt.datetime.fromisoformat(candidate["createdAt"].replace("Z", "+00:00"))
    age_seconds = (dt.datetime.now(dt.timezone.utc) - created).total_seconds()
    if not (-300 <= age_seconds <= 86400):
        raise ValueError("Release manifest is stale (>24h) or has a future timestamp.")

    if highwater is not None:
        validate_manifest_data(highwater)
        hw_ver = parse_semver(highwater["version"])
        if cand_ver < hw_ver:
            raise ValueError(
                f"Release version {candidate['version']} is lower than highwater {highwater['version']}."
            )
        if cand_ver == hw_ver:
            if (
                candidate["sha"] != highwater["sha"]
                or candidate["images"] != highwater["images"]
                or candidate["deliveryMode"] != highwater["deliveryMode"]
            ):
                raise ValueError(
                    f"Version {candidate['version']} was already deployed with different artifacts; cut a new semantic version."
                )

    if current is not None:
        validate_manifest_data(current)
        if candidate["sqliteSchemaVersion"] < current["sqliteSchemaVersion"]:
            raise ValueError("Forward deployment cannot lower sqliteSchemaVersion.")


def cmd_registry_check(args: argparse.Namespace) -> None:
    acr_active = validate_acr(
        args.registry_public_host or "",
        args.registry_pull_host or "",
        args.registry_namespace or "",
    )
    print(json.dumps({"ok": True, "mode": "acr" if acr_active else "ghcr-bundle"}))


def cmd_create(args: argparse.Namespace) -> None:
    parse_semver(args.version)
    if not SHA40_RE.fullmatch(args.sha):
        raise ValueError(f"Invalid 40-char commit sha: {args.sha}")
    if args.main_sha != args.sha:
        raise ValueError("Release commit SHA must match main SHA.")

    acr_active = validate_acr(
        args.registry_public_host or "",
        args.registry_pull_host or "",
        args.registry_namespace or "",
    )

    digests_dir = pathlib.Path(args.digests)
    images: dict[str, str] = {}
    for svc in REQUIRED_SERVICES:
        p = digests_dir / f"{svc}.json"
        if not p.is_file():
            raise ValueError(f"Missing image metadata file: {p}")
        item = json.loads(p.read_text(encoding="utf-8"))
        if item.get("service") != svc:
            raise ValueError(f"Mismatched service name in {p}")
        images[svc] = str(item.get("image", "")).strip()

    manifest: dict[str, Any] = {
        "schemaVersion": 1,
        "repository": args.repository,
        "version": args.version,
        "sha": args.sha,
        "mainSha": args.main_sha,
        "ref": f"refs/heads/release/{args.version}",
        "sqliteSchemaVersion": args.sqlite_schema_version,
        "deliveryMode": "acr" if acr_active else "bundle",
        "createdAt": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "images": images,
    }
    if acr_active:
        manifest["registry"] = {
            "provider": "acr",
            "pushHost": args.registry_public_host.strip(),
            "pullHost": args.registry_pull_host.strip(),
            "namespace": args.registry_namespace.strip(),
        }

    validate_manifest_data(manifest)
    json.dump(manifest, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")


def cmd_check(args: argparse.Namespace) -> None:
    candidate = json.loads(pathlib.Path(args.manifest).read_text(encoding="utf-8"))
    current = (
        json.loads(pathlib.Path(args.current).read_text(encoding="utf-8"))
        if args.current
        else None
    )
    highwater = (
        json.loads(pathlib.Path(args.highwater).read_text(encoding="utf-8"))
        if args.highwater
        else None
    )
    check_transition(candidate, current=current, highwater=highwater, rollback=args.rollback)


def cmd_verify(args: argparse.Namespace) -> None:
    data = json.loads(pathlib.Path(args.manifest).read_text(encoding="utf-8"))
    validate_manifest_data(data)
    if args.print_env:
        images = data["images"]
        pairs = [
            ("RELEASE_VERSION", data["version"]),
            ("RELEASE_SHA", data["sha"]),
            ("SQLITE_SCHEMA_VERSION", str(data["sqliteSchemaVersion"])),
            ("DELIVERY_MODE", data["deliveryMode"]),
            ("SERVER_IMAGE", images["server"]),
            ("WEB_IMAGE", images["web"]),
            ("CADDY_IMAGE", images["caddy"]),
            ("COTURN_IMAGE", images["coturn"]),
        ]
        for key, val in pairs:
            print(f"{key}={shlex.quote(str(val))}")


def main() -> int:
    parser = argparse.ArgumentParser(description="SimpleIM release manifest utility")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_reg = sub.add_parser("registry-check")
    p_reg.add_argument("--registry-public-host", default="")
    p_reg.add_argument("--registry-pull-host", default="")
    p_reg.add_argument("--registry-namespace", default="")
    p_reg.set_defaults(func=cmd_registry_check)

    p_create = sub.add_parser("create")
    p_create.add_argument("--repository", required=True)
    p_create.add_argument("--version", required=True)
    p_create.add_argument("--sha", required=True)
    p_create.add_argument("--main-sha", required=True)
    p_create.add_argument("--digests", required=True)
    p_create.add_argument(
        "--sqlite-schema-version", type=int, default=CURRENT_SQLITE_SCHEMA_VERSION
    )
    p_create.add_argument("--registry-public-host", default="")
    p_create.add_argument("--registry-pull-host", default="")
    p_create.add_argument("--registry-namespace", default="")
    p_create.set_defaults(func=cmd_create)

    p_check = sub.add_parser("check")
    p_check.add_argument("manifest")
    p_check.add_argument("--current", default="")
    p_check.add_argument("--highwater", default="")
    p_check.add_argument("--rollback", action="store_true")
    p_check.set_defaults(func=cmd_check)

    p_verify = sub.add_parser("verify")
    p_verify.add_argument("--manifest", required=True)
    p_verify.add_argument("--print-env", action="store_true")
    p_verify.set_defaults(func=cmd_verify)

    parsed = parser.parse_args()
    try:
        parsed.func(parsed)
    except (ValueError, KeyError, OSError, json.JSONDecodeError) as exc:
        print(f"manifest validation error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
