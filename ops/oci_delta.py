#!/usr/bin/env python3
"""Content-addressed OCI blob delta bundler for cross-border SSH deployments.

Deduplicates unchanged `blobs/sha256/<digest>` layers in `docker save` archives
against a verified remote host blob cache while reconstructing a byte-identical
tar stream before `docker load`.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
from typing import Any

HEX64_RE = re.compile(r"^[0-9a-f]{64}$")
OCI_BLOB_RE = re.compile(r"^blobs/sha256/([0-9a-f]{64})$")
OMITTED_MARKER_RE = re.compile(r"^_simpleim_omitted/([0-9a-f]{64})$")
PLAN_MEMBER_NAME = "_simpleim_delta_plan.json"
SEEDED_INDEX_NAME = ".seeded_image_ids.json"
ALLOWED_SEED_REPOS = frozenset(
    {"simpleim-server", "simpleim-web", "simpleim-caddy", "simpleim-coturn"}
)
DEFAULT_MAX_CACHE_BYTES = 2 * 1024 * 1024 * 1024  # 2 GiB
CHUNK_SIZE = 1024 * 1024  # 1 MiB


def _sha256_file(path: pathlib.Path) -> tuple[str, int]:
    digest = hashlib.sha256()
    total = 0
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(CHUNK_SIZE)
            if not chunk:
                break
            digest.update(chunk)
            total += len(chunk)
    return digest.hexdigest(), total


def _store_verified_blob(
    cache_dir: pathlib.Path, expected_hex: str, reader: Any, expected_size: int | None = None
) -> pathlib.Path:
    if not HEX64_RE.fullmatch(expected_hex):
        raise ValueError(f"Invalid SHA-256 hex digest: {expected_hex!r}")
    cache_dir.mkdir(parents=True, exist_ok=True)
    os.chmod(cache_dir, 0o700)
    target = cache_dir / expected_hex

    fd, tmp_name = tempfile.mkstemp(prefix=".tmp-blob-", dir=str(cache_dir))
    tmp_path = pathlib.Path(tmp_name)
    try:
        digest = hashlib.sha256()
        total = 0
        with os.fdopen(fd, "wb") as out:
            while True:
                chunk = reader.read(CHUNK_SIZE)
                if not chunk:
                    break
                digest.update(chunk)
                total += len(chunk)
                out.write(chunk)
        actual_hex = digest.hexdigest()
        if actual_hex != expected_hex:
            raise ValueError(
                f"OCI blob digest mismatch for {expected_hex}: computed {actual_hex}"
            )
        if expected_size is not None and total != expected_size:
            raise ValueError(
                f"OCI blob size mismatch for {expected_hex}: expected {expected_size}, got {total}"
            )
        os.chmod(tmp_path, 0o600)
        os.replace(tmp_path, target)
        return target
    except BaseException:
        tmp_path.unlink(missing_ok=True)
        raise


def _load_seeded_ids(cache_dir: pathlib.Path) -> set[str]:
    idx_path = cache_dir / SEEDED_INDEX_NAME
    if not idx_path.is_file():
        return set()
    try:
        raw = json.loads(idx_path.read_text(encoding="utf-8"))
        if isinstance(raw, list):
            return {str(x) for x in raw if isinstance(x, str)}
    except (OSError, json.JSONDecodeError):
        pass
    return set()


def _save_seeded_ids(cache_dir: pathlib.Path, ids: set[str]) -> None:
    idx_path = cache_dir / SEEDED_INDEX_NAME
    fd, tmp_name = tempfile.mkstemp(prefix=".tmp-idx-", dir=str(cache_dir))
    tmp_path = pathlib.Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as out:
            json.dump(sorted(ids), out)
        os.chmod(tmp_path, 0o600)
        os.replace(tmp_path, idx_path)
    except BaseException:
        tmp_path.unlink(missing_ok=True)
        raise


def seed_cache_from_docker(cache_dir: pathlib.Path) -> None:
    cache_dir.mkdir(parents=True, exist_ok=True)
    os.chmod(cache_dir, 0o700)
    try:
        proc = subprocess.run(
            ["docker", "images", "--no-trunc", "--format", "{{.Repository}}\t{{.Tag}}\t{{.ID}}"],
            capture_output=True,
            text=True,
            check=True,
            timeout=30,
        )
    except (OSError, subprocess.SubprocessError):
        return

    seeded_ids = _load_seeded_ids(cache_dir)
    per_repo_counts: dict[str, int] = {}
    to_export: list[tuple[str, str]] = []
    seen_batch_ids: set[str] = set()

    for line in proc.stdout.splitlines():
        parts = line.strip().split("\t")
        if len(parts) != 3:
            continue
        repo, tag, image_id = parts
        if repo not in ALLOWED_SEED_REPOS or not tag or tag == "<none>":
            continue
        count = per_repo_counts.get(repo, 0)
        if count >= 2:
            continue
        per_repo_counts[repo] = count + 1
        if image_id in seeded_ids or image_id in seen_batch_ids:
            continue
        seen_batch_ids.add(image_id)
        to_export.append((f"{repo}:{tag}", image_id))

    if not to_export:
        return

    refs = [ref for ref, _ in to_export]
    save_proc = subprocess.Popen(
        ["docker", "save", *refs],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    try:
        assert save_proc.stdout is not None
        with tarfile.open(fileobj=save_proc.stdout, mode="r|*") as archive:
            for member in archive:
                if not member.isfile():
                    continue
                match = OCI_BLOB_RE.fullmatch(member.name)
                if not match:
                    continue
                hex_digest = match.group(1)
                existing = cache_dir / hex_digest
                if existing.is_file() and existing.stat().st_size == member.size:
                    continue
                extracted = archive.extractfile(member)
                if extracted is not None:
                    _store_verified_blob(cache_dir, hex_digest, extracted, member.size)
        rc = save_proc.wait(timeout=120)
        if rc == 0:
            seeded_ids.update(image_id for _, image_id in to_export)
            _save_seeded_ids(cache_dir, seeded_ids)
    except (OSError, tarfile.TarError, ValueError, subprocess.SubprocessError):
        save_proc.kill()
        save_proc.wait()


def list_verified_cache_digests(cache_dir: pathlib.Path) -> list[str]:
    if not cache_dir.is_dir():
        return []
    valid: list[str] = []
    for entry in sorted(cache_dir.iterdir(), key=lambda p: p.name):
        if not entry.is_file() or not HEX64_RE.fullmatch(entry.name):
            continue
        try:
            actual_hex, _ = _sha256_file(entry)
        except OSError:
            continue
        if actual_hex == entry.name:
            valid.append(entry.name)
        else:
            entry.unlink(missing_ok=True)
    return valid


def prune_cache(
    cache_dir: pathlib.Path, keep_digests: set[str], max_bytes: int = DEFAULT_MAX_CACHE_BYTES
) -> None:
    if not cache_dir.is_dir():
        return
    candidates: list[tuple[float, int, pathlib.Path]] = []
    total_bytes = 0
    for entry in cache_dir.iterdir():
        if not entry.is_file() or not HEX64_RE.fullmatch(entry.name):
            continue
        try:
            st = entry.stat()
        except OSError:
            continue
        total_bytes += st.st_size
        if entry.name not in keep_digests:
            candidates.append((st.st_mtime, st.st_size, entry))

    if total_bytes <= max_bytes:
        return

    candidates.sort(key=lambda item: item[0])  # Oldest mtime first
    for _, size, path in candidates:
        if total_bytes <= max_bytes:
            break
        try:
            path.unlink()
            total_bytes -= size
        except OSError:
            pass


def pack_delta_archive(
    input_tar_gz: pathlib.Path, remote_digests: set[str], output_tar_gz: pathlib.Path
) -> dict[str, int]:
    clean_remote = {d for d in remote_digests if HEX64_RE.fullmatch(d)}
    with tarfile.open(input_tar_gz, mode="r:gz") as src_check:
        members = src_check.getmembers()
        has_oci_layout = any(m.name == "oci-layout" for m in members)
        has_oci_blobs = any(
            m.isfile() and OCI_BLOB_RE.fullmatch(m.name) is not None for m in members
        )

    if not (has_oci_layout and has_oci_blobs) or not clean_remote:
        shutil.copyfile(input_tar_gz, output_tar_gz)
        kept_bytes = sum(m.size for m in members if m.isfile())
        return {
            "kept_blobs": sum(
                1 for m in members if m.isfile() and OCI_BLOB_RE.fullmatch(m.name)
            ),
            "kept_bytes": kept_bytes,
            "omitted_blobs": 0,
            "omitted_bytes": 0,
        }

    omitted_meta: dict[str, dict[str, int]] = {}
    kept_blobs = 0
    kept_bytes = 0
    omitted_blobs = 0
    omitted_bytes = 0

    for member in members:
        if member.name == PLAN_MEMBER_NAME or OMITTED_MARKER_RE.fullmatch(member.name):
            raise ValueError(f"Reserved delta member name in input archive: {member.name}")
        if not member.isfile():
            continue
        match = OCI_BLOB_RE.fullmatch(member.name)
        if not match:
            kept_bytes += member.size
            continue
        hex_digest = match.group(1)
        if hex_digest in clean_remote:
            omitted_meta[hex_digest] = {
                "size": int(member.size),
                "mode": int(member.mode),
                "mtime": int(member.mtime),
            }
            omitted_blobs += 1
            omitted_bytes += member.size
        else:
            kept_blobs += 1
            kept_bytes += member.size

    if not omitted_meta:
        shutil.copyfile(input_tar_gz, output_tar_gz)
        return {
            "kept_blobs": kept_blobs,
            "kept_bytes": kept_bytes,
            "omitted_blobs": 0,
            "omitted_bytes": 0,
        }

    plan_bytes = json.dumps(
        {"schemaVersion": 1, "omitted": omitted_meta}, sort_keys=True
    ).encode("utf-8")

    with (
        tarfile.open(input_tar_gz, mode="r:gz") as src,
        tarfile.open(output_tar_gz, mode="w:gz", compresslevel=6) as dst,
    ):
        plan_info = tarfile.TarInfo(name=PLAN_MEMBER_NAME)
        plan_info.size = len(plan_bytes)
        plan_info.mode = 0o600
        dst.addfile(plan_info, io.BytesIO(plan_bytes))

        for member in src:
            if member.isfile():
                match = OCI_BLOB_RE.fullmatch(member.name)
                if match:
                    hex_digest = match.group(1)
                    extracted = src.extractfile(member)
                    if extracted is None:
                        raise ValueError(f"Unable to read blob member {member.name}")
                    # Verify source blob integrity before omitting or forwarding
                    hasher = hashlib.sha256()
                    while True:
                        chunk = extracted.read(CHUNK_SIZE)
                        if not chunk:
                            break
                        hasher.update(chunk)
                    if hasher.hexdigest() != hex_digest:
                        raise ValueError(
                            f"Input archive blob {member.name} failed SHA-256 check"
                        )
                    if hex_digest in omitted_meta:
                        marker = tarfile.TarInfo(name=f"_simpleim_omitted/{hex_digest}")
                        marker.size = 0
                        marker.mode = 0o600
                        marker.mtime = member.mtime
                        dst.addfile(marker, io.BytesIO(b""))
                        continue
                    extracted_again = src.extractfile(member)
                    assert extracted_again is not None
                    dst.addfile(member, extracted_again)
                    continue

            if member.isfile():
                extracted_other = src.extractfile(member)
                dst.addfile(member, extracted_other)
            else:
                dst.addfile(member)

    return {
        "kept_blobs": kept_blobs,
        "kept_bytes": kept_bytes,
        "omitted_blobs": omitted_blobs,
        "omitted_bytes": omitted_bytes,
    }


def unpack_delta_stream(
    input_tar_gz: pathlib.Path,
    cache_dir: pathlib.Path,
    out_stream: Any,
    max_cache_bytes: int = DEFAULT_MAX_CACHE_BYTES,
) -> None:
    cache_dir.mkdir(parents=True, exist_ok=True)
    os.chmod(cache_dir, 0o700)

    omitted_plan: dict[str, dict[str, int]] = {}
    referenced_digests: set[str] = set()

    dst = tarfile.open(fileobj=out_stream, mode="w|")
    closed_cleanly = False
    try:
        with tarfile.open(input_tar_gz, mode="r|gz") as src:
            for member in src:
                if member.name == PLAN_MEMBER_NAME:
                    extracted = src.extractfile(member)
                    if extracted is None:
                        raise ValueError("Corrupt delta plan member.")
                    plan_doc = json.loads(extracted.read().decode("utf-8"))
                    if not isinstance(plan_doc, dict) or plan_doc.get("schemaVersion") != 1:
                        raise ValueError("Unsupported OCI delta plan schemaVersion.")
                    raw_omitted = plan_doc.get("omitted", {})
                    if not isinstance(raw_omitted, dict):
                        raise ValueError("Invalid omitted dictionary in OCI delta plan.")
                    for hex_digest, meta in raw_omitted.items():
                        if not HEX64_RE.fullmatch(str(hex_digest)) or not isinstance(meta, dict):
                            raise ValueError(f"Invalid omitted blob metadata for {hex_digest!r}")
                        expected_size = int(meta["size"])
                        cached_file = cache_dir / str(hex_digest)
                        if not cached_file.is_file():
                            raise ValueError(f"Missing cached OCI blob on host: {hex_digest}")
                        actual_hex, actual_size = _sha256_file(cached_file)
                        if actual_hex != str(hex_digest) or actual_size != expected_size:
                            cached_file.unlink(missing_ok=True)
                            raise ValueError(
                                f"Cached OCI blob integrity check failed for {hex_digest}"
                            )
                        omitted_plan[str(hex_digest)] = {
                            "size": expected_size,
                            "mode": int(meta.get("mode", 0o444)),
                            "mtime": int(meta.get("mtime", 0)),
                        }
                    continue

                marker_match = OMITTED_MARKER_RE.fullmatch(member.name)
                if marker_match:
                    hex_digest = marker_match.group(1)
                    if hex_digest not in omitted_plan:
                        raise ValueError(
                            f"Encountered undeclared omitted blob marker: {hex_digest}"
                        )
                    meta = omitted_plan[hex_digest]
                    cached_file = cache_dir / hex_digest
                    if not cached_file.is_file():
                        raise ValueError(f"Missing cached OCI blob on host: {hex_digest}")
                    actual_hex, actual_size = _sha256_file(cached_file)
                    if actual_hex != hex_digest or actual_size != meta["size"]:
                        cached_file.unlink(missing_ok=True)
                        raise ValueError(
                            f"Cached OCI blob integrity check failed for {hex_digest}"
                        )
                    referenced_digests.add(hex_digest)
                    restored = tarfile.TarInfo(name=f"blobs/sha256/{hex_digest}")
                    restored.size = actual_size
                    restored.mode = meta["mode"]
                    restored.mtime = meta["mtime"]
                    with cached_file.open("rb") as blob_handle:
                        dst.addfile(restored, blob_handle)
                    continue

                if member.isfile():
                    blob_match = OCI_BLOB_RE.fullmatch(member.name)
                    if blob_match:
                        hex_digest = blob_match.group(1)
                        extracted = src.extractfile(member)
                        if extracted is None:
                            raise ValueError(f"Missing payload for {member.name}")
                        cached_file = _store_verified_blob(
                            cache_dir, hex_digest, extracted, member.size
                        )
                        referenced_digests.add(hex_digest)
                        with cached_file.open("rb") as blob_handle:
                            dst.addfile(member, blob_handle)
                        continue

                    extracted_other = src.extractfile(member)
                    dst.addfile(member, extracted_other)
                else:
                    dst.addfile(member)

        dst.close()
        closed_cleanly = True
    finally:
        if not closed_cleanly:
            # Leave tar stream unterminated on integrity error so downstream consumer rejects EOF
            pass

    prune_cache(cache_dir, keep_digests=referenced_digests, max_bytes=max_cache_bytes)


def main() -> int:
    parser = argparse.ArgumentParser(description="SimpleIM OCI blob delta utility")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_idx = sub.add_parser("index-cache")
    p_idx.add_argument("--cache-dir", required=True)
    p_idx.add_argument("--seed-docker", action="store_true")

    p_pack = sub.add_parser("pack")
    p_pack.add_argument("--input", required=True)
    p_pack.add_argument("--remote-blobs", required=True)
    p_pack.add_argument("--output", required=True)

    p_unpack = sub.add_parser("unpack-to-docker")
    p_unpack.add_argument("--input", required=True)
    p_unpack.add_argument("--cache-dir", required=True)

    args = parser.parse_args()
    try:
        if args.cmd == "index-cache":
            cache_dir = pathlib.Path(args.cache_dir)
            if args.seed_docker:
                seed_cache_from_docker(cache_dir)
            for digest in list_verified_cache_digests(cache_dir):
                sys.stdout.write(f"{digest}\n")
        elif args.cmd == "pack":
            remote_path = pathlib.Path(args.remote_blobs)
            remote_set = (
                {
                    line.strip()
                    for line in remote_path.read_text(encoding="utf-8").splitlines()
                    if line.strip()
                }
                if remote_path.is_file()
                else set()
            )
            stats = pack_delta_archive(
                pathlib.Path(args.input),
                remote_set,
                pathlib.Path(args.output),
            )
            print(
                f"OCI delta archive ready: kept={stats['kept_blobs']} ({stats['kept_bytes']} B), "
                f"omitted={stats['omitted_blobs']} ({stats['omitted_bytes']} B)",
                file=sys.stderr,
            )
        elif args.cmd == "unpack-to-docker":
            unpack_delta_stream(
                pathlib.Path(args.input),
                pathlib.Path(args.cache_dir),
                sys.stdout.buffer,
            )
            sys.stdout.buffer.flush()
    except (ValueError, KeyError, OSError, tarfile.TarError, json.JSONDecodeError) as exc:
        print(f"oci_delta error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
