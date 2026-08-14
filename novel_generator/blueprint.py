#novel_generator/blueprint.py
# -*- coding: utf-8 -*-
"""
章节蓝图生成（Chapter_blueprint_generate 及辅助函数）
"""
import os
import re
import logging
from novel_generator.common import invoke_with_cleaning
from novel_generator.results import OperationResult
from novel_generator.storage import NovelProjectRepository
from llm_adapters import create_llm_adapter
import prompt_definitions
from utils import read_file

def compute_chunk_size(number_of_chapters: int, max_tokens: int) -> int:
    """
    基于“每章约100 tokens”的粗略估算，
    再结合当前max_tokens，计算分块大小：
      chunk_size = (floor(max_tokens/100/10)*10) - 10
    并确保 chunk_size 不会小于1或大于实际章节数。
    """
    tokens_per_chapter = 200.0
    ratio = max_tokens / tokens_per_chapter
    ratio_rounded_to_10 = int(ratio // 10) * 10
    chunk_size = ratio_rounded_to_10 - 10
    if chunk_size < 1:
        chunk_size = 1
    if chunk_size > number_of_chapters:
        chunk_size = number_of_chapters
    return chunk_size

def limit_chapter_blueprint(blueprint_text: str, limit_chapters: int = 100) -> str:
    """
    从已有章节目录中只取最近的 limit_chapters 章，以避免 prompt 超长。
    """
    pattern = r"(第\s*\d+\s*章.*?)(?=第\s*\d+\s*章|$)"
    chapters = re.findall(pattern, blueprint_text, flags=re.DOTALL)
    if not chapters:
        return blueprint_text
    if len(chapters) <= limit_chapters:
        return blueprint_text
    selected = chapters[-limit_chapters:]
    return "\n\n".join(selected).strip()


def remove_chapter_range(blueprint_text: str, start_chapter: int, end_chapter: int) -> str:
    """Remove complete chapter blocks in a range while preserving other chapters."""
    pattern = re.compile(r"第\s*(\d+)\s*章.*?(?=第\s*\d+\s*章|$)", re.DOTALL)

    def keep(match):
        number = int(match.group(1))
        return "" if start_chapter <= number <= end_chapter else match.group(0)

    return re.sub(pattern, keep, blueprint_text).strip()


def blueprint_stage_guardrail(
    total_chapters: int, start_chapter: int, end_chapter: int
) -> str:
    """Return progression limits for the requested position in the novel."""
    progress = end_chapter / total_chapters
    if progress <= 0.05:
        return (
            "当前仍处于全书前5%的开局期。只允许推进聚落生存、首次低阶探索、"
            "局部敌人与基础能力试错；不得点名或确认道祭、至强真实身份、主角本源、"
            "域外总体战略、最终反派或世界晋升方案。相关内容只能表现为无法解读的异常。"
            "认知颠覆以1-2级为主，最多一章达到3级。活动范围应限制在开局聚落及邻近据点，"
            "不得在一个短范围内跨越大域、抵达远方禁区或触发世界级异象。范围结尾只开启"
            "下一项本地任务、商路中转或低阶遗藏线索，不得直接开启高阶遗藏与大区域主线。"
        )
    if progress <= 0.15:
        return (
            "当前处于全书5%-15%的立足期。活动范围可扩展到邻近城镇、商路与当前卷区域，"
            "允许掌握一项稳定的基础能力、认识一个地方势力并解决区域性危机。只能确认长期"
            "谜团的表层现象，不得确认至强身份、历史全貌、域外战略或终局机制。"
        )
    if progress <= 0.35:
        return (
            "当前处于全书15%-35%的成长扩张期。可以进入区域核心、接触多个地方势力并形成"
            "稳定成长路线；每个范围只推进一条长期谜团，允许获得局部历史证据，但不得确认"
            "最终敌人、主角完整身世和世界级解决方案。"
        )
    if progress <= 0.60:
        return (
            "当前处于全书35%-60%的中段展开期。可以跨区域行动、参与主要势力冲突并揭开"
            "部分历史真相；真相必须来自多份证据且保留矛盾解释。可以确认重要敌对关系，"
            "但不得公布完整终局方案、最终胜负条件或一次性回收核心谜团。"
        )
    if progress <= 0.80:
        return (
            "当前处于全书60%-80%的主线汇聚期。可确认主要人物身份、核心历史原因和全局"
            "威胁，推进跨区域联盟与高层冲突；仍需保留终局方案的关键缺口、最终代价和至少"
            "一项核心反转，不得提前完成最终决战。"
        )
    if progress <= 0.95:
        return (
            "当前处于全书80%-95%的终局准备期。可以集中回收长期伏笔、确认大部分真相并"
            "组建最终阵营，但本范围只能完成决战准备、前置战役或关键抉择，不能写最终胜利、"
            "世界完成晋升、最终反派彻底退场或主角最终归宿。"
        )
    if end_chapter < total_chapters:
        return (
            "当前处于全书95%之后但尚未覆盖最后一章。可以展开最终战的阶段性交锋并回收"
            "剩余伏笔，但必须保留最后胜负、终局代价和人物归宿，不能提前写大结局或尾声。"
        )
    return (
        "本范围覆盖全书最后一章，可以完成最终冲突、回收核心伏笔并交代人物归宿；"
        "结局仍须与前文证据和既定代价一致，不能临时引入未经铺垫的解决方案。"
    )


def generate_volume_plan(
    interface_format: str,
    api_key: str,
    base_url: str,
    llm_model: str,
    filepath: str,
    number_of_chapters: int,
    volume_count: int,
    temperature: float = 0.7,
    max_tokens: int = 4096,
    timeout: int = 600,
) -> str:
    """Generate an editable whole-book volume plan without changing the blueprint."""
    total_chapters = max(1, int(number_of_chapters))
    volume_count = int(volume_count)
    if not 1 <= volume_count <= 20:
        raise ValueError("分卷数必须在 1-20 之间")

    repository = NovelProjectRepository(filepath)
    architecture_text = repository.read(repository.ARCHITECTURE).strip()
    if not architecture_text:
        raise ValueError("小说架构为空，请先生成或保存小说架构")

    prompt = prompt_definitions.volume_plan_prompt.format(
        number_of_chapters=total_chapters,
        volume_count=volume_count,
        novel_architecture=architecture_text,
    )
    adapter = create_llm_adapter(
        interface_format=interface_format,
        base_url=base_url,
        model_name=llm_model,
        api_key=api_key,
        temperature=temperature,
        max_tokens=max_tokens,
        timeout=timeout,
    )
    result = invoke_with_cleaning(adapter, prompt).strip()
    if not result:
        raise RuntimeError("AI 未返回分卷规划")
    return result

def Chapter_blueprint_generate(
    interface_format: str,
    api_key: str,
    base_url: str,
    llm_model: str,
    filepath: str,
    number_of_chapters: int,
    user_guidance: str = "",
    temperature: float = 0.7,
    max_tokens: int = 4096,
    timeout: int = 600,
    start_chapter: int = 1,
    end_chapter: int | None = None,
    phase: str = "",
    replace_range: bool = False,
) -> OperationResult:
    """
    `number_of_chapters` 是全书总章数；`start_chapter` 和 `end_chapter`
    定义本次生成范围。已有蓝图会从该范围内的下一章继续生成。
    """
    # Total novel length and this run's range are separate concepts.
    total_chapters = max(1, int(number_of_chapters))
    start_chapter = max(1, int(start_chapter))
    end_chapter = max(start_chapter, int(end_chapter or total_chapters))
    if end_chapter > total_chapters:
        raise ValueError("蓝图生成范围不能超过全书章节数")
    repository = NovelProjectRepository(filepath)
    arch_file = repository.path(repository.ARCHITECTURE)
    if not os.path.exists(arch_file):
        logging.warning("Novel_architecture.txt not found. Please generate architecture first.")
        return OperationResult.fail("请先生成小说架构")

    architecture_text = read_file(arch_file).strip()
    if not architecture_text:
        logging.warning("Novel_architecture.txt is empty.")
        return OperationResult.fail("小说架构文件为空")

    llm_adapter = create_llm_adapter(
        interface_format=interface_format,
        base_url=base_url,
        model_name=llm_model,
        api_key=api_key,
        temperature=temperature,
        max_tokens=max_tokens,
        timeout=timeout
    )

    filename_dir = repository.path(repository.DIRECTORY)

    existing_blueprint = read_file(filename_dir).strip()
    requested_chapters = end_chapter - start_chapter + 1
    chunk_size = compute_chunk_size(requested_chapters, max_tokens)
    logging.info("Novel chapters=%s, requested range=[%s..%s], chunk_size=%s", total_chapters, start_chapter, end_chapter, chunk_size)

    final_blueprint = existing_blueprint
    current_start = start_chapter
    if existing_blueprint:
        logging.info("Resuming blueprint generation from existing content.")
        chapter_numbers = [
            int(value) for value in re.findall(r"第\s*(\d+)\s*章", existing_blueprint)
        ]
        covered = {
            n for n in chapter_numbers if start_chapter <= n <= end_chapter
        }
        if replace_range and covered:
            final_blueprint = remove_chapter_range(
                existing_blueprint, start_chapter, end_chapter
            )
            current_start = start_chapter
            covered = set()
        current_start = start_chapter
        while current_start in covered:
            current_start += 1
        if any(n > current_start for n in covered):
            return OperationResult.fail(
                f"已有蓝图第 {start_chapter}-{end_chapter} 章不连续，"
                "请先补齐缺失章节或清理重复内容后再续写"
            )

    guidance = (user_guidance + (f"\n当前阶段：{phase}" if phase else "")).strip()
    single_full_book = (
        not existing_blueprint
        and start_chapter == 1
        and end_chapter == total_chapters
        and chunk_size >= requested_chapters
    )
    while current_start <= end_chapter:
        current_end = min(current_start + chunk_size - 1, end_chapter)
        if single_full_book:
            prompt = prompt_definitions.chapter_blueprint_prompt.format(
                novel_architecture=architecture_text,
                number_of_chapters=total_chapters,
                user_guidance=guidance,
            )
        else:
            prompt = prompt_definitions.chunked_chapter_blueprint_prompt.format(
                novel_architecture=architecture_text,
                chapter_list=limit_chapter_blueprint(final_blueprint, 100),
                number_of_chapters=total_chapters,
                n=current_start,
                m=current_end,
                user_guidance=guidance,
                stage_guardrail=blueprint_stage_guardrail(
                    total_chapters, current_start, current_end
                ),
            )
        logging.info(f"Generating chapters [{current_start}..{current_end}] in a chunk...")
        chunk_result = invoke_with_cleaning(llm_adapter, prompt)
        if not chunk_result.strip():
            logging.warning(f"Chunk generation for chapters [{current_start}..{current_end}] is empty.")
            repository.write(repository.DIRECTORY, final_blueprint.strip())
            return OperationResult.fail(f"第 {current_start}-{current_end} 章目录生成失败")
        if final_blueprint.strip():
            final_blueprint += "\n\n" + chunk_result.strip()
        else:
            final_blueprint = chunk_result.strip()
        repository.write(repository.DIRECTORY, final_blueprint.strip())
        current_start = current_end + 1
        single_full_book = False

    logging.info("Novel_directory.txt (chapter blueprint) generated successfully.")
    return OperationResult.ok("章节目录生成完成", final_blueprint, (filename_dir,))


def revise_chapter_blueprint(
    interface_format: str,
    api_key: str,
    base_url: str,
    llm_model: str,
    filepath: str,
    number_of_chapters: int,
    current_blueprint: str,
    revision_guidance: str,
    temperature: float = 0.7,
    max_tokens: int = 8192,
    timeout: int = 600,
) -> str:
    """Rewrite the complete blueprint and persist only a successful result."""
    revision_guidance = revision_guidance.strip()
    if not revision_guidance:
        raise ValueError("请先填写个人修改意见")

    repository = NovelProjectRepository(filepath)
    architecture_text = repository.read(repository.ARCHITECTURE).strip()
    if not architecture_text:
        raise ValueError("小说架构为空，请先生成或保存小说架构")

    prompt = prompt_definitions.blueprint_revision_prompt.format(
        number_of_chapters=max(1, number_of_chapters),
        revision_guidance=revision_guidance,
        novel_architecture=architecture_text,
        current_blueprint=current_blueprint.strip() or "（当前内容为空，请从头重写）",
    )
    llm_adapter = create_llm_adapter(
        interface_format=interface_format,
        base_url=base_url,
        model_name=llm_model,
        api_key=api_key,
        temperature=temperature,
        max_tokens=max_tokens,
        timeout=timeout,
    )
    revised_text = invoke_with_cleaning(llm_adapter, prompt).strip()
    if not revised_text:
        logging.warning("AI chapter blueprint rewrite returned empty content.")
        return ""

    repository.write(repository.DIRECTORY, revised_text)
    return revised_text
