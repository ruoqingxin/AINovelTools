#novel_generator/architecture.py
# -*- coding: utf-8 -*-
"""
小说总体架构生成（Novel_architecture_generate 及相关辅助函数）
"""
import os
import json
import logging
from novel_generator.common import invoke_with_cleaning
from novel_generator.results import OperationResult
from novel_generator.storage import NovelProjectRepository
from novel_generator.vectorstore_utils import (
    get_knowledge_context_from_store,
    get_vectorstore_dir,
    load_vector_store,
)
from llm_adapters import create_llm_adapter
from embedding_adapters import create_embedding_adapter
import prompt_definitions

def load_partial_architecture_data(filepath: str) -> dict:
    """
    从 filepath 下的 partial_architecture.json 读取已有的阶段性数据。
    如果文件不存在或无法解析，返回空 dict。
    """
    partial_file = os.path.join(filepath, "partial_architecture.json")
    if not os.path.exists(partial_file):
        return {}
    try:
        with open(partial_file, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data
    except Exception as e:
        logging.warning(f"Failed to load partial_architecture.json: {e}")
        return {}

def save_partial_architecture_data(filepath: str, data: dict):
    """
    将阶段性数据写入 partial_architecture.json。
    """
    try:
        serialized = json.dumps(data, ensure_ascii=False, indent=2)
        NovelProjectRepository(filepath).write(
            "partial_architecture.json",
            serialized,
        )
    except Exception as e:
        logging.warning(f"Failed to save partial_architecture.json: {e}")

def Novel_architecture_generate(
    interface_format: str,
    api_key: str,
    base_url: str,
    llm_model: str,
    topic: str,
    genre: str,
    number_of_chapters: int,
    word_number: int,
    filepath: str,
    user_guidance: str = "",  # 新增参数
    temperature: float = 0.7,
    max_tokens: int = 2048,
    timeout: int = 600,
    embedding_api_key: str = "",
    embedding_url: str = "",
    embedding_interface_format: str = "",
    embedding_model_name: str = "",
    embedding_retrieval_k: int = 4,
) -> OperationResult:
    """
    依次调用:
      1. core_seed_prompt
      2. character_dynamics_prompt
      3. world_building_prompt
      4. plot_architecture_prompt
    若在中间任何一步报错且重试多次失败，则将已经生成的内容写入 partial_architecture.json 并退出；
    下次调用时可从该步骤继续。
    最终输出 Novel_architecture.txt

    新增：
    - 在完成角色动力学设定后，依据该角色体系，使用 create_character_state_prompt 生成初始角色状态表，
      并存储到 character_state.txt，后续维护更新。
    """
    repository = NovelProjectRepository(filepath)
    repository.ensure_exists()
    partial_data = load_partial_architecture_data(filepath)
    llm_adapter = create_llm_adapter(
        interface_format=interface_format,
        base_url=base_url,
        model_name=llm_model,
        api_key=api_key,
        temperature=temperature,
        max_tokens=max_tokens,
        timeout=timeout
    )

    knowledge_store = None
    if os.path.isdir(get_vectorstore_dir(filepath)):
        if not all((embedding_url, embedding_interface_format, embedding_model_name)):
            return OperationResult.fail("检测到知识库，但 Embedding 配置不完整，无法用于架构生成")
        try:
            embedding_adapter = create_embedding_adapter(
                embedding_interface_format,
                embedding_api_key,
                embedding_url,
                embedding_model_name,
            )
            knowledge_store = load_vector_store(embedding_adapter, filepath)
            if knowledge_store is None:
                return OperationResult.fail("知识库加载失败，请检查 Embedding 配置和服务连接")
        except Exception as exc:
            logging.exception("加载架构生成所需知识库失败")
            return OperationResult.fail(f"知识库加载失败：{exc}")

    def retrieve_knowledge(stage: str, queries: list[str]) -> str:
        if knowledge_store is None:
            logging.info("Architecture stage %s: no knowledge base is available.", stage)
            return "（当前项目没有可用的知识库内容）"
        try:
            context = get_knowledge_context_from_store(
                knowledge_store,
                queries,
                k=max(1, embedding_retrieval_k),
            )
        except Exception as exc:
            logging.exception("Architecture knowledge retrieval failed at stage %s", stage)
            raise RuntimeError(f"生成{stage}时检索知识库失败：{exc}") from exc
        if not context:
            raise RuntimeError(f"生成{stage}时没有检索到知识库内容，请检查知识库索引")
        logging.info(
            "Architecture stage %s: injected %d characters of knowledge context.",
            stage,
            len(context),
        )
        return context

    # Step1: 核心种子
    if "core_seed_result" not in partial_data:
        logging.info("Step1: Generating core_seed_prompt (核心种子) ...")
        knowledge_context = retrieve_knowledge("核心种子", [
            f"{topic} {genre} 故事核心 主线 开局",
            "世界背景 核心矛盾 主角 重要设定",
        ])
        prompt_core = prompt_definitions.core_seed_prompt.format(
            topic=topic,
            genre=genre,
            number_of_chapters=number_of_chapters,
            word_number=word_number,
            user_guidance=user_guidance,
            knowledge_context=knowledge_context,
        )
        core_seed_result = invoke_with_cleaning(llm_adapter, prompt_core)
        if not core_seed_result.strip():
            logging.warning("core_seed_prompt generation failed and returned empty.")
            save_partial_architecture_data(filepath, partial_data)
            return OperationResult.fail("核心故事种子生成失败")
        partial_data["core_seed_result"] = core_seed_result
        save_partial_architecture_data(filepath, partial_data)
    else:
        logging.info("Step1 already done. Skipping...")
    # Step2: 角色动力学
    if "character_dynamics_result" not in partial_data:
        logging.info("Step2: Generating character_dynamics_prompt ...")
        knowledge_context = retrieve_knowledge("角色动力学", [
            f"{topic} 主角 核心人物 人物关系 身份",
            "人物 阵营 势力 目标 秘密 冲突",
        ])
        prompt_character = prompt_definitions.character_dynamics_prompt.format(
            core_seed=partial_data["core_seed_result"].strip(),
            user_guidance=user_guidance,
            knowledge_context=knowledge_context,
        )
        character_dynamics_result = invoke_with_cleaning(llm_adapter, prompt_character)
        if not character_dynamics_result.strip():
            logging.warning("character_dynamics_prompt generation failed.")
            save_partial_architecture_data(filepath, partial_data)
            return OperationResult.fail("角色动力学生成失败")
        partial_data["character_dynamics_result"] = character_dynamics_result
        save_partial_architecture_data(filepath, partial_data)
    else:
        logging.info("Step2 already done. Skipping...")
    # 生成初始角色状态
    if "character_dynamics_result" in partial_data and "character_state_result" not in partial_data:
        logging.info("Generating initial character state from character dynamics ...")
        prompt_char_state_init = prompt_definitions.create_character_state_prompt.format(
            character_dynamics=partial_data["character_dynamics_result"].strip()
        )
        character_state_init = invoke_with_cleaning(llm_adapter, prompt_char_state_init)
        if not character_state_init.strip():
            logging.warning("create_character_state_prompt generation failed.")
            save_partial_architecture_data(filepath, partial_data)
            return OperationResult.fail("初始角色状态生成失败")
        partial_data["character_state_result"] = character_state_init
        repository.write(repository.CHARACTER_STATE, character_state_init)
        save_partial_architecture_data(filepath, partial_data)
        logging.info("Initial character state created and saved.")
    # Step3: 世界观
    if "world_building_result" not in partial_data:
        logging.info("Step3: Generating world_building_prompt ...")
        knowledge_context = retrieve_knowledge("世界观", [
            "世界背景 历史 地域 地图",
            "力量体系 境界 法则 资源",
            "势力格局 社会制度 文化 禁忌",
        ])
        prompt_world = prompt_definitions.world_building_prompt.format(
            core_seed=partial_data["core_seed_result"].strip(),
            user_guidance=user_guidance,
            knowledge_context=knowledge_context,
        )
        world_building_result = invoke_with_cleaning(llm_adapter, prompt_world)
        if not world_building_result.strip():
            logging.warning("world_building_prompt generation failed.")
            save_partial_architecture_data(filepath, partial_data)
            return OperationResult.fail("世界观生成失败")
        partial_data["world_building_result"] = world_building_result
        save_partial_architecture_data(filepath, partial_data)
    else:
        logging.info("Step3 already done. Skipping...")
    # Step4: 三幕式情节
    if "plot_arch_result" not in partial_data:
        logging.info("Step4: Generating plot_architecture_prompt ...")
        knowledge_context = retrieve_knowledge("情节架构", [
            f"{topic} 开局 主线剧情 核心冲突",
            "伏笔 主题 真相 披露 转折",
            "重要地点 道具 遗迹 势力冲突",
        ])
        prompt_plot = prompt_definitions.plot_architecture_prompt.format(
            core_seed=partial_data["core_seed_result"].strip(),
            character_dynamics=partial_data["character_dynamics_result"].strip(),
            world_building=partial_data["world_building_result"].strip(),
            user_guidance=user_guidance,
            knowledge_context=knowledge_context,
        )
        plot_arch_result = invoke_with_cleaning(llm_adapter, prompt_plot)
        if not plot_arch_result.strip():
            logging.warning("plot_architecture_prompt generation failed.")
            save_partial_architecture_data(filepath, partial_data)
            return OperationResult.fail("情节架构生成失败")
        partial_data["plot_arch_result"] = plot_arch_result
        save_partial_architecture_data(filepath, partial_data)
    else:
        logging.info("Step4 already done. Skipping...")

    core_seed_result = partial_data["core_seed_result"]
    character_dynamics_result = partial_data["character_dynamics_result"]
    world_building_result = partial_data["world_building_result"]
    plot_arch_result = partial_data["plot_arch_result"]

    final_content = (
        "#=== 0) 小说设定 ===\n"
        f"主题：{topic},类型：{genre},篇幅：约{number_of_chapters}章（每章{word_number}字）\n\n"
        "#=== 1) 核心种子 ===\n"
        f"{core_seed_result}\n\n"
        "#=== 2) 角色动力学 ===\n"
        f"{character_dynamics_result}\n\n"
        "#=== 3) 世界观 ===\n"
        f"{world_building_result}\n\n"
        "#=== 4) 三幕式情节架构 ===\n"
        f"{plot_arch_result}\n"
    )

    arch_file = repository.write(repository.ARCHITECTURE, final_content)
    logging.info("Novel_architecture.txt has been generated successfully.")

    partial_arch_file = os.path.join(filepath, "partial_architecture.json")
    if os.path.exists(partial_arch_file):
        os.remove(partial_arch_file)
        logging.info("partial_architecture.json removed (all steps completed).")
    return OperationResult.ok(
        "小说架构生成完成",
        data=final_content,
        artifacts=(arch_file, repository.path(repository.CHARACTER_STATE)),
    )


def revise_novel_architecture(
    interface_format: str,
    api_key: str,
    base_url: str,
    llm_model: str,
    filepath: str,
    topic: str,
    genre: str,
    number_of_chapters: int,
    word_number: int,
    current_architecture: str,
    revision_guidance: str,
    temperature: float = 0.7,
    max_tokens: int = 8192,
    timeout: int = 600,
) -> str:
    """Rewrite the complete architecture and persist only a successful result."""
    revision_guidance = revision_guidance.strip()
    if not revision_guidance:
        raise ValueError("请先填写个人修改意见")

    prompt = prompt_definitions.architecture_revision_prompt.format(
        topic=topic.strip() or "未指定",
        genre=genre.strip() or "未指定",
        number_of_chapters=max(1, number_of_chapters),
        word_number=max(1, word_number),
        revision_guidance=revision_guidance,
        current_architecture=current_architecture.strip() or "（当前内容为空，请从头重写）",
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
        logging.warning("AI architecture rewrite returned empty content.")
        return ""

    NovelProjectRepository(filepath).write(
        NovelProjectRepository.ARCHITECTURE,
        revised_text,
    )
    return revised_text
