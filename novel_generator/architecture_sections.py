"""Parse and update heading-based sections in a novel architecture document."""

from dataclasses import dataclass
import re


_HEADING_PATTERN = re.compile(
    r"^(?P<marks>#{1,6})[ \t]*(?P<title>.*?)[ \t]*(?:\r?\n|$)",
    re.MULTILINE,
)


@dataclass(frozen=True)
class ArchitectureSection:
    """A heading and its complete subtree within an architecture document."""

    index: int
    title: str
    heading: str
    level: int
    start: int
    end: int
    parent_index: int | None

    def content_from(self, document: str) -> str:
        return document[self.start:self.end]


def _display_title(raw_title: str) -> str:
    title = raw_title.strip()
    if title.startswith("===") and title.endswith("==="):
        title = title[3:-3].strip()
    return title or "未命名分区"


def _heading_level(match: re.Match) -> int:
    raw_title = match.group("title").strip()
    if raw_title.startswith("===") and raw_title.endswith("==="):
        return 0
    return len(match.group("marks"))


def parse_architecture_sections(document: str) -> list[ArchitectureSection]:
    """Return all Markdown headings, with each section ending at its subtree edge."""
    matches = list(_HEADING_PATTERN.finditer(document))
    sections: list[ArchitectureSection] = []
    parent_stack: list[tuple[int, int]] = []

    for index, match in enumerate(matches):
        raw_title = match.group("title").strip()
        # Generated ``#=== ... ===`` headings are document groups. Treat them
        # as one level above ordinary ``#`` headings despite equal hash count.
        level = _heading_level(match)
        while parent_stack and parent_stack[-1][0] >= level:
            parent_stack.pop()
        parent_index = parent_stack[-1][1] if parent_stack else None

        end = len(document)
        for next_match in matches[index + 1:]:
            if _heading_level(next_match) <= level:
                end = next_match.start()
                break

        heading = document[match.start():match.end()].rstrip("\r\n")
        sections.append(
            ArchitectureSection(
                index=index,
                title=_display_title(raw_title),
                heading=heading,
                level=level,
                start=match.start(),
                end=end,
                parent_index=parent_index,
            )
        )
        parent_stack.append((level, index))

    return sections


def replace_architecture_section(
    document: str,
    section: ArchitectureSection,
    replacement: str,
) -> str:
    """Replace exactly one parsed section while preserving all other characters."""
    if not (0 <= section.start < section.end <= len(document)):
        raise ValueError("分区位置已经失效，请刷新分区后重试")
    if not replacement.strip():
        raise ValueError("分区内容不能为空")
    if document[section.start:section.end].splitlines()[0] != section.heading:
        raise ValueError("架构内容已经变化，请刷新分区后重试")
    return document[:section.start] + replacement + document[section.end:]


def append_architecture_subsection(
    document: str,
    parent: ArchitectureSection,
    title: str,
) -> tuple[str, str]:
    """Append a new child heading to a section and return document and heading."""
    title = title.strip().lstrip("#").strip()
    if not title:
        raise ValueError("请输入新分区名称")
    if "\n" in title or "\r" in title:
        raise ValueError("分区名称不能换行")
    if parent.level >= 6:
        raise ValueError("六级标题下不能继续新增子分区")
    level = parent.level + 1
    heading = f"{'#' * level} {title}"
    prefix = document[:parent.end]
    suffix = document[parent.end:]
    separator = "\n\n" if prefix and not prefix.endswith("\n") else "\n"
    return prefix + separator + heading + "\n" + suffix, heading
