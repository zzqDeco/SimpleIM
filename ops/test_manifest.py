#!/usr/bin/env python3
"""Unit tests for ops/manifest.py."""

from __future__ import annotations

import datetime as dt
import hashlib
import io
import json
import pathlib
import subprocess
import sys
import tarfile
import tempfile
import unittest

import sys as _sys

_sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import manifest as m  # noqa: E402
import oci_delta as od  # noqa: E402


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


def _build_oci_tar_gz(path: pathlib.Path, blobs: list[bytes]) -> list[tuple[str, bytes]]:
    records: list[tuple[str, bytes]] = []
    with tarfile.open(path, mode="w:gz") as tf:
        for dir_name in ("blobs", "blobs/sha256"):
            d_info = tarfile.TarInfo(name=dir_name)
            d_info.type = tarfile.DIRTYPE
            d_info.mode = 0o755
            tf.addfile(d_info)

        for payload in blobs:
            hex_digest = hashlib.sha256(payload).hexdigest()
            member_name = f"blobs/sha256/{hex_digest}"
            info = tarfile.TarInfo(name=member_name)
            info.size = len(payload)
            info.mode = 0o444
            info.mtime = 1700000000
            tf.addfile(info, io.BytesIO(payload))
            records.append((hex_digest, payload))

        for name, content in (
            ("index.json", b'{"schemaVersion":2,"manifests":[]}'),
            ("manifest.json", b'[{"Config":"blobs/sha256/00","Layers":[]}]'),
            ("oci-layout", b'{"imageLayoutVersion":"1.0.0"}'),
        ):
            info = tarfile.TarInfo(name=name)
            info.size = len(content)
            info.mode = 0o644
            tf.addfile(info, io.BytesIO(content))
    return records


class OciDeltaTest(unittest.TestCase):
    def test_delta_pack_and_unpack_roundtrip_preserves_exact_blobs(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            full_archive = root / "full.tar.gz"
            delta_archive = root / "delta.tar.gz"
            cache_dir = root / "oci-blobs"
            cache_dir.mkdir()

            base_layer = b"base-layer-bun-alpine-" * 4096
            caddy_layer = b"caddy-layer-unchanged-" * 2048
            new_app_layer = b"new-server-bundle-v0.1.3"
            records = _build_oci_tar_gz(
                full_archive, [base_layer, caddy_layer, new_app_layer]
            )

            # Pre-seed base_layer and caddy_layer on simulated remote host
            for hex_digest, payload in records[:2]:
                (cache_dir / hex_digest).write_bytes(payload)

            remote_digests = set(od.list_verified_cache_digests(cache_dir))
            self.assertEqual(len(remote_digests), 2)

            stats = od.pack_delta_archive(full_archive, remote_digests, delta_archive)
            self.assertEqual(stats["omitted_blobs"], 2)
            self.assertEqual(stats["kept_blobs"], 1)
            self.assertLess(delta_archive.stat().st_size, full_archive.stat().st_size)

            out_buf = io.BytesIO()
            od.unpack_delta_stream(delta_archive, cache_dir, out_buf)
            out_buf.seek(0)

            with tarfile.open(fileobj=out_buf, mode="r:") as reconstructed:
                names = [m_info.name for m_info in reconstructed.getmembers()]
                self.assertNotIn(od.PLAN_MEMBER_NAME, names)
                for hex_digest, expected_payload in records:
                    member_name = f"blobs/sha256/{hex_digest}"
                    self.assertIn(member_name, names)
                    extracted = reconstructed.extractfile(member_name)
                    assert extracted is not None
                    self.assertEqual(extracted.read(), expected_payload)

            # New layer must now also reside in host cache for subsequent releases
            self.assertIn(records[2][0], od.list_verified_cache_digests(cache_dir))

    def test_tampered_cached_blob_aborts_unpack_cleanly(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            full_archive = root / "full.tar.gz"
            delta_archive = root / "delta.tar.gz"
            cache_dir = root / "oci-blobs"
            cache_dir.mkdir()

            records = _build_oci_tar_gz(full_archive, [b"cached-blob-a", b"fresh-blob-b"])
            cached_hex, cached_payload = records[0]
            (cache_dir / cached_hex).write_bytes(cached_payload)

            od.pack_delta_archive(full_archive, {cached_hex}, delta_archive)

            # Corrupt cached blob on disk before unpack
            (cache_dir / cached_hex).write_bytes(b"corrupted-cached-payload")

            out_buf = io.BytesIO()
            with self.assertRaises(ValueError):
                od.unpack_delta_stream(delta_archive, cache_dir, out_buf)
            self.assertFalse((cache_dir / cached_hex).exists())

    def test_non_oci_archive_falls_back_verbatim(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            legacy_tar = root / "legacy.tar.gz"
            out_tar = root / "out.tar.gz"
            with tarfile.open(legacy_tar, mode="w:gz") as tf:
                payload = b"legacy-layer-tar"
                info = tarfile.TarInfo(name="deadbeef/layer.tar")
                info.size = len(payload)
                tf.addfile(info, io.BytesIO(payload))

            stats = od.pack_delta_archive(legacy_tar, {"a" * 64}, out_tar)
            self.assertEqual(stats["omitted_blobs"], 0)
            self.assertEqual(legacy_tar.read_bytes(), out_tar.read_bytes())


if __name__ == "__main__":
    unittest.main()
