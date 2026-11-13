#!/usr/bin/env python3
"""Unit tests for ops/manifest.py."""

from __future__ import annotations

import datetime as dt
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest

import sys as _sys

_sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import manifest as m  # noqa: E402


def _now_iso(offset_seconds: int = 0) -> str:
    ts = dt.datetime.now(dt.timezone.utc) + dt.timedelta(seconds=offset_seconds)
    return ts.strftime("%Y-%m-%dT%H:%M:%SZ")


def _sample_manifest(
    version: str = "v0.1.0",
    sha: str = "a" * 40,
    sqlite_ver: int = 1,
    mode: str = "bundle",
    offset_seconds: int = 0,
) -> dict:
    digest = "sha256:" + ("b" * 64)
    if mode == "acr":
        images = {
            svc: f"crpi-demo-vpc.cn-shenzhen.personal.cr.aliyuncs.com/ns/simpleim-{svc}@{digest}"
            for svc in m.REQUIRED_SERVICES
        }
    else:
        images = {
            "server": f"simpleim-server:{version}",
            "web": f"simpleim-web:{version}",
            "caddy": "simpleim-caddy:local",
            "coturn": "simpleim-coturn:local",
        }
    data = {
        "schemaVersion": 1,
        "repository": "zzqDeco/SimpleIM",
        "version": version,
        "sha": sha,
        "mainSha": sha,
        "ref": f"refs/heads/release/{version}",
        "sqliteSchemaVersion": sqlite_ver,
        "deliveryMode": mode,
        "createdAt": _now_iso(offset_seconds),
        "images": images,
    }
    if mode == "acr":
        data["registry"] = {
            "provider": "acr",
            "pushHost": "crpi-demo.cn-shenzhen.personal.cr.aliyuncs.com",
            "pullHost": "crpi-demo-vpc.cn-shenzhen.personal.cr.aliyuncs.com",
            "namespace": "ns",
        }
    return data


class ManifestTest(unittest.TestCase):
    def test_validate_acr_modes(self) -> None:
        self.assertFalse(m.validate_acr("", "", ""))
        self.assertTrue(
            m.validate_acr(
                "crpi-x.cn-shenzhen.personal.cr.aliyuncs.com",
                "crpi-x-vpc.cn-shenzhen.personal.cr.aliyuncs.com",
                "zzqdeco-teamie",
            )
        )
        with self.assertRaises(ValueError):
            m.validate_acr("crpi-x.cn-shenzhen.personal.cr.aliyuncs.com", "", "ns")

    def test_forward_highwater_and_immutability(self) -> None:
        v1 = _sample_manifest("v0.1.0", "1" * 40)
        v2 = _sample_manifest("v0.1.1", "2" * 40)
        m.check_transition(v2, current=v1, highwater=v1, rollback=False)

        # Downgrade on apply is rejected
        with self.assertRaises(ValueError):
            m.check_transition(v1, current=v2, highwater=v2, rollback=False)

        # Mutating an already-deployed version's SHA is rejected
        v1_mutated = _sample_manifest("v0.1.0", "9" * 40)
        with self.assertRaises(ValueError):
            m.check_transition(v1_mutated, current=v1, highwater=v1, rollback=False)

    def test_rollback_schema_guard(self) -> None:
        v1 = _sample_manifest("v0.1.0", "1" * 40, sqlite_ver=1, offset_seconds=-90000)
        v2_same_schema = _sample_manifest("v0.2.0", "2" * 40, sqlite_ver=1)
        m.check_transition(v1, current=v2_same_schema, rollback=True)

        v2_bumped_schema = _sample_manifest("v0.2.0", "2" * 40, sqlite_ver=2)
        with self.assertRaises(ValueError):
            m.check_transition(v1, current=v2_bumped_schema, rollback=True)

    def test_cli_create_and_verify_roundtrip(self) -> None:
        script = pathlib.Path(__file__).resolve().parent / "manifest.py"
        with tempfile.TemporaryDirectory() as tmp:
            digests = pathlib.Path(tmp) / "digests"
            digests.mkdir()
            for svc in m.REQUIRED_SERVICES:
                (digests / f"{svc}.json").write_text(
                    json.dumps({"service": svc, "image": f"simpleim-{svc}:v0.1.0"}),
                    encoding="utf-8",
                )
            manifest_file = pathlib.Path(tmp) / "release-manifest.json"
            out = subprocess.check_output(
                [
                    sys.executable,
                    str(script),
                    "create",
                    "--repository",
                    "zzqDeco/SimpleIM",
                    "--version",
                    "v0.1.0",
                    "--sha",
                    "c" * 40,
                    "--main-sha",
                    "c" * 40,
                    "--digests",
                    str(digests),
                ],
                text=True,
            )
            manifest_file.write_text(out, encoding="utf-8")
            env_out = subprocess.check_output(
                [
                    sys.executable,
                    str(script),
                    "verify",
                    "--manifest",
                    str(manifest_file),
                    "--print-env",
                ],
                text=True,
            )
            self.assertIn("RELEASE_VERSION=v0.1.0", env_out)
            self.assertIn("SERVER_IMAGE=simpleim-server:v0.1.0", env_out)


if __name__ == "__main__":
    unittest.main()
