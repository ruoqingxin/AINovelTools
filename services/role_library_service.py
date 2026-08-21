# -*- coding: utf-8 -*-
"""角色库分类、旧目录迁移和原子角色保存。"""
from __future__ import annotations

import os
import tempfile
from pathlib import Path


class RoleLibraryService:
    ALL = "全部"
    UNCATEGORIZED = "未分类"

    def __init__(self, project_path):
        self.root = Path(project_path).resolve() / "角色库"

    def initialize(self) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        uncategorized = self.root / self.UNCATEGORIZED
        uncategorized.mkdir(exist_ok=True)
        legacy = self.root / self.ALL
        if legacy.is_dir():
            for item in legacy.iterdir():
                target = uncategorized / item.name
                if target.exists():
                    target = uncategorized / f"{item.stem}_旧版全部{item.suffix}"
                    counter = 1
                    while target.exists():
                        target = uncategorized / f"{item.stem}_旧版全部{counter}{item.suffix}"
                        counter += 1
                os.replace(item, target)
            if not any(legacy.iterdir()):
                legacy.rmdir()

    def categories(self) -> list[str]:
        self.initialize()
        real = sorted(path.name for path in self.root.iterdir() if path.is_dir() and path.name != self.ALL)
        return [self.ALL, *real]

    def actual_category(self, role_name: str, preferred: str | None = None) -> str:
        if preferred and preferred != self.ALL and self.role_path(preferred, role_name).exists():
            return preferred
        for category in self.categories()[1:]:
            if self.role_path(category, role_name).exists():
                return category
        raise FileNotFoundError(f"找不到角色 {role_name} 的实际存储位置")

    def role_path(self, category: str, role_name: str) -> Path:
        if category == self.ALL:
            category = self.UNCATEGORIZED
        if not category.strip() or not role_name.strip() or any(char in category + role_name for char in '/\\'):
            raise ValueError("角色名称或分类名称无效")
        target = (self.root / category / f"{role_name}.txt").resolve()
        try:
            target.relative_to(self.root)
        except ValueError as exc:
            raise ValueError("角色路径超出角色库") from exc
        return target

    def save(self, category: str, role_name: str, content: str) -> Path:
        path = self.role_path(category, role_name)
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                stream.write(content)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temp_name, path)
            return path
        except Exception:
            if os.path.exists(temp_name):
                os.unlink(temp_name)
            raise

    def move(self, role_name: str, source: str, target: str) -> str:
        source = self.actual_category(role_name, source)
        target = self.UNCATEGORIZED if target == self.ALL else target
        destination = self.role_path(target, role_name)
        if destination.exists():
            raise FileExistsError(f"角色已存在于分类 {target}")
        destination.parent.mkdir(parents=True, exist_ok=True)
        os.replace(self.role_path(source, role_name), destination)
        return target

    def rename(self, category: str, old_name: str, new_name: str, content: str) -> Path:
        old_path = self.role_path(category, old_name)
        new_path = self.role_path(category, new_name)
        if new_path.exists() and new_path != old_path:
            raise FileExistsError(f"角色 {new_name} 已存在")
        saved = self.save(category, new_name, content)
        if old_path != new_path and old_path.exists():
            old_path.unlink()
        return saved
