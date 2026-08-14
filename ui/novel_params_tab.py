# ui/novel_params_tab.py
# -*- coding: utf-8 -*-
import customtkinter as ctk
from tkinter import messagebox

from tooltips import tooltips
from ui.context_menu import TextWidgetContextMenu


FONT = ("Microsoft YaHei", 12)
TITLE_FONT = ("Microsoft YaHei", 15, "bold")
SECTION_FONT = ("Microsoft YaHei", 13, "bold")


def _add_section(parent, row, title):
    if row:
        separator = ctk.CTkFrame(parent, height=1, fg_color=("gray75", "gray30"))
        separator.grid(row=row, column=0, sticky="ew", padx=8, pady=(10, 6))
        row += 1
    label = ctk.CTkLabel(parent, text=title, font=SECTION_FONT, anchor="w")
    label.grid(row=row, column=0, sticky="ew", padx=8, pady=(0, 4))
    return row + 1


def _add_textbox(parent, row, label_text, tooltip_key, height):
    line = ctk.CTkFrame(parent, fg_color="transparent")
    line.grid(row=row, column=0, sticky="ew", padx=8, pady=3)
    line.columnconfigure(1, weight=1)
    create_label_with_help_for_novel_params(
        None,
        parent=line,
        label_text=label_text,
        tooltip_key=tooltip_key,
        row=0,
        column=0,
        font=FONT,
        sticky="ne",
    )
    textbox = ctk.CTkTextbox(line, height=height, wrap="word", font=FONT)
    TextWidgetContextMenu(textbox)
    textbox.grid(row=0, column=1, sticky="ew", padx=(6, 0))
    return textbox, line


def build_project_setup_area(self, parent):
    """Build project path and resource preparation controls under Settings."""
    self.project_setup_frame = ctk.CTkFrame(parent)
    self.project_setup_frame.pack(fill="x", padx=10, pady=10)
    self.project_setup_frame.columnconfigure(0, weight=1)
    row = 0

    row = _add_section(self.project_setup_frame, row, "工程准备")
    path_line = ctk.CTkFrame(self.project_setup_frame, fg_color="transparent")
    path_line.grid(row=row, column=0, sticky="ew", padx=8, pady=3)
    path_line.columnconfigure(1, weight=1)
    create_label_with_help_for_novel_params(
        self, path_line, "工程目录", "filepath", 0, 0, font=FONT
    )
    path_entry = ctk.CTkEntry(path_line, textvariable=self.filepath_var, font=FONT)
    path_entry.grid(
        row=0, column=1, sticky="ew", padx=(6, 4)
    )
    path_entry.bind("<FocusOut>", lambda _event: self.persist_project_settings())
    path_entry.bind("<Return>", lambda _event: self.persist_project_settings())
    for variable in (
        self.filepath_var, self.genre_var, self.num_chapters_var,
        self.word_number_var, self.chapter_num_var, self.characters_involved_var,
        self.key_items_var, self.scene_location_var, self.time_constraint_var,
    ):
        variable.trace_add("write", lambda *_args: self._schedule_persist_project_settings())
    ctk.CTkButton(
        path_line, text="浏览...", command=self.browse_folder, width=64, font=FONT
    ).grid(row=0, column=2)
    row += 2

    prep_actions = ctk.CTkFrame(self.project_setup_frame, fg_color="transparent")
    prep_actions.grid(row=row, column=0, sticky="ew", padx=8, pady=4)
    prep_actions.columnconfigure(0, weight=1)

    def open_model_settings():
        self.tabview.set("设置")
        self.config_tabview.set("任务模型选择")

    ctk.CTkButton(
        prep_actions, text="配置任务模型", command=open_model_settings, font=FONT
    ).grid(row=0, column=0, sticky="ew")
    ctk.CTkButton(
        prep_actions, text="保存工程设置", command=self.persist_project_settings, font=FONT
    ).grid(row=0, column=1, padx=(6, 0), sticky="ew")
    prep_actions.columnconfigure(1, weight=1)


def build_architecture_params_area(self, parent):
    """Build the inputs used to generate the novel architecture."""
    self.params_frame = ctk.CTkScrollableFrame(
        parent,
        orientation="vertical",
        label_text="小说架构生成",
        label_font=TITLE_FONT,
    )
    self.params_frame.pack(fill="both", expand=True, padx=5, pady=5)
    self.params_frame.columnconfigure(0, weight=1)
    row = 0

    ctk.CTkLabel(
        self.params_frame,
        text="用于第一次生成，或你想用新设定重新生成架构时填写。",
        anchor="w",
        font=("Microsoft YaHei", 11),
        text_color=("#475467", "#98A2B3"),
    ).grid(row=row, column=0, sticky="ew", padx=8, pady=(4, 6))
    row += 1

    self.btn_import_knowledge = ctk.CTkButton(
        self.params_frame,
        text="管理参考资料（可选）",
        command=self.import_knowledge_handler,
        font=FONT,
        height=34,
    )
    self.btn_import_knowledge.grid(
        row=row, column=0, sticky="ew", padx=8, pady=(5, 4)
    )
    row += 1

    row = _add_section(self.params_frame, row, "全书规划输入")
    self.topic_text, _ = _add_textbox(
        self.params_frame, row, "故事主题", "topic", height=110
    )
    ctk.CTkLabel(
        self.params_frame,
        text="示例：一个失去记忆的守城人，在末日城市中寻找失踪妹妹，逐步发现自己曾是灾难制造者。",
        anchor="w",
        justify="left",
        wraplength=430,
        font=("Microsoft YaHei", 10),
        text_color=("#667085", "#98A2B3"),
    ).grid(row=row + 1, column=0, sticky="ew", padx=(92, 8), pady=(0, 3))
    if getattr(self, "topic_default", ""):
        self.topic_text.insert("0.0", self.topic_default)
    self.topic_text.bind("<KeyRelease>", lambda _event: self._schedule_persist_project_settings(), add="+")
    row += 2

    book_line = ctk.CTkFrame(self.params_frame, fg_color="transparent")
    book_line.grid(row=row, column=0, sticky="ew", padx=8, pady=3)
    book_line.columnconfigure(1, weight=1)
    ctk.CTkLabel(book_line, text="类型", font=FONT).grid(row=0, column=0, sticky="e")
    genre_entry = ctk.CTkEntry(book_line, textvariable=self.genre_var, font=FONT)
    genre_entry.grid(
        row=0, column=1, sticky="ew", padx=(6, 10)
    )
    ctk.CTkLabel(book_line, text="章节数", font=FONT).grid(row=0, column=2)
    chapters_entry = ctk.CTkEntry(book_line, textvariable=self.num_chapters_var, width=58, font=FONT)
    chapters_entry.grid(
        row=0, column=3, padx=(6, 0)
    )
    row += 1

    self.planning_guide_text, _ = _add_textbox(
        self.params_frame, row, "全书规划要求", "planning_guidance", height=120
    )
    ctk.CTkLabel(
        self.params_frame,
        text="可选示例：前 3 章完成主角入局；每 10 章安排一次阶段冲突；结局保留一个未解释的伏笔。不填写也可以。",
        anchor="w",
        justify="left",
        wraplength=430,
        font=("Microsoft YaHei", 10),
        text_color=("#667085", "#98A2B3"),
    ).grid(row=row + 1, column=0, sticky="ew", padx=(92, 8), pady=(0, 3))
    if getattr(self, "planning_guidance_default", ""):
        self.planning_guide_text.insert("0.0", self.planning_guidance_default)
    self.planning_guide_text.bind("<KeyRelease>", lambda _event: self._schedule_persist_project_settings(), add="+")
    row += 2

    skill_line = ctk.CTkFrame(self.params_frame, fg_color="transparent")
    skill_line.grid(row=row, column=0, sticky="ew", padx=8, pady=(2, 3))
    skill_line.columnconfigure(1, weight=1)
    ctk.CTkLabel(skill_line, text="写作技能", font=FONT).grid(row=0, column=0, sticky="e")
    from ui.skills_tab import open_skill_selector, update_skill_selection_label
    self.architecture_skill_selection_button = ctk.CTkButton(skill_line, text="选择写作技能（0）", command=lambda: open_skill_selector(self), font=FONT, height=30)
    self.architecture_skill_selection_button.grid(row=0, column=1, sticky="ew", padx=(6, 0))
    update_skill_selection_label(self)
    row += 1

    self.btn_generate_architecture = ctk.CTkButton(
        self.params_frame,
        text="开始生成全书架构",
        command=self.generate_novel_architecture_ui,
        font=FONT,
        height=34,
    )
    self.btn_generate_architecture.grid(row=row, column=0, sticky="ew", padx=8, pady=(5, 2))
    row += 1


def build_blueprint_generation_area(self, parent):
    """Build focused range/stage controls for the blueprint workstation."""
    self.blueprint_generation_frame = ctk.CTkFrame(parent)
    self.blueprint_generation_frame.grid(
        row=0, column=0, sticky="ew", padx=5, pady=(5, 2)
    )
    self.blueprint_generation_frame.columnconfigure(1, weight=1)
    self.blueprint_generation_frame.columnconfigure(3, weight=1)
    self.blueprint_generation_frame.columnconfigure(5, weight=1)
    ctk.CTkLabel(
        self.blueprint_generation_frame,
        text="蓝图生成范围",
        font=("Microsoft YaHei", 14, "bold"),
    ).grid(row=0, column=0, columnspan=6, sticky="w", padx=8, pady=(6, 2))
    ctk.CTkLabel(
        self.blueprint_generation_frame,
        text="可生成全书、指定章节范围，或只规划某个阶段。",
        anchor="w",
        text_color=("#667085", "#98A2B3"),
    ).grid(row=1, column=0, columnspan=6, sticky="w", padx=8, pady=(0, 6))
    ctk.CTkLabel(self.blueprint_generation_frame, text="模式").grid(row=2, column=0, padx=(8, 4), pady=4, sticky="e")
    ctk.CTkOptionMenu(
        self.blueprint_generation_frame,
        values=["全书蓝图", "指定范围", "阶段规划"],
        variable=self.blueprint_mode_var,
    ).grid(row=2, column=1, padx=(0, 8), pady=4, sticky="ew")
    start_label = ctk.CTkLabel(self.blueprint_generation_frame, text="起始章")
    start_label.grid(row=2, column=2, padx=(4, 4), pady=4, sticky="e")
    start_entry = ctk.CTkEntry(self.blueprint_generation_frame, textvariable=self.blueprint_start_var, width=70)
    start_entry.grid(row=2, column=3, padx=(0, 8), pady=4, sticky="ew")
    end_label = ctk.CTkLabel(self.blueprint_generation_frame, text="结束章")
    end_label.grid(row=2, column=4, padx=(4, 4), pady=4, sticky="e")
    end_entry = ctk.CTkEntry(self.blueprint_generation_frame, textvariable=self.blueprint_end_var, width=70)
    end_entry.grid(row=2, column=5, padx=(0, 8), pady=4, sticky="ew")
    phase_label = ctk.CTkLabel(self.blueprint_generation_frame, text="本卷重点 / 目标")
    phase_label.grid(row=3, column=0, padx=(8, 4), pady=4, sticky="e")
    phase_entry = ctk.CTkEntry(
        self.blueprint_generation_frame,
        textvariable=self.blueprint_phase_var,
        placeholder_text="例如：本卷完成主角入局并揭开身世线索",
    )
    phase_entry.grid(row=3, column=1, columnspan=5, padx=(0, 8), pady=4, sticky="ew")
    volume_count_label = ctk.CTkLabel(self.blueprint_generation_frame, text="分卷数")
    volume_count_label.grid(row=4, column=0, padx=(8, 4), pady=4, sticky="e")
    volume_count_entry = ctk.CTkEntry(self.blueprint_generation_frame, textvariable=self.blueprint_volume_count_var, width=70)
    volume_count_entry.grid(row=4, column=1, padx=(0, 8), pady=4, sticky="ew")
    current_volume_label = ctk.CTkLabel(self.blueprint_generation_frame, text="当前卷")
    current_volume_label.grid(row=4, column=2, padx=(4, 4), pady=4, sticky="e")
    current_volume_entry = ctk.CTkEntry(self.blueprint_generation_frame, textvariable=self.blueprint_current_volume_var, width=70)
    current_volume_entry.grid(row=4, column=3, padx=(0, 8), pady=4, sticky="ew")
    volume_plan_label = ctk.CTkLabel(self.blueprint_generation_frame, text="分卷规划（可手填或 AI 生成）")
    volume_plan_label.grid(row=5, column=0, columnspan=6, padx=8, pady=(4, 2), sticky="w")
    self.blueprint_volume_plan_text = ctk.CTkTextbox(self.blueprint_generation_frame, height=82, wrap="word")
    self.blueprint_volume_plan_text.grid(row=6, column=0, columnspan=6, padx=8, pady=(0, 4), sticky="ew")
    if getattr(self, "blueprint_volume_plan_default", ""):
        self.blueprint_volume_plan_text.insert("0.0", self.blueprint_volume_plan_default)
    self.blueprint_volume_plan_text.bind("<KeyRelease>", lambda _event: self._schedule_persist_project_settings(), add="+")
    from ui.context_menu import TextWidgetContextMenu
    TextWidgetContextMenu(self.blueprint_volume_plan_text)
    self.btn_generate_volume_plan = ctk.CTkButton(
        self.blueprint_generation_frame,
        text="AI 生成分卷规划",
        command=self.generate_volume_plan_ui,
        height=30,
    )
    self.btn_generate_volume_plan.grid(row=7, column=0, columnspan=3, sticky="ew", padx=8, pady=(2, 4))
    from ui.skills_tab import open_skill_selector, update_skill_selection_label
    self.blueprint_skill_selection_button = ctk.CTkButton(self.blueprint_generation_frame, text="选择写作技能（0）", command=lambda: open_skill_selector(self), font=FONT, height=30)
    self.blueprint_skill_selection_button.grid(row=7, column=3, columnspan=3, sticky="ew", padx=8, pady=(2, 4))
    update_skill_selection_label(self)
    self.btn_generate_directory = ctk.CTkButton(
        self.blueprint_generation_frame,
        text="生成所选范围蓝图",
        command=self.generate_chapter_blueprint_ui,
        font=FONT,
        height=34,
    )
    self.btn_generate_directory.grid(row=8, column=0, columnspan=6, sticky="ew", padx=8, pady=(4, 8))
    self._blueprint_range_widgets = (start_label, start_entry, end_label, end_entry)
    self._blueprint_phase_widgets = (phase_label, phase_entry)
    self._blueprint_volume_widgets = (
        volume_count_label, volume_count_entry, current_volume_label,
        current_volume_entry, volume_plan_label, self.blueprint_volume_plan_text,
        self.btn_generate_volume_plan,
    )
    self.blueprint_mode_var.trace_add("write", lambda *_args: update_blueprint_mode_visibility(self))
    update_blueprint_mode_visibility(self)


def update_blueprint_mode_visibility(self):
    """Show only controls relevant to the selected blueprint mode."""
    mode = self.blueprint_mode_var.get().strip()
    show_range = mode in {"指定范围", "阶段规划"}
    show_volume = mode == "阶段规划"
    for widget in self._blueprint_range_widgets:
        (widget.grid if show_range else widget.grid_remove)()
    for widget in self._blueprint_phase_widgets + self._blueprint_volume_widgets:
        (widget.grid if show_volume else widget.grid_remove)()

def build_chapter_params_area(self, start_row=0):
    self.chapter_params_frame = ctk.CTkScrollableFrame(
        self.chapter_right_frame,
        orientation="vertical",
        label_text="章节工作台",
        label_font=TITLE_FONT,
    )
    self.chapter_params_frame.grid(
        row=start_row, column=0, sticky="nsew", padx=5, pady=5
    )
    self.chapter_params_frame.columnconfigure(0, weight=1)
    row = 0

    row = _add_section(self.chapter_params_frame, row, "3-4  当前章节")
    chapter_line = ctk.CTkFrame(self.chapter_params_frame, fg_color="transparent")
    chapter_line.grid(row=row, column=0, sticky="ew", padx=8, pady=3)
    chapter_line.columnconfigure((1, 3), weight=1)
    ctk.CTkLabel(chapter_line, text="章节号", font=FONT).grid(row=0, column=0)
    ctk.CTkEntry(chapter_line, textvariable=self.chapter_num_var, width=72, font=FONT).grid(
        row=0, column=1, sticky="w", padx=(6, 12)
    )
    ctk.CTkLabel(chapter_line, text="目标字数", font=FONT).grid(row=0, column=2)
    ctk.CTkEntry(chapter_line, textvariable=self.word_number_var, width=72, font=FONT).grid(
        row=0, column=3, sticky="w", padx=(6, 0)
    )
    row += 1

    self.user_guide_text, _ = _add_textbox(
        self.chapter_params_frame, row, "本章写作要求", "chapter_guidance", height=96
    )
    if getattr(self, "chapter_guidance_default", ""):
        self.user_guide_text.insert("0.0", self.chapter_guidance_default)
    self.user_guide_text.bind("<KeyRelease>", lambda _event: self._schedule_persist_project_settings(), add="+")
    row += 1

    skill_line = ctk.CTkFrame(self.chapter_params_frame, fg_color="transparent")
    skill_line.grid(row=row, column=0, sticky="ew", padx=8, pady=(4, 3))
    skill_line.columnconfigure(1, weight=1)
    ctk.CTkLabel(skill_line, text="写作技能", font=FONT).grid(row=0, column=0, sticky="e")
    from ui.skills_tab import open_skill_selector, update_skill_selection_label
    self.skill_selection_button = ctk.CTkButton(skill_line, text="选择写作技能（0）", command=lambda: open_skill_selector(self), font=FONT, height=30)
    self.skill_selection_button.grid(row=0, column=1, sticky="ew", padx=(6, 0))
    ctk.CTkLabel(skill_line, text="本次生成可多选", font=("Microsoft YaHei", 10), text_color=("#667085", "#98A2B3")).grid(row=0, column=2, padx=(6, 0))
    update_skill_selection_label(self)
    row += 1

    self.char_inv_text, character_line = _add_textbox(
        self.chapter_params_frame, row, "核心人物", "characters_involved", height=64
    )
    initial_characters = self.characters_involved_var.get().strip()
    if initial_characters:
        self.char_inv_text.insert("0.0", initial_characters)
    self.char_inv_text.bind(
        "<KeyRelease>",
        lambda _event: self.characters_involved_var.set(
            self.char_inv_text.get("0.0", "end").strip()
        ),
    )
    ctk.CTkButton(
        character_line,
        text="从角色库选择",
        width=96,
        command=self.show_character_import_window,
        font=("Microsoft YaHei", 11),
    ).grid(row=0, column=2, padx=(4, 0))
    row += 1

    detail_line = ctk.CTkFrame(self.chapter_params_frame, fg_color="transparent")
    detail_line.grid(row=row, column=0, sticky="ew", padx=8, pady=3)
    detail_line.columnconfigure((1, 3), weight=1)
    ctk.CTkLabel(detail_line, text="关键道具", font=FONT).grid(row=0, column=0)
    ctk.CTkEntry(detail_line, textvariable=self.key_items_var, font=FONT).grid(
        row=0, column=1, sticky="ew", padx=(6, 10)
    )
    ctk.CTkLabel(detail_line, text="主要场景", font=FONT).grid(row=0, column=2)
    ctk.CTkEntry(detail_line, textvariable=self.scene_location_var, font=FONT).grid(
        row=0, column=3, sticky="ew", padx=(6, 0)
    )
    row += 1
    time_line = ctk.CTkFrame(self.chapter_params_frame, fg_color="transparent")
    time_line.grid(row=row, column=0, sticky="ew", padx=8, pady=3)
    time_line.columnconfigure(1, weight=1)
    create_label_with_help_for_novel_params(
        self, time_line, "时间压力", "time_constraint", 0, 0, font=FONT
    )
    ctk.CTkEntry(time_line, textvariable=self.time_constraint_var, font=FONT).grid(
        row=0, column=1, sticky="ew", padx=(6, 0)
    )
    row += 1

    self.btn_generate_chapter = ctk.CTkButton(
        self.chapter_params_frame,
        text="生成当前章节草稿",
        command=self.generate_chapter_draft_ui,
        font=FONT,
        height=34,
    )
    self.btn_generate_chapter.grid(row=row, column=0, sticky="ew", padx=8, pady=(5, 2))
    row += 1
    self.btn_save_draft = ctk.CTkButton(
        self.chapter_params_frame,
        text="保存当前草稿",
        command=self.save_current_draft,
        font=FONT,
        height=32,
    )
    self.btn_save_draft.grid(row=row, column=0, sticky="ew", padx=8, pady=(2, 2))
    row += 1
    ctk.CTkLabel(
        self.chapter_params_frame,
        text="↓  检查并在左侧直接编辑正文",
        font=("Microsoft YaHei", 11),
    ).grid(row=row, column=0, pady=1)
    row += 1

    self.revision_guide_text, _ = _add_textbox(
        self.chapter_params_frame,
        row,
        "AI 修改意见",
        "revision_guidance",
        height=86,
    )
    row += 1
    self.btn_revise_chapter = ctk.CTkButton(
        self.chapter_params_frame,
        text="根据意见修改正文",
        command=self.revise_chapter_draft_ui,
        font=FONT,
        height=34,
    )
    self.btn_revise_chapter.grid(
        row=row, column=0, sticky="ew", padx=8, pady=(2, 1)
    )
    row += 1
    ctk.CTkLabel(
        self.chapter_params_frame,
        text="↺  不满意可继续填写意见并修改",
        font=("Microsoft YaHei", 11),
    ).grid(row=row, column=0, pady=(1, 4))
    row += 1

    review_actions = ctk.CTkFrame(self.chapter_params_frame, fg_color="transparent")
    review_actions.grid(row=row, column=0, sticky="ew", padx=8, pady=2)
    review_actions.columnconfigure((0, 1), weight=1)
    self.btn_check_consistency = ctk.CTkButton(
        review_actions, text="一致性审校", command=self.do_consistency_check, font=FONT
    )
    self.btn_check_consistency.grid(row=0, column=0, sticky="ew", padx=(0, 3))
    self.btn_finalize_chapter = ctk.CTkButton(
        review_actions,
        text="定稿并更新全书记忆",
        command=self.finalize_chapter_ui,
        font=FONT,
    )
    self.btn_finalize_chapter.grid(row=0, column=1, sticky="ew", padx=(3, 0))
    row += 1
    ctk.CTkLabel(
        self.chapter_params_frame,
        text="定稿完成  →  章节号 +1  →  继续下一章",
        font=("Microsoft YaHei", 11),
    ).grid(row=row, column=0, pady=(2, 8))


def build_optional_buttons_area(self, start_row=1):
    self.optional_btn_frame = ctk.CTkFrame(self.chapter_right_frame)
    self.optional_btn_frame.grid(row=start_row, column=0, sticky="ew", padx=5, pady=(0, 5))
    self.optional_btn_frame.columnconfigure((0, 1, 2, 3), weight=1)

    self.role_library_btn = ctk.CTkButton(
        self.optional_btn_frame, text="角色库", command=self.show_role_library, font=FONT
    )
    self.role_library_btn.grid(row=0, column=0, padx=(5, 2), pady=5, sticky="ew")
    self.plot_arcs_btn = ctk.CTkButton(
        self.optional_btn_frame, text="剧情要点", command=self.show_plot_arcs_ui, font=FONT
    )
    self.plot_arcs_btn.grid(row=0, column=1, padx=2, pady=5, sticky="ew")
    self.btn_batch_generate = ctk.CTkButton(
        self.optional_btn_frame, text="批量生成", command=self.generate_batch_ui, font=FONT
    )
    self.btn_batch_generate.grid(row=0, column=2, padx=2, pady=5, sticky="ew")
    self.btn_clear_vectorstore = ctk.CTkButton(
        self.optional_btn_frame,
        text="清空向量库",
        fg_color=("#b42318", "#8f1d16"),
        hover_color=("#912018", "#731712"),
        command=self.clear_vectorstore_handler,
        font=FONT,
    )
    self.btn_clear_vectorstore.grid(row=0, column=3, padx=(2, 5), pady=5, sticky="ew")


def create_label_with_help_for_novel_params(
    self,
    parent,
    label_text,
    tooltip_key,
    row,
    column,
    font=None,
    sticky="e",
    padx=0,
    pady=0,
):
    frame = ctk.CTkFrame(parent, fg_color="transparent")
    frame.grid(row=row, column=column, padx=padx, pady=pady, sticky=sticky)
    label = ctk.CTkLabel(frame, text=label_text, font=font)
    label.pack(side="left")
    btn = ctk.CTkButton(
        frame,
        text="?",
        width=22,
        height=22,
        font=("Microsoft YaHei", 10),
        command=lambda: messagebox.showinfo(
            "参数说明", tooltips.get(tooltip_key, "暂无说明")
        ),
    )
    btn.pack(side="left", padx=(3, 0))
    return frame
