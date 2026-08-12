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


def delete_architecture_section(
    document: str,
    section: ArchitectureSection,
) -> str:
    """Delete one heading and its complete descendant subtree."""
    if not (0 <= section.start < section.end <= len(document)):
        raise ValueError("分区位置已经失效，请刷新分区后重试")
    current = document[section.start:section.end]
    if not current.startswith(section.heading):
        raise ValueError("架构内容已经变化，请刷新分区后重试")
    return document[:section.start] + document[section.end:]


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


def append_architecture_overview_section(
    document: str,
    title: str,
) -> tuple[str, str]:
    """Append a top-level generated-style section under the virtual overview."""
    clean_title = _clean_section_title(title, "请输入新分区名称")
    heading = f"#=== {clean_title} ==="
    prefix = document
    separator = "\n\n" if prefix and not prefix.endswith("\n") else "\n"
    return prefix + separator + heading + "\n", heading


def architecture_section_body(
    document: str,
    section: ArchitectureSection,
) -> str:
    """Return only a section's own prose, excluding its heading and children."""
    body_start, body_end = _section_body_span(document, section)
    return document[body_start:body_end]


def replace_architecture_section_body(
    document: str,
    section: ArchitectureSection,
    body: str,
) -> str:
    """Replace a section's own prose while preserving its complete child tree."""
    body_start, body_end = _section_body_span(document, section)
    normalized = body.strip()
    if normalized:
        normalized = f"\n{normalized}\n"
        if body_end < section.end:
            normalized += "\n"
    else:
        normalized = "\n"
    return document[:body_start] + normalized + document[body_end:]


def upsert_architecture_subsection_body(
    document: str,
    parent: ArchitectureSection,
    title: str,
    body: str,
) -> tuple[str, str, bool]:
    """Create a direct child at a fixed position, or update its prose in place."""
    clean_title = title.strip().lstrip("#").strip()
    if not clean_title:
        raise ValueError("请输入提炼目标分区名称")
    if "\n" in clean_title or "\r" in clean_title:
        raise ValueError("提炼目标分区名称不能换行")

    sections = parse_architecture_sections(document)
    current_parent = next(
        (item for item in sections if item.start == parent.start),
        None,
    )
    if current_parent is None or current_parent.heading != parent.heading:
        raise ValueError("架构内容已经变化，请刷新分区后重试")
    existing = next(
        (
            item
            for item in sections
            if item.parent_index == current_parent.index
            and item.title.strip() == clean_title
        ),
        None,
    )
    if existing is not None:
        return (
            replace_architecture_section_body(document, existing, body),
            existing.heading,
            False,
        )

    if current_parent.level >= 6:
        raise ValueError("六级标题下不能继续新增子分区")
    heading = f"{'#' * (current_parent.level + 1)} {clean_title}"
    prefix = document[:current_parent.end]
    suffix = document[current_parent.end:]
    separator = "\n\n" if prefix and not prefix.endswith("\n") else "\n"
    content = body.strip()
    addition = heading + (f"\n{content}" if content else "") + "\n"
    return prefix + separator + addition + suffix, heading, True


def upsert_architecture_overview_section_body(
    document: str,
    title: str,
    body: str,
) -> tuple[str, str, bool]:
    """Create a top-level overview child, or update an existing one's prose."""
    clean_title = _clean_section_title(title, "请输入提炼目标分区名称")
    existing = next(
        (
            item
            for item in parse_architecture_sections(document)
            if item.parent_index is None and item.title.strip() == clean_title
        ),
        None,
    )
    if existing is not None:
        return (
            replace_architecture_section_body(document, existing, body),
            existing.heading,
            False,
        )

    heading = f"#=== {clean_title} ==="
    prefix = document
    separator = "\n\n" if prefix and not prefix.endswith("\n") else "\n"
    content = body.strip()
    addition = heading + (f"\n{content}" if content else "") + "\n"
    return prefix + separator + addition, heading, True


def _clean_section_title(title: str, empty_message: str) -> str:
    clean_title = title.strip().lstrip("#").strip()
    if clean_title.startswith("===") and clean_title.endswith("==="):
        clean_title = clean_title[3:-3].strip()
    if not clean_title:
        raise ValueError(empty_message)
    if "\n" in clean_title or "\r" in clean_title:
        raise ValueError("分区名称不能换行")
    return clean_title


def _section_body_span(
    document: str,
    section: ArchitectureSection,
) -> tuple[int, int]:
    if not (0 <= section.start < section.end <= len(document)):
        raise ValueError("分区位置已经失效，请刷新分区后重试")
    if not document[section.start:section.end].startswith(section.heading):
        raise ValueError("架构内容已经变化，请刷新分区后重试")
    body_start = section.start + len(section.heading)
    descendant_starts = [
        item.start
        for item in parse_architecture_sections(document)
        if section.start < item.start < section.end
    ]
    body_end = min(descendant_starts, default=section.end)
    return body_start, body_end
