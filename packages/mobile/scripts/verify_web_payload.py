"""Compare compiled web files with a native package without extracting the package."""

import hashlib
from pathlib import Path


def verify_web_payload(web_dir, open_packaged):
    web_dir = Path(web_dir)
    if web_dir.is_symlink() or not web_dir.is_dir():
        raise ValueError(f"Compiled web directory is unavailable or linked: {web_dir}")
    files = []
    for source in sorted(web_dir.rglob("*")):
        if source.is_symlink():
            raise ValueError(f"Compiled web payload contains a symlink: {source}")
        if source.is_file():
            files.append(source)
        elif not source.is_dir():
            raise ValueError(f"Compiled web payload contains a non-regular file: {source}")
    if web_dir / "index.html" not in files:
        raise ValueError("Compiled web payload is missing index.html")
    index_hash = None
    for source in files:
        relative = source.relative_to(web_dir).as_posix()
        try:
            packaged = open_packaged(relative)
        except (FileNotFoundError, IsADirectoryError, KeyError) as error:
            raise ValueError(f"Missing packaged web asset: {relative}") from error
        digest = hashlib.sha256()
        with source.open("rb") as expected, packaged:
            for chunk in iter(lambda: expected.read(1024 * 1024), b""):
                if packaged.read(len(chunk)) != chunk:
                    raise ValueError(f"Packaged web asset differs from compiled source: {relative}")
                digest.update(chunk)
            if packaged.read(1):
                raise ValueError(f"Packaged web asset differs from compiled source: {relative}")
        if relative == "index.html":
            index_hash = digest.hexdigest()
    return {"fileCount": len(files), "indexSHA256": index_hash, "byteIdentical": True}
