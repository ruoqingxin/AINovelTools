"""小说生成核心 API。

公开对象按需加载，避免导入轻量工具时初始化全部模型和向量数据库 SDK。
"""

from importlib import import_module


_EXPORTS = {
    "Novel_architecture_generate": (".architecture", "Novel_architecture_generate"),
    "Chapter_blueprint_generate": (".blueprint", "Chapter_blueprint_generate"),
    "get_last_n_chapters_text": (".chapter", "get_last_n_chapters_text"),
    "summarize_recent_chapters": (".chapter", "summarize_recent_chapters"),
    "get_filtered_knowledge_context": (".chapter", "get_filtered_knowledge_context"),
    "build_chapter_prompt": (".chapter", "build_chapter_prompt"),
    "generate_chapter_draft": (".chapter", "generate_chapter_draft"),
    "finalize_chapter": (".finalization", "finalize_chapter"),
    "enrich_chapter_text": (".finalization", "enrich_chapter_text"),
    "import_knowledge_file": (".knowledge", "import_knowledge_file"),
    "clear_vector_store": (".vectorstore_utils", "clear_vector_store"),
}

__all__ = tuple(_EXPORTS)


def __getattr__(name):
    try:
        module_name, attribute_name = _EXPORTS[name]
    except KeyError as exc:
        raise AttributeError(name) from exc
    value = getattr(import_module(module_name, __name__), attribute_name)
    globals()[name] = value
    return value
