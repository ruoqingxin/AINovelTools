#novel_generator/finalization.py
# -*- coding: utf-8 -*-
"""
定稿章节和扩写章节（finalize_chapter、enrich_chapter_text）
"""
import logging
from llm_adapters import create_llm_adapter
from embedding_adapters import create_embedding_adapter
import prompt_definitions
from novel_generator.common import invoke_with_cleaning
from novel_generator.results import OperationResult
from novel_generator.storage import NovelProjectRepository
from novel_generator.vectorstore_utils import update_vector_store


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
) -> OperationResult:
    """
    对指定章节做最终处理：更新前文摘要、更新角色状态、插入向量库等。
    默认无需再做扩写操作，若有需要可在外部调用 enrich_chapter_text 处理后再定稿。
    """
    repository = NovelProjectRepository(filepath)
    chapter_text = repository.read_chapter(novel_number).strip()
    if not chapter_text:
        logging.warning(f"Chapter {novel_number} is empty, cannot finalize.")
        return OperationResult.fail(f"第 {novel_number} 章为空，无法定稿")

    old_global_summary = repository.read(repository.GLOBAL_SUMMARY)
    old_character_state = repository.read(repository.CHARACTER_STATE)
    old_plot_arcs = repository.read(repository.PLOT_ARCS)

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
    prompt_plot_arcs = prompt_definitions.plot_arcs_prompt.format(
        chapter_text=chapter_text,
        old_plot_arcs=old_plot_arcs,
    )
    new_plot_arcs = invoke_with_cleaning(llm_adapter, prompt_plot_arcs)

    state_paths = repository.write_many({
        repository.GLOBAL_SUMMARY: new_global_summary,
        repository.CHARACTER_STATE: new_char_state,
        repository.PLOT_ARCS: new_plot_arcs,
    })

    indexed = False
    try:
        embedding_adapter = create_embedding_adapter(
            embedding_interface_format,
            embedding_api_key,
            embedding_url,
            embedding_model_name
        )
        indexed = update_vector_store(
            embedding_adapter=embedding_adapter,
            new_chapter=chapter_text,
            filepath=filepath,
            chapter_number=novel_number,
        )
    except Exception as e:
        logging.warning(f"Vector store update skipped after finalizing chapter {novel_number}: {e}")

    logging.info(f"Chapter {novel_number} has been finalized.")
    message = f"第 {novel_number} 章定稿完成"
    if not indexed:
        message += "，但向量索引更新失败"
    return OperationResult.ok(
        message,
        data={"chapter_number": novel_number, "indexed": indexed},
        artifacts=state_paths,
    )

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
