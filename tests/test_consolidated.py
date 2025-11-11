"""
Comprehensive consolidated tests for the backup daemon and journal.

This file collects the essential unit tests for:
- Journal append / replay behavior (copy and link entries)
- Journal get_incomplete semantics (started vs completed markers)
- SERVER metadata persistence (atomic write and refusal to overwrite with empty)
- Daemon operations: atomic copy and process_file metadata updates

Each test is documented with comments explaining the purpose and the
expected behavior. These tests are intentionally self-contained and
use temporary directories so they don't touch the developer's real data.
"""
import unittest
import tempfile
import os
import importlib.util
import json
import time
from concurrent.futures import ThreadPoolExecutor

# Load the daemon module by path so tests run regardless of working dir
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
MODULE_PATH = os.path.join(ROOT, 'static', 'py')
daemon_module_path = os.path.join(MODULE_PATH, 'daemon_new.py')
spec = importlib.util.spec_from_file_location('daemon_mod', daemon_module_path)
daemon_mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(daemon_mod)

Journal = daemon_mod.Journal
Daemon = daemon_mod.Daemon
SERVER = daemon_mod.SERVER
calculate_sha256 = daemon_mod.calculate_sha256


class ConsolidatedTests(unittest.TestCase):

    # ------------------------------------------------------------------
    # Journal: basic copy replay behavior
    # ------------------------------------------------------------------
    def test_copy_replay_moves_tmp_to_dst_and_marks_complete(self):
        """If a tmp file exists for a 'copy' entry, replay should move it
        atomically to the dst and mark the journal entry completed.
        """
        with tempfile.TemporaryDirectory() as td:
            j = Journal(td)

            # create a source file and compute its hash
            src = os.path.join(td, 'src.txt')
            with open(src, 'w', encoding='utf-8') as f:
                f.write('hello-journal')

            expected_hash = calculate_sha256(src)

            # prepare dst and tmp paths
            dst = os.path.join(td, 'backup', 'file.txt')
            tmpfile = dst + '.tmp_test'
            os.makedirs(os.path.dirname(tmpfile), exist_ok=True)

            # create a tmp file containing the expected content
            with open(tmpfile, 'w', encoding='utf-8') as f:
                f.write('hello-journal')

            # append an in-progress 'copy' entry (started)
            eid = j.append_entry('copy', {'src': src, 'dst': dst, 'tmp': tmpfile, 'hash': expected_hash})

            # run replay (daemon argument is optional for these tests)
            j.replay(None)

            # tmp should be moved to dst and entry completed
            self.assertTrue(os.path.exists(dst))
            self.assertFalse(os.path.exists(tmpfile))
            self.assertEqual(len(j.get_incomplete()), 0)

    # ------------------------------------------------------------------
    # Journal: link replay
    # ------------------------------------------------------------------
    def test_link_replay_creates_hardlink_and_marks_complete(self):
        """A 'link' journal entry should recreate a hardlink from src to dst
        during replay and then be marked completed.
        """
        with tempfile.TemporaryDirectory() as td:
            j = Journal(td)

            # create source file to link from
            src = os.path.join(td, 'orig', 'file.bin')
            os.makedirs(os.path.dirname(src), exist_ok=True)
            with open(src, 'wb') as f:
                f.write(b'link-content')

            dst = os.path.join(td, 'links', 'file.bin')

            # append a started 'link' entry
            eid = j.append_entry('link', {'src': src, 'dst': dst})

            j.replay(None)

            self.assertTrue(os.path.exists(dst))
            # verify it's a hardlink by checking inode equality
            self.assertEqual(os.stat(src).st_ino, os.stat(dst).st_ino)
            self.assertEqual(len(j.get_incomplete()), 0)

    # ------------------------------------------------------------------
    # Journal: corrupt tmp handling
    # ------------------------------------------------------------------
    def test_copy_replay_removes_corrupt_tmp_and_marks_complete(self):
        """If a tmp file is present but fails validation (wrong hash),
        replay should remove the tmp and mark the entry completed so
        a fresh copy will be attempted next run.
        """
        with tempfile.TemporaryDirectory() as td:
            j = Journal(td)

            src = os.path.join(td, 'src.txt')
            with open(src, 'w', encoding='utf-8') as f:
                f.write('original')

            expected_hash = calculate_sha256(src)

            dst = os.path.join(td, 'dst', 'file.txt')
            tmpfile = dst + '.tmp'
            os.makedirs(os.path.dirname(tmpfile), exist_ok=True)

            # create a corrupt tmp (different content)
            with open(tmpfile, 'w', encoding='utf-8') as f:
                f.write('corrupted-content')

            eid = j.append_entry('copy', {'src': src, 'dst': dst, 'tmp': tmpfile, 'hash': expected_hash})

            j.replay(None)

            # tmp removed, dst not created, entry considered resolved
            self.assertFalse(os.path.exists(tmpfile))
            self.assertFalse(os.path.exists(dst))
            self.assertEqual(len(j.get_incomplete()), 0)

    # ------------------------------------------------------------------
    # SERVER metadata persistence behavior
    # ------------------------------------------------------------------
    def test_server_save_metadata_writes_atomic_file(self):
        """Verify that SERVER.save_metadata writes an atomic metadata file
        and that the contents parse back to the same structure.
        """
        with tempfile.TemporaryDirectory() as td:
            srv = SERVER()
            srv.BACKUP_CONFIG['backup_path'] = td
            # ensure tests use our server instance
            daemon_mod.server = srv

            metadata = {'a.txt': {'path': os.path.join(td, 'a.txt'), 'mtime': 1, 'hash': 'abc'}}
            ok = srv.save_metadata(metadata)

            self.assertTrue(ok)
            meta_path = srv.METADATA_FILE
            self.assertTrue(os.path.exists(meta_path))
            with open(meta_path, 'r', encoding='utf-8') as f:
                loaded = json.load(f)
            self.assertEqual(loaded, metadata)

    def test_save_metadata_refuses_empty_overwrite(self):
        """If metadata file exists, calling save_metadata({}) should refuse
        to overwrite the existing data and return False (safety protection).
        """
        with tempfile.TemporaryDirectory() as td:
            srv = SERVER()
            srv.BACKUP_CONFIG['backup_path'] = td
            daemon_mod.server = srv

            meta = {'x.txt': {'path': os.path.join(td, 'x.txt'), 'mtime': 1, 'hash': 'h'}}
            ok = srv.save_metadata(meta)
            self.assertTrue(ok)

            # attempt to overwrite with empty dict should fail
            res = srv.save_metadata({})
            self.assertFalse(res)

            # original still present
            with open(srv.METADATA_FILE, 'r', encoding='utf-8') as f:
                loaded = json.load(f)
            self.assertEqual(loaded, meta)

    # ------------------------------------------------------------------
    # Daemon helpers: atomic copy and metadata update
    # ------------------------------------------------------------------
    def test_perform_atomic_copy_commits_and_journals(self):
        """Daemon._perform_atomic_copy should atomically commit a temp file
        into the destination and the journal should show no incomplete entries.
        """
        with tempfile.TemporaryDirectory() as td:
            srv = SERVER()
            srv.BACKUP_CONFIG['backup_path'] = td
            # Disable control socket for tests to avoid ResourceWarning
            srv.SOCKET_PATH = ""
            daemon_mod.server = srv

            d = Daemon()

            src = os.path.join(td, 'src.bin')
            with open(src, 'wb') as f:
                f.write(b'hello-world')

            dst = os.path.join(td, 'backup', 'file.bin')
            ok = d._perform_atomic_copy(src, dst, file_hash=calculate_sha256(src), file_size=os.path.getsize(src))

            self.assertTrue(ok)
            self.assertTrue(os.path.exists(dst))

            j = Journal(td)
            self.assertEqual(len(j.get_incomplete()), 0)

    def test_process_file_updates_metadata(self):
        """process_file should copy (or link) the file and update in-memory
        metadata with path, mtime, size and hash.
        """
        with tempfile.TemporaryDirectory() as td:
            srv = SERVER()
            srv.BACKUP_CONFIG['backup_path'] = td
            srv.BACKUP_CONFIG['source_path'] = os.path.join(td, 'src')
            os.makedirs(srv.BACKUP_CONFIG['source_path'], exist_ok=True)
            # disable control socket in tests
            srv.SOCKET_PATH = ""
            daemon_mod.server = srv

            d = Daemon()

            src_file = os.path.join(srv.BACKUP_CONFIG['source_path'], 'a.txt')
            with open(src_file, 'w', encoding='utf-8') as f:
                f.write('content')

            file_hash = calculate_sha256(src_file)
            rel_path = os.path.relpath(src_file, os.path.dirname(d.source_root))
            file_info = {
                'source_path': src_file,
                'rel_path': rel_path,
                'file_hash': file_hash,
                'size': os.path.getsize(src_file),
                'mtime': os.path.getmtime(src_file),
                'is_hardlink_candidate': False,
                'new_file': True,
            }

            ok = d.process_file(file_info)
            self.assertTrue(ok)
            self.assertIn(rel_path, d.metadata)
            self.assertEqual(d.metadata[rel_path].get('hash'), file_hash)

    # ------------------------------------------------------------------
    # Move detection: same content, different path
    # ------------------------------------------------------------------
    def test_move_detection_identifies_hardlink_candidate(self):
        """When a file is moved/renamed in the source tree but its content
        matches an already-backed-up file (same hash), the pre-flight scan
        should mark it as a hardlink candidate (is_hardlink_candidate=True).
        """
        with tempfile.TemporaryDirectory() as td:
            srv = SERVER()
            srv.BACKUP_CONFIG['backup_path'] = td
            srv.BACKUP_CONFIG['source_path'] = os.path.join(td, 'src')
            os.makedirs(srv.BACKUP_CONFIG['source_path'], exist_ok=True)
            # ensure main backup folder exists
            os.makedirs(srv.main_backup_folder(), exist_ok=True)
            daemon_mod.server = srv

            # Create an existing backed-up file (simulates previously backed-up content)
            rel_old = os.path.join(os.path.basename(srv.BACKUP_CONFIG['source_path']), 'orig.txt')
            existing_backup_path = os.path.join(srv.main_backup_folder(), rel_old)
            os.makedirs(os.path.dirname(existing_backup_path), exist_ok=True)
            with open(existing_backup_path, 'w', encoding='utf-8') as f:
                f.write('same-content')
            expected_hash = calculate_sha256(existing_backup_path)

            # Persist metadata that maps the old rel path to the existing backup path
            metadata = {rel_old: {'path': existing_backup_path, 'mtime': os.path.getmtime(existing_backup_path), 'hash': expected_hash}}
            srv.save_metadata(metadata)

            # Now create a new source file in a different name but same content
            new_source = os.path.join(srv.BACKUP_CONFIG['source_path'], 'moved_to.txt')
            with open(new_source, 'w', encoding='utf-8') as f:
                f.write('same-content')

            # Run daemon pre-flight scan and ensure the new file is detected as hardlink candidate
            d = Daemon()
            d._pre_flight_scan()

            # find the file entry for our new source
            found = None
            for entry in d.files_to_backup:
                if entry['source_path'] == new_source:
                    found = entry
                    break

            self.assertIsNotNone(found, 'pre-flight should include the moved file')
            self.assertEqual(found['file_hash'], expected_hash)
            self.assertTrue(found['is_hardlink_candidate'], 'moved file with same content should be hardlink candidate')

    # ------------------------------------------------------------------
    # Cancellation, batching and failure-mode tests
    # ------------------------------------------------------------------
    def test_cancel_before_start_prevents_processing(self):
        """If the daemon's cancel_event is set before a file is started,
        process_file should return False and not update metadata.
        """
        with tempfile.TemporaryDirectory() as td:
            srv = SERVER()
            srv.BACKUP_CONFIG['backup_path'] = td
            srv.BACKUP_CONFIG['source_path'] = os.path.join(td, 'src')
            os.makedirs(srv.BACKUP_CONFIG['source_path'], exist_ok=True)
            srv.SOCKET_PATH = ""
            daemon_mod.server = srv

            d = Daemon()
            # create source file
            src_file = os.path.join(srv.BACKUP_CONFIG['source_path'], 'b.txt')
            with open(src_file, 'w', encoding='utf-8') as f:
                f.write('data')

            d.cancel_event.set()

            file_info = {
                'source_path': src_file,
                'rel_path': os.path.relpath(src_file, os.path.dirname(d.source_root)),
                'file_hash': calculate_sha256(src_file),
                'size': os.path.getsize(src_file),
                'mtime': os.path.getmtime(src_file),
                'is_hardlink_candidate': False,
                'new_file': True,
            }

            ok = d.process_file(file_info)
            self.assertFalse(ok)
            self.assertNotIn(file_info['rel_path'], d.metadata)

    def test_metadata_flush_batching_behavior(self):
        """Validate metadata flush batching: when metadata_flush_every > 1 the
        daemon will not call save_metadata on every update; when set to 1 it
        should call save_metadata immediately.
        """
        with tempfile.TemporaryDirectory() as td:
            srv = SERVER()
            srv.BACKUP_CONFIG['backup_path'] = td
            srv.SOCKET_PATH = ""
            daemon_mod.server = srv

            d = Daemon()
            # replace server.save_metadata with a counter wrapper
            calls = []
            def saver(meta):
                calls.append(1)
                return True
            srv.save_metadata = saver

            # set batching > 1 (no immediate flush expected)
            d.metadata_flush_every = 2
            d._update_metadata('p1', os.path.join(td, 'p1'), {'mtime': 1, 'size': 1, 'file_hash': 'h'})
            self.assertEqual(len(calls), 0)

            # when threshold is 1 we expect an immediate save
            d.metadata_flush_every = 1
            d._update_metadata('p2', os.path.join(td, 'p2'), {'mtime': 1, 'size': 1, 'file_hash': 'h'})
            self.assertEqual(len(calls), 1)

    def test_journal_fsync_batching_appends_entries(self):
        """Ensure journal can append many entries when fsync batching is enabled
        (we check entries count rather than low-level fsyncs here).
        """
        with tempfile.TemporaryDirectory() as td:
            j = Journal(td)
            j.fsync_every = 100  # batch fsyncs
            # append and complete multiple entries
            for i in range(10):
                eid = j.append_entry('copy', {'src': f'src{i}', 'dst': f'dst{i}', 'tmp': f'tmp{i}'})
                j.mark_completed(eid)

            # journal file should contain 20 lines (10 started + 10 completed)
            with open(j.path, 'r', encoding='utf-8') as f:
                lines = [l for l in f if l.strip()]
            self.assertEqual(len(lines), 20)

    def test_save_metadata_restore_on_replace_failure(self):
        """Simulate os.replace failing during save_metadata and verify the
        method returns False and the original metadata file remains intact.
        """
        with tempfile.TemporaryDirectory() as td:
            srv = SERVER()
            srv.BACKUP_CONFIG['backup_path'] = td
            srv.SOCKET_PATH = None
            daemon_mod.server = srv

            # create initial metadata file
            orig = {'orig.txt': {'path': os.path.join(td, 'orig.txt'), 'mtime': 1, 'hash': 'h'}}
            ok = srv.save_metadata(orig)
            self.assertTrue(ok)

            # monkeypatch os.replace to raise to simulate failure
            orig_replace = os.replace
            def raise_replace(a, b):
                raise OSError('simulated replace failure')
            os.replace = raise_replace
            try:
                res = srv.save_metadata({'new': 'meta'})
                self.assertFalse(res)
            finally:
                os.replace = orig_replace

            # original metadata should still be present
            with open(srv.METADATA_FILE, 'r', encoding='utf-8') as f:
                loaded = json.load(f)
            self.assertEqual(loaded, orig)

    # def test_save_metadata_creates_backup_and_cleans_oldest(self):
    #     """save_metadata should create a .bak and clean up old backups."""
    #     with tempfile.TemporaryDirectory() as td:
    #         srv = SERVER()
    #         srv.BACKUP_CONFIG['backup_path'] = td
    #         srv.BACKUP_CONFIG['meta_backup_keep'] = 2
    #         daemon_mod.server = srv

    #         # create initial metadata file
    #         meta = {'a.txt': {'path': os.path.join(td, 'a.txt'), 'mtime': 1, 'hash': 'abc'}}#
    #         ok = srv.save_metadata(meta)
    #         self.assertTrue(ok)

    #         # Create a few backups
    #         meta_path = srv.METADATA_FILE
    #         backup_files = []
    #         for i in range(3):
    #             ok = srv.save_metadata({'b.txt': {'path': os.path.join(td, 'b.txt'), 'mtime': 1, 'hash': 'def'}})#
    #             self.assertTrue(ok)
    #             # collect generated .bak files
    #             backup_files = [p for p in os.listdir(td) if p.startswith(os.path.basename(meta_path) + ".bak")]

    #         # metadata file should exist
    #         self.assertTrue(os.path.exists(meta_path))
    #         # two backups should remain after cleanup
    #         self.assertEqual(len(backup_files), 2)

    # def test_save_metadata_backup_disabled(self):#
    #     """save_metadata should not create a backup if create_meta_backup=False."""
    #     import os

    #     with tempfile.TemporaryDirectory() as td:
    #         srv = SERVER()
    #         srv.BACKUP_CONFIG['backup_path'] = td
    #         srv.BACKUP_CONFIG['create_meta_backup'] = False
    #         daemon_mod.server = srv

    #         # create initial metadata file
    #         meta = {'a.txt': {'path': os.path.join(td, 'a.txt'), 'mtime': 1, 'hash': 'abc'}}#
    #         ok = srv.save_metadata(meta)
    #         self.assertTrue(ok)

    #         # Call save_metadata again
    #         ok = srv.save_metadata({'b.txt': {'path': os.path.join(td, 'b.txt'), 'mtime': 1, 'hash': 'def'}})#
    #         self.assertTrue(ok)

    #         # Check if backup file was created
    #         self.assertFalse(any(f.startswith("._backup_meta.json.bak") for f in os.listdir(td)))


if __name__ == '__main__':
    unittest.main()
