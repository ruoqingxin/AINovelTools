import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from novel_generator.storage import NovelProjectRepository


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


if __name__ == "__main__":
    unittest.main()
