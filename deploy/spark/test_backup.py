import importlib.util
from contextlib import closing
from pathlib import Path
import sqlite3
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("spark_backup", Path(__file__).with_name("backup.py"))
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)


class BackupTest(unittest.TestCase):
    def test_restores_committed_wal_rows_and_asset_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            source.mkdir()
            database = source / "open_ai_canvas.db"
            origin = sqlite3.connect(database)
            try:
                origin.execute("PRAGMA journal_mode=WAL")
                origin.execute("PRAGMA wal_autocheckpoint=0")
                origin.execute("CREATE TABLE shots (id TEXT PRIMARY KEY, asset TEXT)")
                origin.execute("INSERT INTO shots VALUES ('shot-1', 'assets/frame.png')")
                origin.commit()
                (source / "assets").mkdir()
                (source / "assets" / "frame.png").write_bytes(b"reference-image")
                self.assertTrue(Path(str(database) + "-wal").exists())
                target = root / "snapshot"
                self.assertEqual(backup.snapshot_tree(source, target), 1)
                # Restore into a separate location; the source remains untouched.
                restored = root / "restore"
                self.assertEqual(backup.snapshot_tree(target, restored), 1)
                with closing(sqlite3.connect(restored / database.name)) as connection:
                    self.assertEqual(connection.execute("SELECT * FROM shots").fetchall(),
                                     [("shot-1", "assets/frame.png")])
                    self.assertEqual(connection.execute("PRAGMA integrity_check").fetchone(), ("ok",))
                self.assertEqual((restored / "assets" / "frame.png").read_bytes(), b"reference-image")
                self.assertFalse(Path(str(target / database.name) + "-wal").exists())
                self.assertEqual(origin.execute("SELECT count(*) FROM shots").fetchone(), (1,))
            finally:
                origin.close()

    def test_refuses_overwrite_and_invalid_database(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            source.mkdir()
            existing = root / "existing"
            existing.mkdir()
            with self.assertRaises(FileExistsError):
                backup.snapshot_tree(source, existing)
            (source / "broken.db").write_bytes(b"not a database")
            with self.assertRaises(ValueError):
                backup.snapshot_tree(source, root / "invalid")


if __name__ == "__main__":
    unittest.main()
