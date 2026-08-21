#novel_generator/finalization.py
# -*- coding: utf-8 -*-
"""
定稿章节和扩写章节（finalize_chapter、enrich_chapter_text）
"""
import os
import logging
from llm_adapters import create_llm_adapter
from embedding_adapters import create_embedding_adapter
import prompt_definitions
from novel_generator.common import invoke_with_cleaning
from utils import read_file
from novel_generator.vectorstore_utils import update_vector_store
from services.finalization_service import ChapterFinalizationService
from services.project_repository import NovelProjectRepository
logging.basicConfig(
    filename='app.log',      # 日志文件名
    filemode='a',            # 追加模式（'w' 会覆盖）
    level=logging.INFO,      # 记录 INFO 及以上级别的日志
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)

def finalize_chapter(
    novel_number: int,
    word_number: int,
    api_key: str,
    base_url: str,
    model_name: str,
    temperature: float,
    filepath: str,
    embedding_api_key: str,
    embedding_url: str,
    embedding_interface_format: str,
    embedding_model_name: str,
    interface_format: str,
    max_tokens: int,
    timeout: int = 600
):
    """
    对指定章节做最终处理：更新前文摘要、更新角色状态、插入向量库等。
    默认无需再做扩写操作，若有需要可在外部调用 enrich_chapter_text 处理后再定稿。
    """
    chapters_dir = os.path.join(filepath, "chapters")
    chapter_file = os.path.join(chapters_dir, f"chapter_{novel_number}.txt")
    chapter_text = read_file(chapter_file).strip()
    if not chapter_text:
        logging.warning(f"Chapter {novel_number} is empty, cannot finalize.")
        return

    global_summary_file = os.path.join(filepath, "global_summary.txt")
    old_global_summary = read_file(global_summary_file)
    character_state_file = os.path.join(filepath, "character_state.txt")
    old_character_state = read_file(character_state_file)
    old_plot_arcs = read_file(os.path.join(filepath, "plot_arcs.txt"))
    repository = NovelProjectRepository(filepath)
    manifest = repository.read_json("chapter_manifest.json", {"chapters": {}})
    status = manifest.get("chapters", {}).get(str(novel_number), {}).get("status")
    if status in {"draft_modified", "stale"}:
        previous = repository.read_json(f"chapter_states/chapter_{novel_number - 1}.json", {}) if novel_number > 1 else {}
        old_global_summary = previous.get("global_summary", "")
        old_character_state = previous.get("character_state", "")
        old_plot_arcs = previous.get("plot_arcs", "")

    llm_adapter = create_llm_adapter(
        interface_format=interface_format,
        base_url=base_url,
        model_name=model_name,
        api_key=api_key,
        temperature=temperature,
        max_tokens=max_tokens,
        timeout=timeout
    )

    prompt_summary = prompt_definitions.summary_prompt.format(
        chapter_text=chapter_text,
        global_summary=old_global_summary
    )
    new_global_summary = invoke_with_cleaning(llm_adapter, prompt_summary)
    if not new_global_summary.strip():
        new_global_summary = old_global_summary

    prompt_char_state = prompt_definitions.update_character_state_prompt.format(
        chapter_text=chapter_text,
        old_state=old_character_state
    )
    new_char_state = invoke_with_cleaning(llm_adapter, prompt_char_state)
    if not new_char_state.strip():
        new_char_state = old_character_state

    def update_index(text):
        embedding_adapter = create_embedding_adapter(
            embedding_interface_format,
            embedding_api_key,
            embedding_url,
            embedding_model_name
        )
        return update_vector_store(
            embedding_adapter=embedding_adapter,
            new_chapter=chapter_text,
            filepath=filepath
        )
    result = ChapterFinalizationService(repository).finalize(
        novel_number,
        chapter_text,
        new_global_summary,
        new_char_state,
        old_plot_arcs,
        update_index,
    )

    logging.info(f"Chapter {novel_number} has been finalized.")
    return result

def enrich_chapter_text(
    chapter_text: str,
    word_number: int,
    api_key: str,
    base_url: str,
    model_name: str,
    temperature: float,
    interface_format: str,
    max_tokens: int,
    timeout: int=600
) -> str:
    """
    对章节文本进行扩写，使其更接近 word_number 字数，保持剧情连贯。
    """
    llm_adapter = create_llm_adapter(
        interface_format=interface_format,
        base_url=base_url,
        model_name=model_name,
        api_key=api_key,
        temperature=temperature,
        max_tokens=max_tokens,
        timeout=timeout
    )
    prompt = prompt_definitions.enrich_prompt.format(
        word_number=word_number,
        chapter_text=chapter_text
    )
    enriched_text = invoke_with_cleaning(llm_adapter, prompt)
    return enriched_text if enriched_text else chapter_text
