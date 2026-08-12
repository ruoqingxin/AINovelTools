import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from novel_generator.storage import NovelProjectRepository
from ai_cancellation import CancellationToken, OperationCancelled, reset_current_token, set_current_token


class NovelProjectRepositoryTest(unittest.TestCase):
    def test_rejects_paths_outside_project(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            repository = NovelProjectRepository(temp_dir)

            with self.assertRaises(ValueError):
                repository.path("../outside.txt")

    def test_write_many_restores_previous_files_on_failure(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            repository = NovelProjectRepository(temp_dir)
            repository.write("first.txt", "old first")
            repository.write("second.txt", "old second")
            original_write = NovelProjectRepository._write_atomic
            calls = 0

            def fail_second(path: Path, content: str):
                nonlocal calls
                calls += 1
                if calls == 2:
                    raise OSError("simulated write failure")
                original_write(path, content)

            with patch.object(NovelProjectRepository, "_write_atomic", side_effect=fail_second):
                with self.assertRaises(OSError):
                    repository.write_many({
                        "first.txt": "new first",
                        "second.txt": "new second",
                    })

            self.assertEqual(repository.read("first.txt"), "old first")
            self.assertEqual(repository.read("second.txt"), "old second")

    def test_cancelled_operation_cannot_write_project_files(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            repository = NovelProjectRepository(temp_dir)
            token = CancellationToken()
            context_token = set_current_token(token)
            try:
                token.cancel()
                with self.assertRaises(OperationCancelled):
                    repository.write("chapter.txt", "late AI result")
            finally:
                reset_current_token(context_token)

            self.assertFalse(repository.path("chapter.txt").exists())


if __name__ == "__main__":
    unittest.main()
