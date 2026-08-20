# -*- coding: utf-8 -*-
"""兼容当前工程文件布局的最小 Repository。"""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any


class RepositoryPathError(ValueError):
    """请求的路径越出工程根目录。"""


class NovelProjectRepository:
    def __init__(self, project_path: str | os.PathLike[str]):
        self.root = Path(project_path).expanduser().resolve()

    def path_for(self, relative_name: str | os.PathLike[str]) -> Path:
        candidate = (self.root / relative_name).resolve()
        try:
            candidate.relative_to(self.root)
        except ValueError as exc:
            raise RepositoryPathError(relative_name) from exc
        return candidate

    def read_text(self, relative_name: str, default: str = "") -> str:
        path = self.path_for(relative_name)
        try:
            return path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return default

    def write_text(self, relative_name: str, content: str) -> bool:
        return self._write_atomic(self.path_for(relative_name), content, binary=False)

    def read_json(self, relative_name: str, default: Any = None) -> Any:
        text = self.read_text(relative_name, "")
        if not text.strip():
            return default
        return json.loads(text)

    def write_json(self, relative_name: str, value: Any) -> bool:
        content = json.dumps(value, ensure_ascii=False, indent=2) + "\n"
        return self.write_text(relative_name, content)

    def chapter_path(self, chapter_number: int) -> Path:
        if chapter_number < 1:
            raise ValueError("章节号必须大于 0")
        return self.path_for(Path("chapters") / f"chapter_{chapter_number}.txt")

    def read_chapter(self, chapter_number: int) -> str:
        try:
            return self.chapter_path(chapter_number).read_text(encoding="utf-8")
        except FileNotFoundError:
            return ""

    def write_chapter(self, chapter_number: int, content: str) -> bool:
        return self._write_atomic(self.chapter_path(chapter_number), content, binary=False)

    def list_chapters(self) -> list[int]:
        chapters_dir = self.path_for("chapters")
        if not chapters_dir.is_dir():
            return []
        result = []
        for path in chapters_dir.glob("chapter_*.txt"):
            try:
                result.append(int(path.stem.removeprefix("chapter_")))
            except ValueError:
                continue
        return sorted(set(result))

    @staticmethod
    def _write_atomic(path: Path, content: str, binary: bool) -> bool:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
        try:
            mode = "wb" if binary else "w"
            with os.fdopen(fd, mode, encoding=None if binary else "utf-8") as stream:
                stream.write(content)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temp_name, path)
            return True
        except Exception:
            try:
                os.unlink(temp_name)
            except OSError:
                pass
            return False
