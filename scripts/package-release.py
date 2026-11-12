#!/usr/bin/env python3
"""Reproducible Linux x86_64 runtime packager for patched Chromium releases."""
from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile

FIXED_MTIME = 1700000000

REQUIRED_BINARIES = [
    ("chrome", "chrome", 0o755),
    ("chrome_crashpad_handler", "chrome_crashpad_handler", 0o755),
    ("chrome_sandbox", "chrome-sandbox", 0o755),
]

OPTIONAL_BINARIES = [
    ("chrome_management_service", "chrome-management-service", 0o755),
    ("libEGL.so", "libEGL.so", 0o644),
    ("libGLESv2.so", "libGLESv2.so", 0o644),
    ("libvk_swiftshader.so", "libvk_swiftshader.so", 0o644),
    ("libvulkan.so.1", "libvulkan.so.1", 0o644),
    ("libqt5_shim.so", "libqt5_shim.so", 0o644),
    ("libqt6_shim.so", "libqt6_shim.so", 0o644),
    ("liboptimization_guide_internal.so", "liboptimization_guide_internal.so", 0o644),
    ("libLiteRtWebGpuAccelerator.so", "libLiteRtWebGpuAccelerator.so", 0o644),
]

REQUIRED_RESOURCES = [
    "icudtl.dat",
    "resources.pak",
    "chrome_100_percent.pak",
    "chrome_200_percent.pak",
    "v8_context_snapshot.bin",
]

OPTIONAL_RESOURCES = [
    "vk_swiftshader_icd.json",
    "MEIPreload/manifest.json",
    "MEIPreload/preloaded_data.pb",
]


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def find_strip_tool(build_dir: Path) -> str:
    llvm_strip = (
        build_dir.parent.parent
        / "third_party/llvm-build/Release+Asserts/bin/llvm-strip"
    )
    if llvm_strip.is_file():
        return str(llvm_strip)
    system_strip = shutil.which("llvm-strip") or shutil.which("strip")
    if not system_strip:
        raise RuntimeError("Neither llvm-strip nor strip found")
    return system_strip


def stage_release(build_dir: Path, stage_dir: Path) -> list[dict]:
    strip_bin = find_strip_tool(build_dir)
    manifest_entries: list[dict] = []

    def add_binary(src_rel: str, dst_rel: str, mode: int, required: bool) -> None:
        src = build_dir / src_rel
        if not src.is_file():
            if required:
                raise FileNotFoundError(f"Missing required binary: {src}")
            return
        dst = stage_dir / dst_rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            [strip_bin, "--strip-unneeded", "-o", str(dst), str(src)],
            check=True,
        )
        dst.chmod(mode)

    def add_resource(rel: str, required: bool) -> None:
        src = build_dir / rel
        if not src.is_file():
            if required:
                raise FileNotFoundError(f"Missing required resource: {src}")
            return
        dst = stage_dir / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dst)
        dst.chmod(0o644)

    for src_rel, dst_rel, mode in REQUIRED_BINARIES:
        add_binary(src_rel, dst_rel, mode, required=True)
    for src_rel, dst_rel, mode in OPTIONAL_BINARIES:
        add_binary(src_rel, dst_rel, mode, required=False)

    for rel in REQUIRED_RESOURCES:
        add_resource(rel, required=True)
    for rel in OPTIONAL_RESOURCES:
        add_resource(rel, required=False)

    locales_dir = build_dir / "locales"
    if not locales_dir.is_dir():
        raise FileNotFoundError(f"Missing locales directory: {locales_dir}")
    for pak in sorted(locales_dir.glob("*.pak")):
        add_resource(f"locales/{pak.name}", required=True)

    for opt_dir_name in ("angledata", "IwaKeyDistribution"):
        opt_dir = build_dir / opt_dir_name
        if opt_dir.is_dir():
            for child in sorted(opt_dir.rglob("*")):
                if child.is_file():
                    rel = str(child.relative_to(build_dir))
                    add_resource(rel, required=False)

    for path in sorted(stage_dir.rglob("*")):
        if path.is_file():
            rel = path.relative_to(stage_dir).as_posix()
            mode = path.stat().st_mode & 0o777
            manifest_entries.append(
                {
                    "path": rel,
                    "mode": oct(mode),
                    "size_bytes": path.stat().st_size,
                    "sha256": sha256_file(path),
                }
            )
    return manifest_entries


def write_deterministic_targz(stage_dir: Path, archive_path: Path) -> None:
    archive_path.parent.mkdir(parents=True, exist_ok=True)
    with archive_path.open("wb") as raw_f:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw_f, compresslevel=6, mtime=0) as gz_f:
            with tarfile.open(mode="w", fileobj=gz_f, format=tarfile.PAX_FORMAT) as tf:
                dirs_added: set[str] = set()
                for item in sorted(stage_dir.rglob("*")):
                    if not item.is_file():
                        continue
                    rel = item.relative_to(stage_dir).as_posix()
                    parent_parts = rel.split("/")[:-1]
                    for idx in range(1, len(parent_parts) + 1):
                        d_rel = "/".join(parent_parts[:idx])
                        if d_rel not in dirs_added:
                            ti_dir = tarfile.TarInfo(name=d_rel)
                            ti_dir.type = tarfile.DIRTYPE
                            ti_dir.mode = 0o755
                            ti_dir.mtime = FIXED_MTIME
                            ti_dir.uid = 0
                            ti_dir.gid = 0
                            ti_dir.uname = ""
                            ti_dir.gname = ""
                            tf.addfile(ti_dir)
                            dirs_added.add(d_rel)

                    stat_res = item.stat()
                    ti = tarfile.TarInfo(name=rel)
                    ti.type = tarfile.REGTYPE
                    ti.size = stat_res.st_size
                    ti.mode = 0o755 if (stat_res.st_mode & 0o111) else 0o644
                    ti.mtime = FIXED_MTIME
                    ti.uid = 0
                    ti.gid = 0
                    ti.uname = ""
                    ti.gname = ""
                    with item.open("rb") as src_f:
                        tf.addfile(ti, src_f)


def collect_patch_hashes(repo_root: Path) -> list[dict]:
    patches: list[dict] = []
    for series_rel in ("patches/chromium/series", "patches/v8/series"):
        series_path = repo_root / series_rel
        if not series_path.is_file():
            continue
        base_dir = series_path.parent
        for line in series_path.read_text(encoding="utf-8").splitlines():
            name = line.strip()
            if not name or name.startswith("#"):
                continue
            p = base_dir / name
            patches.append(
                {
                    "path": p.relative_to(repo_root).as_posix(),
                    "sha256": sha256_file(p),
                }
            )
    return patches


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--build-dir", required=True, type=Path, help="Path to Chromium out/Release")
    parser.add_argument("--out-dir", required=True, type=Path, help="Destination release directory")
    parser.add_argument("--tag", required=True, help="Release tag, e.g. chromium-157.0.8103.50-r1")
    parser.add_argument(
        "--repository",
        default="idawnlight/chromium_antidetect_patch",
        help="GitHub owner/repo hosting the release",
    )
    args = parser.parse_args()

    repo_root = Path(__file__).resolve().parent.parent
    baseline = json.loads((repo_root / "baseline.json").read_text(encoding="utf-8"))
    version = baseline["version"]

    out_dir = args.out_dir.resolve()
    if out_dir.exists():
        raise FileExistsError(f"Output directory already exists: {out_dir}")
    out_dir.mkdir(parents=True)

    archive_name = f"chromium-{version}-stealth-linux-x86_64.tar.gz"
    archive_path = out_dir / archive_name

    with tempfile.TemporaryDirectory(prefix="chr-stage-") as tmp:
        stage_dir = Path(tmp) / "payload"
        stage_dir.mkdir()
        payload_files = stage_release(args.build_dir.resolve(), stage_dir)
        write_deterministic_targz(stage_dir, archive_path)

    archive_sha256 = sha256_file(archive_path)
    archive_size = archive_path.stat().st_size
    patch_hashes = collect_patch_hashes(repo_root)

    seal = {
        "schema": 1,
        "engine": "chromium",
        "tag": args.tag,
        "version": version,
        "milestone": baseline["milestone"],
        "source_commit": baseline["commit"],
        "v8_commit": baseline["dependencies"]["v8"],
        "repository": args.repository,
        "assets": {
            "linux-x86_64": {
                "name": archive_name,
                "url": f"https://github.com/{args.repository}/releases/download/{args.tag}/{archive_name}",
                "size_bytes": archive_size,
                "sha256": archive_sha256,
                "entry_rel": "chrome",
            }
        },
    }
    seal_path = out_dir / "seal.json"
    seal_path.write_text(json.dumps(seal, indent=2) + "\n", encoding="utf-8")

    provenance = {
        "schema": 1,
        "tag": args.tag,
        "version": version,
        "upstream_commit": baseline["commit"],
        "dependencies": baseline["dependencies"],
        "patches": patch_hashes,
        "archive": {
            "name": archive_name,
            "size_bytes": archive_size,
            "sha256": archive_sha256,
        },
        "payload_file_count": len(payload_files),
        "payload_files": payload_files,
    }
    provenance_path = out_dir / "provenance.json"
    provenance_path.write_text(json.dumps(provenance, indent=2) + "\n", encoding="utf-8")

    sums_lines = []
    for fname in sorted([archive_name, "seal.json", "provenance.json"]):
        sums_lines.append(f"{sha256_file(out_dir / fname)}  {fname}")
    sums_path = out_dir / "SHA256SUMS"
    sums_path.write_text("\n".join(sums_lines) + "\n", encoding="utf-8")

    print(
        json.dumps(
            {
                "out_dir": str(out_dir),
                "archive": archive_name,
                "size_mib": round(archive_size / (1024 * 1024), 2),
                "sha256": archive_sha256,
                "payload_files": len(payload_files),
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
