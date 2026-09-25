import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("build_llama", Path(__file__).with_name("build-llama.py"))
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)


class BuildValidationTest(unittest.TestCase):
    def test_reads_repository_pin_without_executing_shell_content(self):
        pin = build.read_pin(build.ENGINE / "VERSION")
        self.assertEqual(40, len(pin["commit"]))
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "VERSION"
            for invalid in ("0" * 40, "$(echo unsafe)", "abc123"):
                path.write_text(f"upstream=https://example.org\ntag=v0.4.1\nbuild=10\ncommit={invalid}\n")
                with self.assertRaises(ValueError):
                    build.read_pin(path)

    def test_wrong_commit_or_truncated_ancestry_is_rejected(self):
        pin = {"commit": "a" * 40, "build": "123"}
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory)
            (source / ".git").mkdir()
            with patch.object(build, "run", return_value="b" * 40):
                with self.assertRaisesRegex(ValueError, "does not match"):
                    build.verify_source(source, pin)
            with patch.object(build, "run", side_effect=["a" * 40, "1"]):
                with self.assertRaisesRegex(ValueError, "fetch full ancestry"):
                    build.verify_source(source, pin)
            with patch.object(build, "run", side_effect=["a" * 40, "123"]):
                build.verify_source(source, pin)

    def test_android_checks_every_load_segment(self):
        build.verify_elf_alignment("  LOAD 0x000000 0x0000 0x0000 0x1000 0x1000 R E 0x4000\n")
        for invalid in ("", "LOAD 0x0 0x0 0x0 0x1000 0x1000 RW 0x1000",
                        "LOAD 0x0 0x0 0x0 0x1000 0x1000 R 0x4000\nLOAD 0x0 0x0 0x0 0x1000 0x1000 RW 0x1000"):
            with self.assertRaises(ValueError):
                build.verify_elf_alignment(invalid)

    def test_android_rejects_unbundled_or_versioned_shared_libraries(self):
        build.verify_elf_dependencies("0x1 (NEEDED) Shared library: [libc.so]\n0x1 (NEEDED) Shared library: [libggml.so]", ["libggml.so"])
        for name in ("libomp.so", "libggml.so.0", "libc++_shared.so"):
            with self.assertRaisesRegex(ValueError, "unbundled dependencies"):
                build.verify_elf_dependencies(f"0x1 (NEEDED) Shared library: [{name}]", ["libggml.so"])


if __name__ == "__main__":
    unittest.main()
