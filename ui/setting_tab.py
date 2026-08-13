# ui/setting_tab.py
# -*- coding: utf-8 -*-
import os
import customtkinter as ctk
from tkinter import messagebox, simpledialog, ttk

from novel_generator.architecture_sections import (
    append_architecture_overview_section,
    append_architecture_subsection,
    delete_architecture_section,
    parse_architecture_sections,
    replace_architecture_section,
    upsert_architecture_overview_section_body,
    upsert_architecture_subsection_body,
)
from novel_generator.storage import NovelProjectRepository
from utils import read_file, save_string_to_txt, get_word_count
from ui.context_menu import TextWidgetContextMenu
from ui.novel_params_tab import build_architecture_params_area


def build_setting_tab(self):
    self.setting_tab = self.tabview.add("小说架构")
    self.setting_tab.rowconfigure(0, weight=0)
    self.setting_tab.rowconfigure(1, weight=1)
    self.setting_tab.columnconfigure(0, weight=3, uniform="architecture_columns")
    self.setting_tab.columnconfigure(1, weight=2, uniform="architecture_columns")

    workflow = ctk.CTkFrame(self.setting_tab, fg_color=("#F2F4F7", "#252B33"))
    workflow.grid(row=0, column=0, columnspan=2, sticky="ew", padx=5, pady=(5, 2))
    workflow.columnconfigure(0, weight=1)
    workflow.columnconfigure(1, weight=1)
    workflow.columnconfigure(2, weight=1)
    workflow.columnconfigure(3, weight=1)
    self.architecture_step_labels = []
    for index, title in enumerate(("1 准备输入", "2 生成架构", "3 检查修改", "4 生成章节蓝图")):
        label = ctk.CTkLabel(
            workflow,
            text=title,
            height=30,
            anchor="center",
            font=("Microsoft YaHei", 11, "bold"),
            text_color=("#667085", "#98A2B3"),
        )
        label.grid(row=0, column=index, sticky="ew", padx=2, pady=2)
        self.architecture_step_labels.append(label)
    self.architecture_next_step_label = ctk.CTkLabel(
        workflow,
        text="请先填写右侧的全书规划输入。",
        anchor="w",
        font=("Microsoft YaHei", 11),
        text_color=("#475467", "#D0D5DD"),
    )
    self.architecture_next_step_label.grid(
        row=1, column=0, columnspan=4, sticky="ew", padx=10, pady=(0, 5)
    )

    editor_frame = ctk.CTkFrame(self.setting_tab)
    editor_frame.grid(row=1, column=0, sticky="nsew", padx=(5, 2), pady=5)
    editor_frame.rowconfigure(1, weight=1)
    editor_frame.columnconfigure(0, weight=1)

    params_frame = ctk.CTkFrame(self.setting_tab)
    params_frame.grid(row=1, column=1, sticky="nsew", padx=(2, 5), pady=5)
    params_frame.rowconfigure(1, weight=1)
    params_frame.columnconfigure(0, weight=1)
    self.architecture_input_summary = ctk.CTkLabel(
        params_frame,
        text="创建输入",
        anchor="w",
        font=("Microsoft YaHei", 13, "bold"),
    )
    self.architecture_input_summary.grid(row=0, column=0, sticky="ew", padx=10, pady=(8, 2))
    self.architecture_input_toggle = ctk.CTkButton(
        params_frame,
        text="收起输入区",
        width=110,
        height=28,
        command=self.toggle_architecture_input_panel,
    )
    self.architecture_input_toggle.grid(row=0, column=1, padx=(4, 8), pady=(6, 2), sticky="e")
    params_frame.columnconfigure(1, weight=0)
    self.architecture_input_host = ctk.CTkFrame(params_frame, fg_color="transparent")
    self.architecture_input_host.grid(row=1, column=0, columnspan=2, sticky="nsew")
    self.architecture_input_host.rowconfigure(0, weight=1)
    self.architecture_input_host.columnconfigure(0, weight=1)
    build_architecture_params_area(self, self.architecture_input_host)

    toolbar = ctk.CTkFrame(editor_frame, fg_color="transparent")
    toolbar.grid(row=0, column=0, sticky="ew", padx=5, pady=5)
    toolbar.columnconfigure(1, weight=1)

    load_btn = ctk.CTkButton(
        toolbar,
        text="重新加载文件",
        command=self.load_novel_architecture,
        font=("Microsoft YaHei", 12),
    )
    load_btn.grid(row=0, column=0, padx=(0, 8), sticky="w")

    self.setting_word_count_label = ctk.CTkLabel(
        toolbar, text="字数：0", font=("Microsoft YaHei", 12)
    )
    self.setting_word_count_label.grid(row=0, column=1, sticky="w")

    clear_btn = ctk.CTkButton(
        toolbar,
        text="清空内容",
        command=self.clear_novel_architecture,
        width=90,
        fg_color="#c0392b",
        hover_color="#a93226",
        font=("Microsoft YaHei", 12),
    )
    clear_btn.grid(row=0, column=2, padx=8, sticky="e")

    save_btn = ctk.CTkButton(
        toolbar,
        text="保存修改",
        command=self.save_novel_architecture,
        width=90,
        font=("Microsoft YaHei", 12),
    )
    save_btn.grid(row=0, column=3, sticky="e")

    self.architecture_editor_tabview = ctk.CTkTabview(
        editor_frame,
        command=self.on_architecture_editor_tab_changed,
    )
    self.architecture_editor_tabview.grid(
        row=1, column=0, sticky="nsew", padx=5, pady=(0, 5)
    )
    complete_tab = self.architecture_editor_tabview.add("完整架构")
    section_tab = self.architecture_editor_tabview.add("高级分区编辑")
    complete_tab.rowconfigure(0, weight=3)
    complete_tab.rowconfigure(2, weight=1)
    complete_tab.columnconfigure(0, weight=1)

    self.setting_text = ctk.CTkTextbox(
        complete_tab, wrap="word", font=("Microsoft YaHei", 12)
    )
    TextWidgetContextMenu(self.setting_text)
    self.setting_text.grid(row=0, column=0, sticky="nsew", padx=3, pady=(3, 5))

    ctk.CTkLabel(
        complete_tab,
        text="整篇修改意见",
        anchor="w",
        font=("Microsoft YaHei", 12, "bold"),
    ).grid(row=1, column=0, sticky="ew", padx=3, pady=(4, 2))
    self.architecture_revision_guide_text = ctk.CTkTextbox(
        complete_tab, wrap="word", height=90, font=("Microsoft YaHei", 12)
    )
    TextWidgetContextMenu(self.architecture_revision_guide_text)
    self.architecture_revision_guide_text.grid(
        row=2, column=0, sticky="nsew", padx=3, pady=(0, 5)
    )

    self.btn_revise_architecture = ctk.CTkButton(
        complete_tab,
        text="AI 重写完整架构",
        command=self.revise_novel_architecture_ui,
        height=34,
        font=("Microsoft YaHei", 12),
    )
    self.btn_revise_architecture.grid(
        row=3, column=0, sticky="ew", padx=3, pady=(0, 3)
    )

    _build_section_editor(self, section_tab)

    def update_word_count(event=None):
        text = self.setting_text.get("0.0", "end-1c")
        self.setting_word_count_label.configure(text=f"字数：{get_word_count(text)}")

    self.setting_text.bind("<KeyRelease>", update_word_count)
    self.setting_text.bind("<ButtonRelease>", update_word_count)
    self.update_architecture_workflow_state()


def update_architecture_workflow_state(self):
    """Keep the architecture page focused on the user's next actionable step."""
    try:
        has_architecture = bool(self.setting_text.get("0.0", "end-1c").strip())
    except (AttributeError, ctk.TclError):
        has_architecture = False
    if has_architecture:
        active_index = 2
        next_text = "架构已生成：先检查全文内容；确认后可切换到“章节蓝图”生成目录。"
    else:
        active_index = 1
        next_text = "请先完成右侧 4 项输入，然后点击“开始生成全书架构”。"
    for index, label in enumerate(getattr(self, "architecture_step_labels", ())):
        if index == active_index:
            label.configure(
                fg_color=("#D1E9FF", "#164C7E"),
                text_color=("#175CD3", "#B2DDFF"),
                corner_radius=6,
            )
        else:
            label.configure(fg_color="transparent", text_color=("#667085", "#98A2B3"))
    if getattr(self, "architecture_next_step_label", None) is not None:
        self.architecture_next_step_label.configure(text=f"下一步：{next_text}")
    self.update_architecture_input_visibility(has_architecture)


def update_architecture_input_visibility(self, has_architecture=None):
    if has_architecture is None:
        try:
            has_architecture = bool(self.setting_text.get("0.0", "end-1c").strip())
        except (AttributeError, ctk.TclError):
            has_architecture = False
    host = getattr(self, "architecture_input_host", None)
    if host is None:
        return
    if has_architecture:
        host.grid_remove()
        self.architecture_input_summary.configure(text="架构已存在")
        self.architecture_input_toggle.configure(text="重新生成 / 调整")
    else:
        host.grid()
        self.architecture_input_summary.configure(text="创建输入")
        self.architecture_input_toggle.configure(text="收起输入区")


def toggle_architecture_input_panel(self):
    host = getattr(self, "architecture_input_host", None)
    if host is None:
        return
    if host.winfo_ismapped():
        host.grid_remove()
        self.architecture_input_summary.configure(text="创建输入（已收起）")
        self.architecture_input_toggle.configure(text="展开输入区")
    else:
        host.grid()
        self.architecture_input_summary.configure(text="创建输入")
        self.architecture_input_toggle.configure(text="收起输入区")


def _build_section_editor(self, parent):
    parent.rowconfigure(2, weight=1)
    parent.columnconfigure(0, weight=1)
    parent.columnconfigure(1, weight=3)

    section_toolbar = ctk.CTkFrame(parent, fg_color="transparent")
    section_toolbar.grid(row=0, column=0, columnspan=2, sticky="ew", padx=3, pady=3)
    section_toolbar.columnconfigure(4, weight=1)
    ctk.CTkButton(
        section_toolbar,
        text="刷新分区",
        width=88,
        command=self.refresh_architecture_sections,
    ).grid(row=0, column=0, padx=(0, 6))
    ctk.CTkButton(
        section_toolbar,
        text="新增子分区",
        width=96,
        command=self.add_architecture_subsection,
    ).grid(row=0, column=1, padx=(0, 6))
    self.btn_extract_architecture_section = ctk.CTkButton(
        section_toolbar,
        text="选择文件提炼",
        width=108,
        command=self.extract_architecture_section_from_files_ui,
    )
    self.btn_extract_architecture_section.grid(row=0, column=2, padx=(0, 6))
    self.btn_delete_architecture_section = ctk.CTkButton(
        section_toolbar,
        text="删除分区",
        width=88,
        command=self.delete_architecture_section,
        fg_color="#c0392b",
        hover_color="#a93226",
    )
    self.btn_delete_architecture_section.grid(row=0, column=3, padx=(0, 6))
    self.architecture_section_status_label = ctk.CTkLabel(
        section_toolbar,
        text="从左侧选择要单独修改的内容",
        anchor="w",
    )
    self.architecture_section_status_label.grid(row=0, column=4, sticky="ew")

    extraction_options = ctk.CTkFrame(parent, fg_color="transparent")
    extraction_options.grid(
        row=1, column=0, columnspan=2, sticky="ew", padx=3, pady=(0, 4)
    )
    extraction_options.columnconfigure(2, weight=1)
    ctk.CTkLabel(extraction_options, text="当前父分区").grid(
        row=0, column=0, padx=(0, 6), sticky="w"
    )
    self.architecture_extraction_parent_label = ctk.CTkLabel(
        extraction_options,
        text="请从总览下选择具体分区",
        width=155,
        anchor="w",
    )
    self.architecture_extraction_parent_label.grid(row=0, column=1, padx=(0, 6))
    self.architecture_extraction_title_entry = ctk.CTkEntry(
        extraction_options,
        placeholder_text="新建/更新的直接子分区名称，例如：境界体系",
        width=220,
    )
    self.architecture_extraction_title_entry.grid(
        row=0, column=2, padx=(0, 6), sticky="ew"
    )
    self.architecture_extraction_location_label = ctk.CTkLabel(
        extraction_options,
        text="提炼结果固定放在当前选中分区下面；同名时原位更新",
        anchor="w",
    )
    self.architecture_extraction_location_label.grid(
        row=0, column=3, sticky="ew"
    )

    tree_frame = ctk.CTkFrame(parent)
    tree_frame.grid(row=2, column=0, rowspan=4, sticky="nsew", padx=(3, 4), pady=(0, 3))
    tree_frame.rowconfigure(0, weight=1)
    tree_frame.columnconfigure(0, weight=1)
    self.architecture_section_tree = ttk.Treeview(
        tree_frame,
        show="tree",
        selectmode="browse",
    )
    tree_scrollbar = ttk.Scrollbar(
        tree_frame,
        orient="vertical",
        command=self.architecture_section_tree.yview,
    )
    self.architecture_section_tree.configure(yscrollcommand=tree_scrollbar.set)
    self.architecture_section_tree.grid(row=0, column=0, sticky="nsew", padx=(4, 0), pady=4)
    tree_scrollbar.grid(row=0, column=1, sticky="ns", padx=(0, 4), pady=4)
    self.architecture_section_tree.bind(
        "<<TreeviewSelect>>", self.on_architecture_section_selected
    )
    self._architecture_sections_by_id = {}
    self._architecture_overview_item = "architecture-overview"
    self._architecture_active_item_id = None
    self._architecture_active_section_key = None
    self._architecture_active_original_text = ""
    self._architecture_active_document_snapshot = ""
    self._architecture_pending_save = False
    self._architecture_pending_reason = ""
    self._architecture_tree_selection_guard = False

    self.architecture_section_text = ctk.CTkTextbox(
        parent, wrap="word", font=("Microsoft YaHei", 12)
    )
    TextWidgetContextMenu(self.architecture_section_text)
    self.architecture_section_text.grid(
        row=2, column=1, sticky="nsew", padx=(4, 3), pady=(0, 4)
    )

    ctk.CTkLabel(
        parent,
        text="本分区 AI 修改要求",
        anchor="w",
        font=("Microsoft YaHei", 12, "bold"),
    ).grid(row=3, column=1, sticky="ew", padx=(4, 3), pady=(2, 2))
    self.architecture_section_guide_text = ctk.CTkTextbox(
        parent, wrap="word", height=80, font=("Microsoft YaHei", 12)
    )
    TextWidgetContextMenu(self.architecture_section_guide_text)
    self.architecture_section_guide_text.grid(
        row=4, column=1, sticky="ew", padx=(4, 3), pady=(0, 4)
    )

    section_actions = ctk.CTkFrame(parent, fg_color="transparent")
    section_actions.grid(row=5, column=1, sticky="ew", padx=(4, 3), pady=(0, 3))
    section_actions.columnconfigure(0, weight=1)
    section_actions.columnconfigure(1, weight=1)
    section_actions.columnconfigure(2, weight=1)
    ctk.CTkButton(
        section_actions,
        text="同步总架构",
        command=self.sync_architecture_section,
        height=34,
    ).grid(row=0, column=0, sticky="ew", padx=(0, 3))
    ctk.CTkButton(
        section_actions,
        text="保存本分区",
        command=self.save_architecture_section,
        height=34,
    ).grid(row=0, column=1, sticky="ew", padx=3)
    self.btn_revise_architecture_section = ctk.CTkButton(
        section_actions,
        text="AI 重写本分区",
        command=self.revise_architecture_section_ui,
        height=34,
    )
    self.btn_revise_architecture_section.grid(
        row=0, column=2, sticky="ew", padx=(3, 0)
    )


def _architecture_text(self):
    return self.setting_text.get("0.0", "end-1c")


def _show_complete_architecture(self, content):
    self.setting_text.delete("0.0", "end")
    self.setting_text.insert("0.0", content)
    self.setting_word_count_label.configure(text=f"字数：{get_word_count(content)}")


def on_architecture_editor_tab_changed(self):
    if self.architecture_editor_tabview.get() == "高级分区编辑":
        self.refresh_architecture_sections()


def architecture_section_tree_key(section, sections):
    """Build a stable hierarchy key that survives character-offset changes."""
    path = []
    current = section
    while current is not None:
        sibling_number = 0
        for candidate in sections[:current.index]:
            if (
                candidate.parent_index == current.parent_index
                and candidate.heading == current.heading
            ):
                sibling_number += 1
        path.append((current.heading, sibling_number))
        current = (
            sections[current.parent_index]
            if current.parent_index is not None
            else None
        )
    return tuple(reversed(path))


def _capture_architecture_tree_state(self):
    """Remember open/closed nodes before rebuilding the parsed tree."""
    sections = sorted(
        self._architecture_sections_by_id.values(),
        key=lambda item: item.index,
    )
    state = {}
    for item_id, section in self._architecture_sections_by_id.items():
        if self.architecture_section_tree.exists(item_id):
            state[architecture_section_tree_key(section, sections)] = bool(
                self.architecture_section_tree.item(item_id, "open")
            )
    overview_open = True
    if self.architecture_section_tree.exists(self._architecture_overview_item):
        overview_open = bool(
            self.architecture_section_tree.item(
                self._architecture_overview_item, "open"
            )
        )
    return state, overview_open


def refresh_architecture_sections(
    self,
    select_heading=None,
    select_start=None,
    select_key=None,
):
    open_state, overview_open = _capture_architecture_tree_state(self)
    current_selection = self.architecture_section_tree.selection()
    select_overview = bool(
        current_selection
        and current_selection[0] == self._architecture_overview_item
        and select_heading is None
        and select_start is None
        and select_key is None
    )
    if (
        select_heading is None
        and select_start is None
        and select_key is None
        and current_selection
    ):
        selected = self._architecture_sections_by_id.get(current_selection[0])
        select_heading = selected.heading if selected else None

    self._architecture_tree_selection_guard = True
    try:
        self.architecture_section_tree.delete(
            *self.architecture_section_tree.get_children()
        )
        self._architecture_sections_by_id = {}
        sections = parse_architecture_sections(_architecture_text(self))
        self.architecture_section_tree.insert(
            "",
            "end",
            iid=self._architecture_overview_item,
            text="总览",
            open=overview_open,
        )
        item_by_index = {}
        selected_item = None
        for section in sections:
            item_id = f"section-{section.index}"
            parent_id = item_by_index.get(
                section.parent_index, self._architecture_overview_item
            )
            section_key = architecture_section_tree_key(section, sections)
            self.architecture_section_tree.insert(
                parent_id,
                "end",
                iid=item_id,
                text=section.title,
                open=open_state.get(section_key, False),
            )
            item_by_index[section.index] = item_id
            self._architecture_sections_by_id[item_id] = section
            if select_key is not None and select_key == section_key:
                selected_item = item_id
            elif select_start is not None and select_start == section.start:
                selected_item = item_id
            elif (
                select_key is None
                and select_start is None
                and select_heading == section.heading
            ):
                selected_item = item_id
    finally:
        self._architecture_tree_selection_guard = False

    if not sections:
        self.architecture_section_text.delete("0.0", "end")
        self._set_architecture_tree_selection(self._architecture_overview_item)
        self.architecture_section_tree.focus(self._architecture_overview_item)
        self.architecture_section_status_label.configure(
            text="当前：总览（可新增顶层分区）"
        )
        self.architecture_extraction_parent_label.configure(text="总览")
        return

    selected_item = (
        self._architecture_overview_item
        if select_overview
        else selected_item or item_by_index[sections[0].index]
    )
    self._set_architecture_tree_selection(selected_item)
    self.architecture_section_tree.focus(selected_item)
    self.architecture_section_tree.see(selected_item)
    self._display_architecture_section(selected_item)


def on_architecture_section_selected(self, event=None):
    if self._architecture_tree_selection_guard:
        return
    selection = self.architecture_section_tree.selection()
    if not selection:
        return
    target_item = selection[0]
    active_item = self._architecture_active_item_id
    if active_item is not None and target_item == active_item:
        return
    if active_item is not None and target_item != active_item:
        target_key = self._architecture_item_key(target_item)
        if self.architecture_section_has_unsaved_changes():
            current_name = self._architecture_active_title()
            reasons = self.architecture_section_unsaved_reasons()
            reason_text = "\n".join(f"- {reason}" for reason in reasons)
            choice = messagebox.askyesnocancel(
                "分区尚未保存",
                f"“{current_name}”存在以下未保存内容：\n\n"
                f"{reason_text}\n\n"
                "选择“是”保存后切换，选择“否”放弃修改，选择“取消”继续编辑。",
            )
            if choice is None:
                self._set_architecture_tree_selection(active_item)
                return
            if choice:
                if not self._save_active_architecture_section():
                    self._set_architecture_tree_selection(active_item)
                    return
            else:
                _show_complete_architecture(
                    self, self._architecture_active_document_snapshot
                )
            self._architecture_pending_save = False
            self._architecture_pending_reason = ""
            self.refresh_architecture_sections(select_key=target_key)
            return
    self._display_architecture_section(target_item)


def _display_architecture_section(self, item_id):
    if item_id == self._architecture_overview_item:
        document = _architecture_text(self)
        self.architecture_section_text.delete("0.0", "end")
        self.architecture_section_text.insert("0.0", document)
        self.architecture_section_status_label.configure(text="当前：总览")
        self.architecture_extraction_parent_label.configure(
            text="总览（将新增顶层分区）"
        )
        self._set_architecture_active_baseline(item_id, None, document)
        return
    section = self._architecture_sections_by_id.get(item_id)
    if section is None:
        return
    document = _architecture_text(self)
    try:
        content = section.content_from(document)
        if not content.startswith(section.heading):
            raise ValueError
    except (ValueError, IndexError):
        self.refresh_architecture_sections()
        return
    self.architecture_section_text.delete("0.0", "end")
    self.architecture_section_text.insert("0.0", content)
    self.architecture_section_status_label.configure(text=f"当前：{section.title}")
    self.architecture_extraction_parent_label.configure(text=section.title)
    self._set_architecture_active_baseline(item_id, section, content)


def _set_architecture_active_baseline(self, item_id, section, editor_text):
    sections = sorted(
        self._architecture_sections_by_id.values(), key=lambda item: item.index
    )
    self._architecture_active_item_id = item_id
    self._architecture_active_section_key = (
        architecture_section_tree_key(section, sections)
        if section is not None
        else None
    )
    self._architecture_active_original_text = editor_text
    self._architecture_active_document_snapshot = _architecture_text(self)
    self._architecture_pending_save = False
    self._architecture_pending_reason = ""


def _set_architecture_tree_selection(self, item_id):
    self._architecture_tree_selection_guard = True
    try:
        self.architecture_section_tree.selection_set(item_id)
    finally:
        self._architecture_tree_selection_guard = False


def _architecture_item_key(self, item_id):
    if item_id == self._architecture_overview_item:
        return None
    section = self._architecture_sections_by_id.get(item_id)
    if section is None:
        return None
    sections = sorted(
        self._architecture_sections_by_id.values(), key=lambda item: item.index
    )
    return architecture_section_tree_key(section, sections)


def _architecture_active_title(self):
    if self._architecture_active_item_id == self._architecture_overview_item:
        return "总览"
    section = self._architecture_sections_by_id.get(
        self._architecture_active_item_id
    )
    return section.title if section is not None else "当前分区"


def architecture_section_has_unsaved_changes(self):
    return bool(self.architecture_section_unsaved_reasons())


def architecture_section_unsaved_reasons(self):
    reasons = []
    current_text = self.architecture_section_text.get("0.0", "end-1c")
    if current_text != self._architecture_active_original_text:
        reasons.append(
            f"分区“{self._architecture_active_title()}”的正文已修改，"
            "编辑框内容尚未写入 Novel_architecture.txt"
        )
    if self._architecture_pending_save:
        reasons.append(
            self._architecture_pending_reason
            or "总架构编辑区包含尚未写入 Novel_architecture.txt 的分区变更"
        )
    return tuple(reasons)


def _save_active_architecture_section(self):
    filepath = self.filepath_var.get().strip()
    if not filepath:
        messagebox.showwarning("警告", "请先设置保存文件路径。")
        return False
    document = _architecture_text(self)
    editor_text = self.architecture_section_text.get("0.0", "end-1c")
    try:
        if self._architecture_active_item_id == self._architecture_overview_item:
            merged = editor_text
        else:
            sections = parse_architecture_sections(document)
            section = next(
                (
                    item
                    for item in sections
                    if architecture_section_tree_key(item, sections)
                    == self._architecture_active_section_key
                ),
                None,
            )
            if section is None:
                raise ValueError("当前分区位置已经失效，请刷新后重试")
            merged = replace_architecture_section(document, section, editor_text)
        NovelProjectRepository(filepath).write(
            NovelProjectRepository.ARCHITECTURE, merged
        )
    except (OSError, ValueError) as exc:
        messagebox.showerror("保存失败", str(exc))
        return False
    _show_complete_architecture(self, merged)
    self._architecture_pending_save = False
    self._architecture_pending_reason = ""
    self.log(f"已保存小说架构分区：{self._architecture_active_title()}。")
    return True


def get_selected_architecture_section(self):
    selection = self.architecture_section_tree.selection()
    if not selection:
        return None
    return self._architecture_sections_by_id.get(selection[0])


def is_architecture_overview_selected(self):
    selection = self.architecture_section_tree.selection()
    return bool(
        selection and selection[0] == self._architecture_overview_item
    )


def delete_selected_architecture_section(self):
    filepath = self.filepath_var.get().strip()
    if self.is_architecture_overview_selected():
        messagebox.showinfo("无法删除", "总览是分区树的根节点，不能删除。")
        return
    section = self.get_selected_architecture_section()
    if not filepath:
        messagebox.showwarning("警告", "请先设置保存文件路径。")
        return
    if section is None:
        messagebox.showwarning("未选择分区", "请先从左侧选择要删除的分区。")
        return

    document = _architecture_text(self)
    sections = parse_architecture_sections(document)
    descendants = [
        item
        for item in sections
        if section.start < item.start < section.end
    ]
    parent_heading = (
        sections[section.parent_index].heading
        if section.parent_index is not None
        and section.parent_index < len(sections)
        else None
    )
    descendant_note = (
        f"\n同时会删除其下 {len(descendants)} 个子分区。"
        if descendants
        else ""
    )
    if not messagebox.askyesno(
        "确认删除分区",
        f"确定删除“{section.title}”吗？{descendant_note}\n\n"
        f"将删除 {section.end - section.start} 个字符，并立即写入架构文件。",
    ):
        return

    try:
        merged = delete_architecture_section(document, section)
        NovelProjectRepository(filepath).write(
            NovelProjectRepository.ARCHITECTURE, merged
        )
    except (OSError, ValueError) as exc:
        messagebox.showerror("删除失败", str(exc))
        return

    _show_complete_architecture(self, merged)
    self.architecture_section_guide_text.delete("0.0", "end")
    self.refresh_architecture_sections(select_heading=parent_heading)
    self.log(
        f"已删除小说架构分区“{section.title}”"
        f"及其 {len(descendants)} 个子分区，并保存架构文件。"
    )


def apply_extracted_architecture_content(
    self,
    document,
    parent_section,
    extracted_body,
    target_title,
):
    if parent_section is None:
        return upsert_architecture_overview_section_body(
            document, target_title, extracted_body
        )
    return upsert_architecture_subsection_body(
        document, parent_section, target_title, extracted_body
    )


def sync_architecture_section(self):
    discard_snapshot = self._architecture_active_document_snapshot
    active_title = self._architecture_active_title()
    if self.is_architecture_overview_selected():
        content = self.architecture_section_text.get("0.0", "end-1c")
        _show_complete_architecture(self, content)
        self.refresh_architecture_sections()
        self.architecture_section_tree.selection_set(
            self._architecture_overview_item
        )
        self.on_architecture_section_selected()
        self._architecture_active_document_snapshot = discard_snapshot
        self._architecture_pending_save = True
        self._architecture_pending_reason = (
            "总览中的完整架构修改已同步到总架构编辑区，但尚未写入 "
            "Novel_architecture.txt"
        )
        self.log("已将总览内容同步到完整架构编辑区，尚未写入文件。")
        return
    section = self.get_selected_architecture_section()
    if section is None:
        messagebox.showwarning("未选择分区", "请先从左侧选择要同步的分区。")
        return
    replacement = self.architecture_section_text.get("0.0", "end-1c")
    try:
        merged = replace_architecture_section(
            _architecture_text(self), section, replacement
        )
    except ValueError as exc:
        messagebox.showerror("同步失败", str(exc))
        return
    _show_complete_architecture(self, merged)
    self.refresh_architecture_sections(select_heading=replacement.splitlines()[0])
    self._architecture_active_document_snapshot = discard_snapshot
    self._architecture_pending_save = True
    self._architecture_pending_reason = (
        f"分区“{active_title}”的修改已同步到总架构编辑区，但尚未写入 "
        "Novel_architecture.txt"
    )
    self.log(f"已将分区“{section.title}”同步到总架构编辑区，尚未写入文件。")


def save_architecture_section(self):
    filepath = self.filepath_var.get().strip()
    if self.is_architecture_overview_selected():
        if not filepath:
            messagebox.showwarning("警告", "请先设置保存文件路径。")
            return
        content = self.architecture_section_text.get("0.0", "end-1c")
        try:
            NovelProjectRepository(filepath).write(
                NovelProjectRepository.ARCHITECTURE, content
            )
        except OSError as exc:
            messagebox.showerror("保存失败", str(exc))
            return
        _show_complete_architecture(self, content)
        self.refresh_architecture_sections()
        self.log("已保存总览中的完整小说架构。")
        return
    section = self.get_selected_architecture_section()
    if not filepath:
        messagebox.showwarning("警告", "请先设置保存文件路径。")
        return
    if section is None:
        messagebox.showwarning("未选择分区", "请先从左侧选择要保存的分区。")
        return
    replacement = self.architecture_section_text.get("0.0", "end-1c")
    try:
        merged = replace_architecture_section(
            _architecture_text(self), section, replacement
        )
        NovelProjectRepository(filepath).write(
            NovelProjectRepository.ARCHITECTURE, merged
        )
    except (OSError, ValueError) as exc:
        messagebox.showerror("保存失败", str(exc))
        return
    _show_complete_architecture(self, merged)
    self.refresh_architecture_sections(select_heading=replacement.splitlines()[0])
    self.log(f"已保存小说架构分区：{section.title}。")


def add_architecture_subsection(self):
    filepath = self.filepath_var.get().strip()
    overview_selected = self.is_architecture_overview_selected()
    parent = self.get_selected_architecture_section()
    if not filepath:
        messagebox.showwarning("警告", "请先设置保存文件路径。")
        return
    if parent is None and not overview_selected:
        messagebox.showwarning("未选择分区", "请先选择新分区所属的上级分区。")
        return
    title = simpledialog.askstring(
        "新增子分区",
        (
            "在“总览”下新增顶层分区："
            if overview_selected
            else f"在“{parent.title}”下新增分区："
        ),
        parent=self.master,
    )
    if title is None:
        return
    try:
        if overview_selected:
            merged, heading = append_architecture_overview_section(
                _architecture_text(self), title
            )
        else:
            merged, heading = append_architecture_subsection(
                _architecture_text(self), parent, title
            )
        NovelProjectRepository(filepath).write(
            NovelProjectRepository.ARCHITECTURE, merged
        )
    except (OSError, ValueError) as exc:
        messagebox.showerror("新增失败", str(exc))
        return
    _show_complete_architecture(self, merged)
    self.refresh_architecture_sections(select_heading=heading)
    self.log(
        f"已在{'总览' if overview_selected else parent.title}下新增小说架构分区："
        f"{title.strip()}。"
    )


def load_novel_architecture(self):
    filepath = self.filepath_var.get().strip()
    if not filepath:
        messagebox.showwarning("警告", "请先设置保存文件路径")
        return
    filename = os.path.join(filepath, "Novel_architecture.txt")
    content = read_file(filename)
    _show_complete_architecture(self, content)
    self.refresh_architecture_sections()
    self.update_architecture_workflow_state()
    self.log("已加载 Novel_architecture.txt 内容到编辑区。")


def save_novel_architecture(self):
    filepath = self.filepath_var.get().strip()
    if not filepath:
        messagebox.showwarning("警告", "请先设置保存文件路径。")
        return
    content = _architecture_text(self).strip()
    filename = os.path.join(filepath, "Novel_architecture.txt")
    if save_string_to_txt(content, filename):
        self.refresh_architecture_sections()
        self.update_architecture_workflow_state()
        self.log("已保存对 Novel_architecture.txt 的修改。")
    else:
        messagebox.showerror("保存失败", "无法保存小说架构，请检查目录权限或 app.log。")


def clear_novel_architecture(self):
    if not _architecture_text(self).strip():
        return
    if not messagebox.askyesno(
        "清空小说架构",
        "确定清空当前编辑区吗？\n磁盘文件不会改变，除非随后点击“保存修改”。",
    ):
        return
    self.setting_text.delete("0.0", "end")
    self.setting_word_count_label.configure(text="字数：0")
    self.update_architecture_workflow_state()
    self.refresh_architecture_sections()
    self.log("已清空小说架构编辑区，尚未写入文件。")
