# novel_generator/blueprint.py
# -*- coding: utf-8 -*-
"""
章节蓝图生成（Chapter_blueprint_generate 及辅助函数）
"""

import logging
import os
import re

from llm_adapters import create_llm_adapter
from novel_generator.common import invoke_with_cleaning
from novel_generator.results import OperationResult
from novel_generator.storage import NovelProjectRepository
import prompt_definitions
from utils import read_file

def compute_chunk_size(number_of_chapters: int, max_tokens: int) -> int:
    """
    根据模型最大输出 token 数估算每次生成的章节数量。

    估算方式：
        tokens_per_chapter = 200
        chunk_size = floor(max_tokens / 200 / 10) * 10 - 10

    最终结果限制在 1 至本次请求章节数之间。

    注意：
    该函数只负责计算模型输出容量。
    实际生成时还会受到叙事阶段边界限制，单次不会跨阶段生成。
    """
    number_of_chapters = max(1, int(number_of_chapters))
    max_tokens = max(1, int(max_tokens))

    tokens_per_chapter = 200.0
    ratio = max_tokens / tokens_per_chapter
    ratio_rounded_to_10 = int(ratio // 10) * 10
    chunk_size = ratio_rounded_to_10 - 10

    if chunk_size < 1:
        chunk_size = 1

    if chunk_size > number_of_chapters:
        chunk_size = number_of_chapters

    return chunk_size

def limit_chapter_blueprint(
    blueprint_text: str,
    limit_chapters: int = 100,
) -> str:
    """
    从已有章节蓝图中截取最近的若干章，避免提示词过长。
    """
    pattern = r"(第\s*\d+\s*章.*?)(?=第\s*\d+\s*章|$)"
    chapters = re.findall(pattern, blueprint_text, flags=re.DOTALL)

    if not chapters:
        return blueprint_text

    if len(chapters) <= limit_chapters:
        return blueprint_text

    selected = chapters[-limit_chapters:]
    return "\n\n".join(selected).strip()

def remove_chapter_range(
    blueprint_text: str,
    start_chapter: int,
    end_chapter: int,
) -> str:
    """
    删除指定范围内的完整章节蓝图块，同时保留范围外的章节。
    """
    pattern = re.compile(
        r"第\s*(\d+)\s*章.*?(?=第\s*\d+\s*章|$)",
        re.DOTALL,
    )

    def keep(match: re.Match) -> str:
        chapter_number = int(match.group(1))

        if start_chapter <= chapter_number <= end_chapter:
            return ""

        return match.group(0)

    return re.sub(pattern, keep, blueprint_text).strip()

def get_stage_end_chapter(
    total_chapters: int,
    current_chapter: int,
) -> int:
    """
    返回当前章节所在叙事阶段的最后一章。

    用于保证单次生成不会横跨多个阶段，从而避免前期章节被套用
    更后期、更宽松的剧情推进规则。

    阶段划分：
        0%—5%：开局建立期
        5%—15%：立足发展期
        15%—35%：成长扩张期
        35%—60%：中段深化期
        60%—80%：主线汇聚期
        80%—95%：终局准备期
        95%—100%：最终冲突与结局期
    """
    total_chapters = max(1, int(total_chapters))
    current_chapter = max(1, int(current_chapter))

    stage_ratios = (
        0.05,
        0.15,
        0.35,
        0.60,
        0.80,
        0.95,
        1.00,
    )

    previous_end = 0

    for ratio in stage_ratios:
        stage_end = max(previous_end + 1, int(total_chapters * ratio))
        stage_end = min(stage_end, total_chapters)

        if current_chapter <= stage_end:
            return stage_end

        previous_end = stage_end

    return total_chapters

def blueprint_stage_guardrail(
    total_chapters: int,
    start_chapter: int,
    end_chapter: int,
) -> str:
    """
    根据当前章节在全书中的位置，生成题材无关的阶段约束。

    本函数只约束通用叙事维度，不引用任何特定小说的：
    - 专有名词；
    - 世界观设定；
    - 力量等级；
    - 身份名称；
    - 组织名称；
    - 终局机制。

    因而可以应用于玄幻、仙侠、都市、悬疑、科幻、历史、
    言情、奇幻、游戏、末世等不同题材。
    """
    total_chapters = max(1, int(total_chapters))
    start_chapter = max(1, int(start_chapter))
    end_chapter = max(start_chapter, int(end_chapter))

    start_progress = min(
        (start_chapter - 1) / total_chapters,
        1.0,
    )
    end_progress = min(
        end_chapter / total_chapters,
        1.0,
    )

    common_rules = """
【通用连续性约束】

1. 严格承接已有蓝图中的人物状态、人物关系、能力、资源、伤势、
   任务、已知信息和未解决问题，不得无故重置或相互矛盾。

2. 新剧情必须从既有目标、人物选择、外部压力、已有线索或前序事件
   的后果中自然产生，不得依靠无铺垫巧合强行推进。

3. 角色只能根据亲身经历、调查结果、可靠转述和自身知识作出判断，
   不得拥有超出其认知范围的作者视角。

4. 新人物、新地点、新组织、新能力、新资源和新危机必须具备合理入口，
   不得为了制造刺激而在短范围内集中堆叠。

5. 每章设置一个主要叙事目标，其他事件应当服务于该目标；
   避免在单章内同时完成多个彼此独立的重大事件。

6. 重要成功必须来自人物选择、主动行动、前期准备、有效合作、
   已有能力或前文铺垫，不得依靠无代价觉醒、突然救援、
   对手降智或临时出现的万能工具。

7. 人物成长、关系变化、认知变化和立场转变必须具有过程；
   不得仅凭一次普通事件完成彻底改变。

8. 不得把角色猜测、传言、伪证或片面信息直接写成客观事实。
   重要结论需要合理证据支持。

9. 生成范围结束时，只开启与当前阶段相邻的下一目标；
   不得无过渡跳到远高于当前叙事层级的事件。

10. 严格生成指定章节范围，不得缺章、重章、跳号或生成范围外章节。
""".strip()

    if end_progress <= 0.05:
        stage_name = "开局建立期"

        stage_rules = """
【阶段核心目标】

建立故事的初始状态，包括：

- 主角当前处境与近期需求；
- 主角开始行动的直接动机；
- 基础人物关系；
- 当前环境中可感知的基本规则；
- 第一个能够实际执行的目标；
- 一项可以持续发展的主要矛盾。

【主线推进维度】

- 主要处理直接影响主角的个人或局部问题。
- 推动主角从被动承受逐渐转向主动行动。
- 不宜直接完成全书核心目标。
- 不宜过早改变整个社会、国家、世界、行业或大型组织的格局。
- 本范围只需建立并推进一条主要行动线。
- 范围结尾只开启下一项局部任务或更深一层的问题。

【信息揭示维度】

- 重点展示人物能够直接观察到的现象和事实。
- 深层背景可以通过异常、传闻、残缺线索、错误记录、
  人物隐瞒或局部后果间接呈现。
- 不宜直接解释全书核心秘密、幕后全貌和最终解决方式。
- 重要线索应尽量保留两种或以上可能解释。
- 角色可以提出猜测，但不能把未经验证的猜测写成确定事实。
- 每个生成范围最多重点推进一条长期悬念。

【人物成长维度】

- 重点建立人物初始能力、性格特点、行为习惯和核心缺陷。
- 每个生成范围最多重点推进一项能力或一次关键认知变化。
- 新能力或新方法应经历发现、尝试、受阻和初步掌握。
- 不宜让人物迅速完成根本性蜕变。
- 不得连续跨越多个成长层级。
- 超常发挥必须具备原因、限制和后果。

【冲突规模维度】

- 以个人困境、人际矛盾、局部竞争、小范围危机为主。
- 更高层级冲突可以留下影响，但不宜完整展开。
- 对手或困难应与主角当前处理能力大致匹配。
- 超出当前能力的威胁只适合表现压力、局部接触或后果。
- 主角可以解决眼前问题，但不宜一次解决整个矛盾体系。

【场景范围维度】

- 主要使用初始场景及其直接关联区域。
- 每个生成范围最多重点新增一至两个主要场景。
- 新场景必须通过行动目标、人物关系或事件因果引入。
- 避免短时间内频繁更换完全无关的主要场景。
- 远离初始区域的地点只能作为传闻、目标或背景信息出现，
  不宜让人物无过程直接抵达。

【人物关系维度】

- 初期关系以观察、试探、合作、戒备和有限信任为主。
- 不宜初次接触便无条件信任、效忠、相爱或交付全部秘密。
- 每个生成范围重点推进一组核心关系。
- 配角必须拥有自己的目标、利益、判断和信息边界。
- 关系变化应通过具体互动和共同事件体现。

【组织与群体维度】

- 最多重点引入一个与当前事件直接相关的新组织或群体。
- 不宜让多个最高层级组织同时围绕主角采取重大行动。
- 主角不应在缺少铺垫时立刻成为组织核心或最高决策者。
- 新组织首先表现与当前事件相关的局部诉求，
  不宜立即展示全部结构、历史和秘密。

【资源与能力维度】

- 初期收益以解决现实问题、增强基础行动能力或提供信息为主。
- 超出当前阶段的资源必须具有无法使用、效果有限、
  信息残缺、条件不足或代价明显等限制。
- 不宜连续获得多项能够改变故事格局的关键资源。
- 新资源不能立刻解决全部已有问题。
- 重要资源的获得应与行动、选择或风险相匹配。

【伏笔与悬念维度】

- 本范围最多重点推进一条长期悬念。
- 可以解决一个局部疑问，但解决后应自然产生下一层问题。
- 不宜在同一范围完成“提出核心谜团、调查、揭示全部真相”。
- 新伏笔必须与人物、事件或环境存在可追溯联系。
- 不得为了制造神秘感而堆叠大量互不相关的异常。

【事件密度维度】

- 每章围绕一个主要目标组织内容。
- 每章最多安排一次主要转折。
- 本范围最多形成一次局部高潮。
- 不连续安排多个突破、追逐、背叛、重伤、反转等高强度事件。
- 高强度事件后应安排复盘、恢复、关系变化或后果展示。

【阶段结尾维度】

- 明确人物接下来可以执行的具体目标。
- 下一目标可以提高难度，但只能提高一个相邻层级。
- 新目标必须由当前事件的结果自然产生。
- 不宜直接开启最高层冲突、最终危机或故事终局。
""".strip()

    elif end_progress <= 0.15:
        stage_name = "立足发展期"

        stage_rules = """
【阶段核心目标】

让主角形成较稳定的行动方式、关系网络和阶段目标，
并开始主动影响周围环境。

【主线推进维度】

- 可以解决开局主要困境并进入第一个完整阶段任务。
- 主角可以获得局部影响力，但不宜立刻决定整体格局。
- 每个生成范围重点推进一项主要任务。
- 支线应服务于人物成长、关系变化或主线信息。

【信息揭示维度】

- 可以确认部分表层规律、局部事实和直接因果。
- 深层原因仍应保留证据缺口、认知偏差或不同解释。
- 不宜过早确认幕后全貌和最终解决方案。
- 每个范围最多重点推进一条长期悬念和一条局部疑问。

【人物成长维度】

- 可以稳定掌握一项基础能力、技能或行动方法。
- 可以对已有能力进行一次有铺垫的改进。
- 避免连续跨越多个成长层级。
- 成长必须通过实践、训练、观察、资源或代价完成。

【冲突规模维度】

- 可以发展到地区、行业、小型组织或阶段性群体冲突。
- 更高层冲突应通过间接影响逐渐进入。
- 主角的胜利可以改变局部处境，但不宜立刻改变全局。
- 对手应具有自己的目标与应对能力。

【场景与组织维度】

- 可以接触当前区域内的主要场景和地方组织。
- 每个生成范围最多重点展开一个新组织和一个新区域。
- 避免同时铺开过多阵营、地点和规则。
- 场景扩展必须与当前行动目标存在因果关系。

【人物关系维度】

- 可以完成一次明确的合作、信任、竞争、分裂或和解节点。
- 重大感情与立场变化必须由多次互动支撑。
- 配角不能只作为主角的工具，必须保留独立诉求。

【资源与能力维度】

- 奖励可以提高人物的稳定生存能力、专业能力或行动效率。
- 不宜直接获得能够解决全书主要矛盾的资源。
- 关键资源应附带条件、成本、风险或责任。

【伏笔与节奏维度】

- 每个范围最多重点推进一条长期悬念。
- 可以回收开局建立的小型伏笔。
- 不宜集中回收决定全书走向的核心伏笔。
- 高强度事件之间应保留人物消化和后果展示。

【阶段结尾维度】

- 可以开启新的地区任务、组织冲突、关系危机或调查方向。
- 下一阶段必须从当前事件的结果中自然产生。
- 不宜突然升级为最高层级冲突。
""".strip()

    elif end_progress <= 0.35:
        stage_name = "成长扩张期"

        stage_rules = """
【阶段核心目标】

扩大人物行动范围、关系网络和矛盾层级，
建立清晰稳定的成长路线与中期方向。

【主线推进维度】

- 可以让主角主动参与更大范围的事件。
- 每个生成范围集中推进一条主要因果链。
- 支线应与人物成长、关系变化或主线信息相关。
- 不得为了扩大规模而不断加入无关事件。

【信息揭示维度】

- 可以获得局部历史、幕后关系或规则证据。
- 重要结论需要多个来源相互印证。
- 证据可以存在矛盾、缺失或误导。
- 不宜确认所有核心秘密和最终解决方式。

【人物成长维度】

- 可以形成稳定的能力体系、专业路线或行动模式。
- 每个生成范围最多安排一次关键成长节点。
- 成长必须建立在训练、实践、资源、牺牲或选择上。
- 新能力应与人物已有经历和故事规则兼容。

【冲突规模维度】

- 可以进入区域性、多组织或复杂人际冲突。
- 主角可以改变阶段性结果，但不宜独自决定全局。
- 对手应拥有独立目标，而不是仅为衬托主角存在。
- 冲突升级必须由前期矛盾积累而来。

【场景与组织维度】

- 可以进入当前故事区域的核心地点。
- 可以接触多个组织，但每个范围最多重点展开两个。
- 跨区域行动必须交代目标、路线、时间或成本。
- 避免无目的地频繁切换地图。

【人物关系维度】

- 允许建立较稳定的合作、友情、亲情、爱情或竞争关系。
- 关系升级与破裂必须有累积过程。
- 关键配角应拥有自己的剧情线和决定能力。
- 人物之间的矛盾不能只靠误会长期维持。

【资源与能力维度】

- 可以获得推动中期发展的资源、资格、信息或能力。
- 重要收益不能同时消除人物的全部弱点。
- 每项重大收益都应带来新的责任、风险或选择。

【伏笔与节奏维度】

- 每个范围重点推进一条长期悬念。
- 可以回收前期伏笔，但回收后应影响人物选择或主线方向。
- 避免只公布答案却不产生实际后果。
- 每个范围最多形成一次主要高潮。

【阶段结尾维度】

- 可以开启区域核心矛盾、中期主要任务或更高层调查。
- 新目标应建立在当前成果或失败的后果上。
- 不宜直接进入最终决战。
""".strip()

    elif end_progress <= 0.60:
        stage_name = "中段深化期"

        stage_rules = """
【阶段核心目标】

深化核心冲突，迫使人物承担更大代价，
并逐步揭示故事主要矛盾的真实结构。

【主线推进维度】

- 可以进行跨区域、跨群体或多线关联行动。
- 支线应在本阶段产生汇合、影响、取舍或回收。
- 主角的重要决定应造成持续性后果。
- 不得用不断增加新支线替代已有矛盾的深化。

【信息揭示维度】

- 可以揭示部分核心真相。
- 真相应来自多项证据，并允许存在解释冲突。
- 角色的认知变化必须与其掌握的证据相匹配。
- 不宜一次性说明全部幕后关系、最终条件和终局结果。

【人物成长维度】

- 可以完成重要能力升级、身份转变或价值观变化。
- 每次重大成长都必须伴随限制、责任、损失或新问题。
- 不得用单一奖励解决人物所有弱点。
- 人物应开始面对自身核心缺陷造成的后果。

【冲突规模维度】

- 可以参与主要组织、社会群体或大范围利益冲突。
- 冲突升级必须来自前期积累，而不是突然扩大。
- 对手应具有合理立场、资源和应对能力。
- 主角不能仅凭个人力量轻易压倒整个冲突体系。

【场景与组织维度】

- 可以跨越多个已铺垫区域行动。
- 新区域必须直接服务于主要目标。
- 组织之间的合作与对抗应建立在利益和立场上。
- 不宜让所有组织简单划分为绝对善恶。

【人物关系维度】

- 可以出现重大合作、背叛、决裂或立场重组。
- 转变必须基于前文矛盾和人物选择。
- 不宜让所有人物轻易达成一致。
- 关系变化应对主线行动产生实际影响。

【资源与能力维度】

- 可以获得影响主要冲突的重要资源。
- 资源必须具有边界，不能成为无条件的万能解决方案。
- 重大能力使用应体现风险、条件或不可逆代价。

【伏笔回收维度】

- 每个范围最多回收一项重要长期伏笔。
- 回收必须改变人物认知、行动策略或冲突形势。
- 仍需保留通往后期的关键缺口。
- 不得一次性回收所有核心谜团。

【阶段结尾维度】

- 可以形成中段高潮或重大方向转折。
- 转折应改变人物的行动方式或目标。
- 不得直接完成全书最终目标。
""".strip()

    elif end_progress <= 0.80:
        stage_name = "主线汇聚期"

        stage_rules = """
【阶段核心目标】

使主要人物、冲突、线索和组织关系逐步汇聚，
明确后期必须解决的核心问题。

【主线推进维度】

- 可以推动高层冲突、重大合作和多线汇合。
- 前期支线应开始回归主线。
- 新增支线必须直接服务于终局准备。
- 人物需要逐步确认自身最终目标和核心立场。

【信息揭示维度】

- 可以确认主要人物身份、关键历史原因和核心威胁。
- 仍需保留最终解决方式、核心代价或关键反转。
- 已有线索必须在揭晓过程中发挥作用。
- 不得依靠突然出现的新解释推翻全部前期铺垫。

【人物成长维度】

- 人物应逐渐接近能力和心理上的成熟状态。
- 仍需保留必须克服的核心缺陷或最终选择。
- 不宜凭新出现的万能能力跨过全部困难。
- 重要人物应明确自己愿意承担或拒绝承担的代价。

【冲突规模维度】

- 可以进入故事中的主要高层冲突。
- 主角可以成为关键参与者，但胜负仍应受多方因素影响。
- 冲突不能只通过力量比较解决，还应体现立场、信息与选择。

【人物关系与阵营维度】

- 可以完成主要关系的重大转折。
- 可以建立后期阵营，但各方仍应存在利益差异。
- 联盟不能自动消除内部矛盾。
- 关键人物的加入、退出或背离必须具有铺垫。

【资源与能力维度】

- 可以汇聚后期所需的重要资源、情报和能力。
- 每项资源都必须来自前文建立的因果链。
- 不得通过新出现的万能资源直接结束主要冲突。

【伏笔回收维度】

- 可以集中回收已经充分铺垫的伏笔。
- 不得回收尚未建立足够线索的谜团。
- 至少保留一项决定终局走向的未完成问题。
- 回收结果必须改变后续行动方案。

【阶段结尾维度】

- 可以开启终局准备、重大危机或决定性行动。
- 不得提前完成最终冲突。
- 结尾应明确进入后期必须解决的核心问题。
""".strip()

    elif end_progress <= 0.95:
        stage_name = "终局准备期"

        stage_rules = """
【阶段核心目标】

回收主要线索，完成阵营、资源、人物关系和行动方案的准备，
将故事推至最终冲突之前。

【主线推进维度】

- 可以展开终局前置行动和决定性阶段事件。
- 所有主要支线应完成回收、合流或明确舍弃。
- 新元素只能补足已有因果链，不得另起无关主线。
- 每个事件都应服务于最终冲突或人物最终选择。

【信息揭示维度】

- 可以确认大部分核心真相。
- 最终答案必须与前文证据一致。
- 仍需保留最终胜负、关键选择和实际代价。
- 不得使用没有前期证据支持的终局解释。

【人物成长维度】

- 主要人物应完成决战前的能力和心理准备。
- 可以完成核心缺陷的关键转变，但必须通过行动证明。
- 不得在决战前突然获得没有限制的决定性能力。

【冲突规模维度】

- 可以进行终局前置战役、关键行动或重大危机。
- 可以造成不可逆损失并改变最终局势。
- 不能在本阶段提前完成最终胜利或最终失败。

【人物关系与阵营维度】

- 主要人物应完成决战前的立场选择。
- 可以出现重大牺牲、和解、决裂或责任承担。
- 不宜提前写完全部人物归宿。
- 阵营合作必须保留真实成本与利益差异。

【资源与能力维度】

- 最终行动所需的关键工具、能力和资源必须已有铺垫。
- 新信息只能帮助完善使用方法，不能凭空创造万能答案。
- 每项决定性手段都应有条件、限制或代价。

【伏笔回收维度】

- 可以集中回收长期伏笔。
- 回收应补全最终行动所需的信息。
- 必须保留最终结果才能回答的问题。
- 不得把全部人物归宿提前交代完毕。

【阶段结尾维度】

- 可以将人物推向最终冲突。
- 不得提前完成最终胜利、最终失败或完整尾声。
- 结尾应明确最终行动、最终选择或无法回避的代价。
""".strip()

    elif end_chapter < total_chapters:
        stage_name = "最终冲突期"

        stage_rules = """
【阶段核心目标】

展开最终冲突并回收剩余因果，
但为最后一章保留真正的结果确认和故事收束。

【主线推进维度】

- 可以展开最终冲突的阶段性交锋。
- 可以处理决战中的重大变化和关键选择。
- 所有行动必须来自前文已经建立的能力、关系、资源和信息。
- 不得另起新的大型主线。

【信息揭示维度】

- 可以揭示最后的核心事实和关键反转。
- 揭晓必须能从前文找到线索依据。
- 不得临时改写已经确立的基本规则。

【人物成长与关系维度】

- 可以完成人物最后的心理转变和立场选择。
- 可以回收主要人物关系。
- 必须让人物通过行动证明其最终选择。
- 应为最后一章保留正式归宿和结果确认。

【冲突与代价维度】

- 可以展示最终方案的执行过程。
- 决定性成功必须面对真实阻力。
- 已确立的代价不能在最后时刻无条件取消。
- 不得依靠突然救援、对手降智或万能新能力取胜。

【必须保留】

- 最终胜负的正式确认；
- 核心代价是否真正支付；
- 主要人物的最终归宿；
- 故事环境的最终变化；
- 正式结局或尾声。

【阶段结尾维度】

- 可以把最终冲突推进到决定结果的临界点。
- 不得提前写出完整结局和全部尾声内容。
""".strip()

    else:
        stage_name = "结局收束期"

        stage_rules = """
【阶段核心目标】

完成最终冲突，兑现核心代价，
并交代主要人物与故事环境发生的实际变化。

【最终冲突维度】

- 最终结果必须来自前文建立的选择、能力、关系、证据和资源。
- 不得依靠临时引入的人物、能力、规则或万能解决方案。
- 胜利或失败都必须符合已经建立的因果关系。
- 已明确的限制和代价不能无理由失效。

【人物收束维度】

- 回应主角最初动机与核心成长问题。
- 交代主要人物的归宿或明确去向。
- 交代关键人物关系的最终状态。
- 人物最终选择必须符合其成长轨迹。

【主线与伏笔维度】

- 回收决定主线结果的核心伏笔。
- 回应开篇建立的主要矛盾。
- 对必须回答的问题给出明确结果。
- 可以保留适量余韵或开放空间，
  但不能遗漏主线必须回答的内容。

【世界与环境维度】

- 展示最终冲突对人物生活、组织关系或故事环境造成的实际影响。
- 不只进行抽象总结，应体现具体变化。
- 如果秩序恢复或形成新状态，必须说明其因果基础。

【尾声维度】

- 尾声应服务于结果确认、人物归宿和主题回应。
- 不宜在结尾突然开启与当前故事无关的新主线。
- 如需保留续作空间，应与本书主线已经完成相兼容。
""".strip()

    self_check = """
【输出前强制自检】

生成章节蓝图前逐项检查：

1. 是否出现超出当前阶段的冲突、能力、身份或信息？
2. 是否提前公布全书核心秘密、幕后全貌或最终解决方式？
3. 是否在一个范围内加入过多新人物、新地点、新组织和新设定？
4. 是否存在无铺垫成长、无代价成功、突然救援或对手降智？
5. 人物关系和立场变化是否具有足够过程？
6. 伏笔回收是否有前文依据，并对后续产生实际影响？
7. 角色掌握的信息是否符合其亲历、调查和认知范围？
8. 范围结尾是否只开启相邻层级的下一目标？
9. 是否严格覆盖指定章节，章节编号连续、无缺失、无重复？
10. 是否误用了小说架构中不存在的人物、设定、组织或规则？

如果任意一项不符合，必须先降低推进速度、删除无依据内容
或补充必要因果，再输出章节蓝图。
""".strip()

    return (
        f"【本次生成范围】第 {start_chapter} 章至第 {end_chapter} 章\n"
        f"【全书总章数】{total_chapters} 章\n"
        f"【全书进度】{start_progress:.1%}—{end_progress:.1%}\n"
        f"【当前阶段】{stage_name}\n\n"
        f"{common_rules}\n\n"
        f"{stage_rules}\n\n"
        f"{self_check}"
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
    """
    生成可编辑的全书分卷规划，不直接修改章节蓝图。
    """
    total_chapters = max(1, int(number_of_chapters))
    volume_count = int(volume_count)

    if not 1 <= volume_count <= 20:
        raise ValueError("分卷数必须在 1-20 之间")

    repository = NovelProjectRepository(filepath)
    architecture_text = repository.read(
        repository.ARCHITECTURE
    ).strip()

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
    生成章节蓝图。

    参数说明：
        number_of_chapters：
            全书总章数。

        start_chapter、end_chapter：
            本次需要生成的章节范围。

        replace_range：
            是否删除已有范围并重新生成。

    已有蓝图存在时，会从请求范围中尚未生成的第一章继续。
    每个生成分块不会跨越叙事阶段边界。
    """
    total_chapters = max(1, int(number_of_chapters))
    start_chapter = max(1, int(start_chapter))
    end_chapter = max(
        start_chapter,
        int(end_chapter or total_chapters),
    )

    if end_chapter > total_chapters:
        raise ValueError("蓝图生成范围不能超过全书章节数")

    repository = NovelProjectRepository(filepath)
    arch_file = repository.path(repository.ARCHITECTURE)

    if not os.path.exists(arch_file):
        logging.warning(
            "Novel_architecture.txt not found. "
            "Please generate architecture first."
        )
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
        timeout=timeout,
    )

    filename_dir = repository.path(repository.DIRECTORY)
    existing_blueprint = read_file(filename_dir).strip()

    requested_chapters = end_chapter - start_chapter + 1
    chunk_size = compute_chunk_size(
        requested_chapters,
        max_tokens,
    )

    logging.info(
        "Novel chapters=%s, requested range=[%s..%s], "
        "base chunk_size=%s",
        total_chapters,
        start_chapter,
        end_chapter,
        chunk_size,
    )

    final_blueprint = existing_blueprint
    current_start = start_chapter

    if existing_blueprint:
        logging.info(
            "Resuming blueprint generation from existing content."
        )

        chapter_numbers = [
            int(value)
            for value in re.findall(
                r"第\s*(\d+)\s*章",
                existing_blueprint,
            )
        ]

        covered = {
            chapter_number
            for chapter_number in chapter_numbers
            if start_chapter <= chapter_number <= end_chapter
        }

        if replace_range and covered:
            final_blueprint = remove_chapter_range(
                existing_blueprint,
                start_chapter,
                end_chapter,
            )
            current_start = start_chapter
            covered = set()

        current_start = start_chapter

        while current_start in covered:
            current_start += 1

        if any(
            chapter_number > current_start
            for chapter_number in covered
        ):
            return OperationResult.fail(
                f"已有蓝图第 {start_chapter}-{end_chapter} 章不连续，"
                "请先补齐缺失章节或清理重复内容后再续写"
            )

    guidance_parts = []

    if user_guidance.strip():
        guidance_parts.append(user_guidance.strip())

    if phase.strip():
        guidance_parts.append(f"当前阶段：{phase.strip()}")

    guidance = "\n".join(guidance_parts).strip()

    while current_start <= end_chapter:
        stage_end = get_stage_end_chapter(
            total_chapters,
            current_start,
        )

        current_end = min(
            current_start + chunk_size - 1,
            end_chapter,
            stage_end,
        )

        stage_guardrail = blueprint_stage_guardrail(
            total_chapters,
            current_start,
            current_end,
        )

        prompt = (
            prompt_definitions.chunked_chapter_blueprint_prompt.format(
                novel_architecture=architecture_text,
                chapter_list=limit_chapter_blueprint(
                    final_blueprint,
                    100,
                ),
                number_of_chapters=total_chapters,
                n=current_start,
                m=current_end,
                user_guidance=guidance,
                stage_guardrail=stage_guardrail,
            )
        )

        logging.info(
            "Generating chapters [%s..%s], stage boundary=%s...",
            current_start,
            current_end,
            stage_end,
        )

        chunk_result = invoke_with_cleaning(
            llm_adapter,
            prompt,
        ).strip()

        if not chunk_result:
            logging.warning(
                "Chunk generation for chapters [%s..%s] is empty.",
                current_start,
                current_end,
            )

            repository.write(
                repository.DIRECTORY,
                final_blueprint.strip(),
            )

            return OperationResult.fail(
                f"第 {current_start}-{current_end} 章目录生成失败"
            )

        if final_blueprint.strip():
            final_blueprint += "\n\n" + chunk_result
        else:
            final_blueprint = chunk_result

        repository.write(
            repository.DIRECTORY,
            final_blueprint.strip(),
        )

        current_start = current_end + 1

    logging.info(
        "Novel_directory.txt (chapter blueprint) "
        "generated successfully."
    )

    return OperationResult.ok(
        "章节目录生成完成",
        final_blueprint,
        (filename_dir,),
    )

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
    """
    按照用户修改意见重写完整章节蓝图。

    只有模型成功返回非空内容时，才会覆盖原章节蓝图。
    """
    revision_guidance = revision_guidance.strip()

    if not revision_guidance:
        raise ValueError("请先填写个人修改意见")

    repository = NovelProjectRepository(filepath)
    architecture_text = repository.read(
        repository.ARCHITECTURE
    ).strip()

    if not architecture_text:
        raise ValueError("小说架构为空，请先生成或保存小说架构")

    prompt = prompt_definitions.blueprint_revision_prompt.format(
        number_of_chapters=max(1, int(number_of_chapters)),
        revision_guidance=revision_guidance,
        novel_architecture=architecture_text,
        current_blueprint=(
            current_blueprint.strip()
            or "（当前内容为空，请从头重写）"
        ),
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

    revised_text = invoke_with_cleaning(
        llm_adapter,
        prompt,
    ).strip()

    if not revised_text:
        logging.warning(
            "AI chapter blueprint rewrite returned empty content."
        )
        return ""

    repository.write(
        repository.DIRECTORY,
        revised_text,
    )

    return revised_text