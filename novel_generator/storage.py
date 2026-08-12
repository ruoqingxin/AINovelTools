import os
import tempfile
from pathlib import Path
from typing import Mapping
from ai_cancellation import raise_if_cancelled


class NovelProjectRepository:
    """小说工程的文件边界，负责安全路径与原子写入。"""

    ARCHITECTURE = "Novel_architecture.txt"
    DIRECTORY = "Novel_directory.txt"
    GLOBAL_SUMMARY = "global_summary.txt"
    CHARACTER_STATE = "character_state.txt"
    PLOT_ARCS = "plot_arcs.txt"

    def __init__(self, root):
        if not str(root).strip():
            raise ValueError("小说工程路径不能为空")
        self.root = Path(root).expanduser().resolve()

    def ensure_exists(self) -> None:
        self.root.mkdir(parents=True, exist_ok=True)

    def path(self, relative_path: str) -> Path:
        candidate = (self.root / relative_path).resolve()
        try:
            candidate.relative_to(self.root)
        except ValueError as exc:
            raise ValueError(f"路径超出小说工程目录: {relative_path}") from exc
        return candidate

    def chapter_path(self, chapter_number: int) -> Path:
        if chapter_number < 1:
            raise ValueError("章节号必须大于 0")
        return self.path(f"chapters/chapter_{chapter_number}.txt")

    def chapter_revision_source_path(self, chapter_number: int) -> Path:
        if chapter_number < 1:
            raise ValueError("章节号必须大于 0")
        return self.path(f"chapters/revisions/chapter_{chapter_number}_before.txt")

    def read(self, relative_path: str, default: str = "") -> str:
        path = self.path(relative_path)
        if not path.exists():
            return default
        return path.read_text(encoding="utf-8")

    def read_chapter(self, chapter_number: int) -> str:
        path = self.chapter_path(chapter_number)
        if not path.exists():
            return ""
        return path.read_text(encoding="utf-8")

    def read_chapter_revision_source(self, chapter_number: int) -> str:
        path = self.chapter_revision_source_path(chapter_number)
        if not path.exists():
            return ""
        return path.read_text(encoding="utf-8")

    def write(self, relative_path: str, content: str) -> Path:
        raise_if_cancelled()
        path = self.path(relative_path)
        self._write_atomic(path, content)
        return path

    def write_chapter(self, chapter_number: int, content: str) -> Path:
        raise_if_cancelled()
        path = self.chapter_path(chapter_number)
        self._write_atomic(path, content)
        return path

    def write_chapter_revision_pair(
        self,
        chapter_number: int,
        before_content: str,
        revised_content: str,
    ) -> tuple[Path, ...]:
        """Atomically persist the comparison snapshot and current chapter."""
        return self.write_many({
            f"chapters/revisions/chapter_{chapter_number}_before.txt": before_content,
            f"chapters/chapter_{chapter_number}.txt": revised_content,
        })

    def clear_chapter_revision_source(self, chapter_number: int) -> None:
        self.chapter_revision_source_path(chapter_number).unlink(missing_ok=True)

    def write_many(self, files: Mapping[str, str]) -> tuple[Path, ...]:
        """写入一组文件；任何一步失败时恢复写入前的内容。"""
        raise_if_cancelled()
        targets = {self.path(name): content for name, content in files.items()}
        previous = {
            path: path.read_bytes() if path.exists() else None
            for path in targets
        }
        written = []
        try:
            for path, content in targets.items():
                raise_if_cancelled()
                self._write_atomic(path, content)
                written.append(path)
        except BaseException:
            for path in reversed(written):
                old_content = previous[path]
                if old_content is None:
                    path.unlink(missing_ok=True)
                else:
                    self._write_bytes_atomic(path, old_content)
            raise
        return tuple(targets)

    @staticmethod
    def _write_atomic(path: Path, content: str) -> None:
        NovelProjectRepository._write_bytes_atomic(path, content.encode("utf-8"))

    @staticmethod
    def _write_bytes_atomic(path: Path, content: bytes) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, temp_path = tempfile.mkstemp(suffix=".tmp", dir=str(path.parent))
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(content)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temp_path, path)
        except Exception:
            if os.path.exists(temp_path):
                os.unlink(temp_path)
            raise
