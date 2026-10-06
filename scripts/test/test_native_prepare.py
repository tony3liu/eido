import importlib.util
import json
from pathlib import Path
import tarfile
import tempfile
import unittest


class NativePrepareTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="eido-native-prepare-test-")
        self.root = Path(self.temporary.name)
        spec = importlib.util.spec_from_file_location("native_prepare", Path(__file__).parents[1] / "native.py")
        self.native = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.native)
        for name, value in {
            "ROOT": self.root,
            "LOCAL": self.root / ".local",
            "SOURCE": self.root / ".local/upstream/zed",
            "MANIFEST": self.root / "native/zed.json",
            "STATE": self.root / ".local/native-applied.json",
        }.items():
            setattr(self.native, name, value)
        self.overlay = self.root / "native/overlay"
        self.overlay.mkdir(parents=True)
        self.removed = self.root / "native/removed-paths.json"
        source = self.root / "fixture"
        source.mkdir()
        (source / "legacy.rs").write_text("legacy code\n")
        archive = self.root / ".local/downloads/fixture.tar.gz"
        archive.parent.mkdir(parents=True)
        with tarfile.open(archive, "w:gz") as tar:
            tar.add(source, arcname="upstream")
        self.native.MANIFEST.write_text(json.dumps({
            "archiveName": archive.name, "sha256": self.native.digest(archive),
            "tag": "fixture", "commit": "local",
        }))
        self.removed.write_text("[]")

    def tearDown(self):
        self.temporary.cleanup()

    def delete_legacy(self):
        self.removed.write_text(json.dumps(["legacy.rs"]))

    def test_deletion_is_applied_repeatedly_and_removal_reversal_restores_upstream(self):
        self.native.prepare()
        self.delete_legacy()
        self.native.prepare()
        self.native.prepare()
        self.assertFalse((self.native.SOURCE / "legacy.rs").exists())
        self.removed.write_text("[]")
        self.native.prepare()
        self.assertEqual((self.native.SOURCE / "legacy.rs").read_text(), "legacy code\n")

    def test_removed_overlay_file_disappears_from_generated_source(self):
        (self.overlay / "bridge.rs").write_text("retired bridge\n")
        self.native.prepare()
        (self.overlay / "bridge.rs").unlink()
        self.native.prepare()
        self.assertFalse((self.native.SOURCE / "bridge.rs").exists())

    def test_deletion_refuses_to_discard_unmanaged_edits(self):
        self.native.prepare()
        modified = self.native.SOURCE / "legacy.rs"
        modified.write_text("manual work must survive\n")
        self.delete_legacy()
        with self.assertRaisesRegex(RuntimeError, "edits outside the overlay"):
            self.native.prepare()
        self.assertEqual(modified.read_text(), "manual work must survive\n")


    def test_full_source_and_lockfile_are_direct_build_inputs(self):
        (self.overlay / "legacy.rs").write_text("native Eido implementation\n")
        (self.overlay / "Cargo.lock").write_text("pinned lockfile\n")
        self.native.prepare()
        self.assertEqual((self.native.SOURCE / "legacy.rs").read_text(), "native Eido implementation\n")
        self.assertEqual((self.native.SOURCE / "Cargo.lock").read_text(), "pinned lockfile\n")
        (self.overlay / "legacy.rs").unlink()
        self.native.prepare()
        self.assertEqual((self.native.SOURCE / "legacy.rs").read_text(), "legacy code\n")

    def test_removal_rejects_path_escape_and_source_overlap(self):
        self.removed.write_text('["../outside.rs"]')
        with self.assertRaisesRegex(RuntimeError, "Invalid native removal"):
            self.native.prepare()
        self.delete_legacy()
        (self.overlay / "legacy.rs").write_text("preserve me\n")
        with self.assertRaisesRegex(RuntimeError, "both maintained and removed"):
            self.native.prepare()


if __name__ == "__main__":
    unittest.main()
