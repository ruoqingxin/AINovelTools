from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class OperationResult:
    """统一表示一个工作流步骤的结果。"""

    success: bool
    message: str
    data: Any = None
    artifacts: tuple[str, ...] = field(default_factory=tuple)

    def __bool__(self) -> bool:
        return self.success

    @classmethod
    def ok(cls, message: str, data: Any = None, artifacts=()):
        return cls(True, message, data, tuple(str(path) for path in artifacts))

    @classmethod
    def fail(cls, message: str, data: Any = None):
        return cls(False, message, data)
