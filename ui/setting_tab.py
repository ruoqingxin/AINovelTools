# ui/setting_tab.py
# -*- coding: utf-8 -*-
import os
import customtkinter as ctk
from tkinter import messagebox, simpledialog, ttk, filedialog

from novel_generator.architecture_sections import (
    append_architecture_overview_section,
    append_architecture_subsection,
    delete_architecture_section,
    parse_architecture_sections,
    replace_architecture_section,
    replace_architecture_section_body,
    upsert_architecture_overview_section_body,
    upsert_architecture_subsection_body,
)
from novel_generator.storage import NovelProjectRepository
from utils import read_file, save_string_to_txt, get_word_count
from ui.context_menu import TextWidgetContextMenu
from novel_generator.outline_workflow import OutlineWorkflow, OUTLINE_STEPS, outline_adapter_kwargs
from llm_adapters import create_llm_adapter
from config_manager import get_llm_config
from novel_generator.knowledge import read_knowledge_file


def _add_action_with_help(parent, text, command, help_text, width=88, height=28):
    """Create an action button with an adjacent, compact help button."""
    group = ctk.CTkFrame(parent, fg_color="transparent")
    action = ctk.CTkButton(group, text=text, command=command, width=width, height=height)
    action.pack(side="left")
    ctk.CTkButton(
        group,
        text="?",
        width=24,
        height=height,
        command=lambda: messagebox.showinfo(f"{text}：功能说明", help_text),
    ).pack(side="left", padx=(3, 0))
    return group, action


def build_setting_tab(self):
    self.setting_tab = self.tabview.add("大纲工作台")
    self.setting_tab.rowconfigure(0, weight=1)
    self.setting_tab.columnconfigure(0, weight=1)

    editor_frame = ctk.CTkFrame(self.setting_tab)
    editor_frame.grid(row=0, column=0, sticky="nsew", padx=5, pady=5)
    editor_frame.rowconfigure(0, weight=1)
    editor_frame.columnconfigure(0, weight=1)

    toolbar = ctk.CTkFrame(editor_frame, fg_color="transparent")
    toolbar.grid(row=0, column=0, sticky="ew", padx=5, pady=(2, 3))
    toolbar.columnconfigure(1, weight=1)
    load_group, self.btn_load_outline_workflow = _add_action_with_help(
        toolbar,
        "加载已确认分区",
        self.load_outline_workflow_project,
        "读取工程目录中的 Novel_architecture.txt，恢复已经写入的大纲分区和当前编辑内容。",
        width=120,
    )
    load_group.grid(row=0, column=0, sticky="w")
    self.setting_word_count_label = ctk.CTkLabel(toolbar, text="34 个分区逐个确认", font=("Microsoft YaHei", 12))
    self.setting_word_count_label.grid(row=0, column=1, sticky="w", padx=10)

    # This hidden document buffer is the canonical aggregate used by the
    # existing section-tree helpers and project restore code.
    self.setting_text = ctk.CTkTextbox(self.setting_tab, width=1, height=1)

    _build_section_editor(self, editor_frame)
    self.refresh_architecture_sections()

    def update_word_count(event=None):
        text = self.setting_text.get("0.0", "end-1c")
        self.setting_word_count_label.configure(text=f"字数：{get_word_count(text)}")

    self.setting_text.bind("<KeyRelease>", update_word_count)
    self.setting_text.bind("<ButtonRelease>", update_word_count)
    self.update_architecture_workflow_state()


def update_architecture_workflow_state(self):
    """Refresh the current workflow section after project restore."""
    if getattr(self, "architecture_section_tree", None) is not None:
        self.refresh_architecture_sections()
    selection = self.architecture_section_tree.selection() if getattr(self, "architecture_section_tree", None) is not None else ()
    if getattr(self, "outline_step_var", None) is not None and (not selection or _outline_tree_step_index(selection[0])):
        self.load_outline_workflow_step()


def _outline_workflow(self):
    filepath = self.filepath_var.get().strip()
    if not filepath:
        raise ValueError("请先设置保存文件路径")
    workflow = getattr(self, "_outline_workflow_state", None)
    if workflow is None or str(workflow.repository.root) != str(NovelProjectRepository(filepath).root):
        workflow = OutlineWorkflow(filepath)
        self._outline_workflow_state = workflow
    return workflow


def _outline_step_index(self):
    return int(str(self.outline_step_var.get()).split(".", 1)[0])


def load_outline_workflow_project(self):
    """Load the persisted confirmed outline into the section editor."""
    filepath = self.filepath_var.get().strip()
    if not filepath:
        messagebox.showwarning("缺少工程目录", "请先设置工程目录")
        return
    content = read_file(os.path.join(filepath, NovelProjectRepository.ARCHITECTURE))
    self.setting_text.delete("0.0", "end")
    self.setting_text.insert("0.0", content)
    self.refresh_architecture_sections()
    self.load_outline_workflow_step()
    self.log("已加载已确认的大纲分区。")


def load_outline_workflow_step(self):
    try:
        item = _outline_workflow(self).step(_outline_step_index(self))
    except (ValueError, IndexError) as exc:
        self.outline_step_status.configure(text=str(exc)); return
    editor = getattr(self, "architecture_section_text", self.setting_text)
    editor.delete("0.0", "end")
    editor.insert("0.0", item.get("content", ""))
    self.outline_step_status.configure(text={"confirmed": "已确认", "draft": "草稿"}.get(item.get("status"), "未开始"))


def _outline_tree_step_index(item_id):
    if not str(item_id).startswith("outline-step-"):
        return None
    try:
        return int(str(item_id).split("-", 2)[2])
    except (TypeError, ValueError):
        return None


def _save_outline_editor(self, source="manual"):
    workflow = _outline_workflow(self)
    editor = getattr(self, "architecture_section_text", self.setting_text)
    return workflow.update(_outline_step_index(self), editor.get("0.0", "end-1c"), source)


def confirm_outline_step(self):
    try:
        workflow = _outline_workflow(self)
        editor = getattr(self, "architecture_section_text", self.setting_text)
        item = workflow.confirm(_outline_step_index(self), editor.get("0.0", "end-1c"))
        self.outline_step_status.configure(text="分区已确认并保存")
        next_index = min(item["index"] + 1, len(OUTLINE_STEPS))
        self.outline_step_var.set(f"{next_index}. {OUTLINE_STEPS[next_index - 1]}")
        self.load_outline_workflow_step()
    except (ValueError, IndexError, OSError) as exc:
        messagebox.showwarning("无法确认", str(exc))


def extract_outline_step_from_file(self):
    path = filedialog.askopenfilename(title="选择用于提炼的资料", filetypes=[("文本文件", "*.txt *.md"), ("所有文件", "*.*")])
    if not path: return
    try:
        workflow = _outline_workflow(self)
        index = _outline_step_index(self)
        source = read_knowledge_file(path).strip()
        if not source:
            raise ValueError("所选文件没有可读取的文字内容")
        config = get_llm_config(self.loaded_config, self.architecture_llm_var.get())
        adapter = _create_outline_adapter(config)
        extracted = adapter.invoke(_outline_file_prompt(workflow.step(index)["title"], source))
        item = workflow.update(index, extracted, "file_extract_ai")
        editor = getattr(self, "architecture_section_text", self.setting_text)
        editor.delete("0.0", "end"); editor.insert("0.0", item["content"])
        self.outline_step_status.configure(text="已提炼，待确认")
    except (OSError, ValueError) as exc:
        messagebox.showerror("提炼失败", str(exc))


def derive_outline_step_with_ai(self):
    try:
        workflow = _outline_workflow(self); index = _outline_step_index(self)
        config = get_llm_config(self.loaded_config, self.architecture_llm_var.get())
        adapter = _create_outline_adapter(config)
        item = workflow.set_from_ai(index, lambda title, prior: adapter.invoke(
            _outline_derive_prompt(title, prior)))
        editor = getattr(self, "architecture_section_text", self.setting_text)
        editor.delete("0.0", "end"); editor.insert("0.0", item["content"])
        self.outline_step_status.configure(text="AI 已推导，待确认")
    except Exception as exc:
        messagebox.showerror("AI 推导失败", str(exc))


def _create_outline_adapter(config):
    """Pass only model-constructor fields; config metadata is not API input."""
    return create_llm_adapter(**outline_adapter_kwargs(config))


def _outline_file_prompt(title, source):
    return (
        f"你是小说大纲编辑。请只从下方这一个文件中提炼与“{title}”直接相关的设定，"
        "整理成可直接放入该大纲分区的中文正文。不要使用文件之外的知识，不要输出标题、解释、免责声明或与该分区无关的内容。\n\n"
        f"文件内容：\n{source}"
    )


def _outline_derive_prompt(title, prior):
    context = "\n".join(
        f"{item['index']}. {item['title']}：{item['content']}" for item in prior
    ) or "（暂无已确认设定）"
    return (
        f"你是小说大纲编辑。请根据前面已经确认的分区内容，围绕当前分区标题“{title}”推导具体正文。"
        "只输出当前分区正文，不要输出标题、解释或免责声明。\n\n"
        f"前面已确认的分区：\n{context}"
    )


def finalize_outline_workflow(self):
    try:
        path = _outline_workflow(self).finalize()
        messagebox.showinfo("大纲定稿", f"已完成 34 步确认并写入：\n{path}")
    except (ValueError, OSError) as exc:
        messagebox.showwarning("尚未定稿", str(exc))


def update_architecture_input_visibility(self, has_architecture=None):
    return None


def toggle_architecture_input_panel(self):
    return None


def _build_section_editor(self, parent):
    parent.rowconfigure(0, weight=0)
    parent.rowconfigure(2, weight=0)
    parent.rowconfigure(3, weight=1)
    parent.columnconfigure(0, weight=1)
    parent.columnconfigure(1, weight=3)

    stepbar = ctk.CTkFrame(parent, fg_color="transparent")
    stepbar.grid(row=0, column=0, columnspan=2, sticky="ew", padx=3, pady=(3, 1))
    stepbar.columnconfigure(1, weight=1)
    ctk.CTkLabel(stepbar, text="大纲分区").grid(row=0, column=0, padx=(4, 6))
    self.outline_step_var = ctk.StringVar(value="1. 题材类型")
    self.outline_step_menu = ctk.CTkOptionMenu(stepbar, variable=self.outline_step_var, values=[f"{i}. {title}" for i, title in enumerate(OUTLINE_STEPS, 1)], command=lambda _: self.load_outline_workflow_step(), width=220)
    self.outline_step_menu.grid(row=0, column=1, sticky="w")
    self.outline_step_status = ctk.CTkLabel(stepbar, text="未开始", anchor="w")
    self.outline_step_status.grid(row=0, column=2, padx=8, sticky="w")
    workflow_actions = (
        ("文件提炼", self.extract_outline_step_from_file,
         "选择一份资料文件，调用 AI 只从该文件中提炼当前分区标题对应的正文，不使用前面分区上下文。"),
        ("AI 推导", self.derive_outline_step_with_ai,
         "读取前面已经确认的分区作为上下文，围绕当前分区标题推导正文，不读取文件。"),
        ("确认分区", self.confirm_outline_step,
         "保存当前分区内容并标记为已确认，同时写入工作流状态和 Novel_architecture.txt；必须按顺序确认。"),
        ("定稿", self.finalize_outline_workflow,
         "仅当 34 个分区全部确认后生成最终大纲文件；未完成时不会覆盖定稿。"),
    )
    for col, (label, command, help_text) in enumerate(workflow_actions, 3):
        group, _ = _add_action_with_help(stepbar, label, command, help_text, width=78)
        group.grid(row=0, column=col, padx=2)

    section_toolbar = ctk.CTkFrame(parent, fg_color="transparent")
    section_toolbar.grid(row=1, column=0, columnspan=2, sticky="ew", padx=3, pady=3)
    section_toolbar.columnconfigure(4, weight=1)
    group, _ = _add_action_with_help(
        section_toolbar, "刷新分区", self.refresh_architecture_sections,
        "重新解析 Novel_architecture.txt 并刷新左侧分区树，不调用 AI。", width=88)
    group.grid(row=0, column=0, padx=(0, 6))
    group, _ = _add_action_with_help(
        section_toolbar, "新增自定义分区", self.add_architecture_subsection,
        "新增一个由你主动维护的自定义分区；它不占用 34 个固定确认步骤。", width=112)
    group.grid(row=0, column=1, padx=(0, 6))
    group, self.btn_delete_architecture_section = _add_action_with_help(
        section_toolbar, "删除分区", self.delete_architecture_section,
        "删除当前分区及其子分区，并立即写入大纲文件；总览节点不能删除。", width=88)
    self.btn_delete_architecture_section.configure(fg_color="#c0392b", hover_color="#a93226")
    group.grid(row=0, column=2, padx=(0, 6))
    self.architecture_section_status_label = ctk.CTkLabel(
        section_toolbar,
        text="从左侧选择要单独修改的内容",
        anchor="w",
    )
    self.architecture_section_status_label.grid(row=0, column=3, sticky="ew")

    extraction_options = ctk.CTkFrame(parent, fg_color="transparent")
    extraction_options.grid(
        row=2, column=0, columnspan=2, sticky="ew", padx=3, pady=(0, 4)
    )
    extraction_options.columnconfigure(1, weight=0)
    extraction_options.columnconfigure(2, weight=1)
    extraction_options.columnconfigure(3, weight=1)
    ctk.CTkLabel(extraction_options, text="当前 34 步分区").grid(
        row=0, column=0, padx=(0, 6), sticky="w"
    )
    self.architecture_extraction_parent_label = ctk.CTkLabel(
        extraction_options,
        text="每一步对应一个独立分区",
        width=155,
        anchor="w",
    )
    self.architecture_extraction_parent_label.grid(row=0, column=1, padx=(0, 6))
    self.architecture_extraction_title_entry = ctk.CTkEntry(
        extraction_options,
        placeholder_text="当前流程不新增子分区",
        width=220,
    )
    self.architecture_extraction_title_entry.grid(
        row=0, column=2, padx=(0, 6), sticky="ew"
    )
    self.architecture_extraction_location_label = ctk.CTkLabel(
        extraction_options,
        text="请使用顶部 34 步分区选择器进行提炼和确认",
        anchor="w",
    )
    self.architecture_extraction_location_label.grid(
        row=0, column=3, sticky="ew"
    )

    tree_frame = ctk.CTkFrame(parent)
    tree_frame.grid(row=3, column=0, rowspan=4, sticky="nsew", padx=(3, 4), pady=(0, 3))
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
    self._architecture_overview_item = "outline-overview"
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
        row=3, column=1, sticky="nsew", padx=(4, 3), pady=(0, 4)
    )

    ctk.CTkLabel(
        parent,
        text="本分区 AI 修改要求",
        anchor="w",
        font=("Microsoft YaHei", 12, "bold"),
    ).grid(row=4, column=1, sticky="ew", padx=(4, 3), pady=(2, 2))
    self.architecture_section_guide_text = ctk.CTkTextbox(
        parent, wrap="word", height=80, font=("Microsoft YaHei", 12)
    )
    TextWidgetContextMenu(self.architecture_section_guide_text)
    self.architecture_section_guide_text.grid(
        row=5, column=1, sticky="ew", padx=(4, 3), pady=(0, 4)
    )

    section_actions = ctk.CTkFrame(parent, fg_color="transparent")
    section_actions.grid(row=6, column=1, sticky="ew", padx=(4, 3), pady=(0, 3))
    for column in range(4):
        section_actions.columnconfigure(column, weight=1)
    group, _ = _add_action_with_help(
        section_actions, "同步总架构", self.sync_architecture_section,
        "把当前分区编辑框内容合并到内部总架构文本，供分区树重新解析；不会替代确认分区。", width=112, height=34)
    group.grid(row=0, column=0, sticky="ew", padx=(0, 3))
    group, _ = _add_action_with_help(
        section_actions, "保存本分区", self.save_architecture_section,
        "将当前分区修改写入 Novel_architecture.txt，但不会改变 34 步确认状态。", width=112, height=34)
    group.grid(row=0, column=1, sticky="ew", padx=3)
    group, self.btn_revise_architecture_section = _add_action_with_help(
        section_actions, "AI 重写本分区", self.revise_architecture_section_ui,
        "根据下方的 AI 修改要求重写当前分区；需要选择分区、填写修改要求并配置大纲模型。", width=112, height=34)
    group.grid(row=0, column=2, sticky="ew", padx=(3, 0))
    group, self.btn_clear_architecture_section = _add_action_with_help(
        section_actions, "清空本分区", self.clear_current_architecture_section,
        "清空当前选中分区自己的正文，保留分区标题和子分区；确认后立即写入大纲文件。总览节点不能使用此操作。",
        width=112, height=34)
    self.btn_clear_architecture_section.configure(fg_color="#c0392b", hover_color="#a93226")
    group.grid(row=0, column=3, sticky="ew", padx=(3, 0))


def _architecture_text(self):
    return self.setting_text.get("0.0", "end-1c")


def _show_complete_architecture(self, content):
    self.setting_text.delete("0.0", "end")
    self.setting_text.insert("0.0", content)
    self.setting_word_count_label.configure(text=f"字数：{get_word_count(content)}")


def on_architecture_editor_tab_changed(self):
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
    workflow = _outline_workflow(self)
    current_selection = self.architecture_section_tree.selection()
    requested = current_selection[0] if current_selection else "outline-step-1"
    if select_key and str(select_key).startswith("outline-step-"):
        requested = select_key
    self._architecture_tree_selection_guard = True
    try:
        self.architecture_section_tree.delete(*self.architecture_section_tree.get_children())
        self._architecture_sections_by_id = {}
        self.architecture_section_tree.insert(
            "", "end",
            iid=self._architecture_overview_item,
            text="总览",
            open=True,
        )
        for index, title in enumerate(OUTLINE_STEPS, 1):
            item_id = f"outline-step-{index}"
            self.architecture_section_tree.insert(
                self._architecture_overview_item, "end",
                iid=item_id,
                text=f"{index}. {title}",
                open=False,
            )
        for custom in workflow.data.get("custom_sections", []):
            item_id = str(custom.get("id"))
            self.architecture_section_tree.insert(self._architecture_overview_item, "end", iid=item_id, text=custom.get("title", item_id))
            self._architecture_sections_by_id[item_id] = custom
    finally:
        self._architecture_tree_selection_guard = False
    selected_item = requested if requested == self._architecture_overview_item or self.architecture_section_tree.exists(requested) else "outline-step-1"
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
    if active_item is not None and target_item != active_item and self.architecture_section_has_unsaved_changes():
        if messagebox.askyesno("分区尚未保存", f"“{self._architecture_active_title()}”有未保存内容，是否保存？"):
            self.save_architecture_section()
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
    step_index = _outline_tree_step_index(item_id)
    if step_index:
        item = _outline_workflow(self).step(step_index)
        content, title = item.get("content", ""), item.get("title", "")
        status = {"confirmed": "已确认", "draft": "草稿"}.get(item.get("status"), "未开始")
        self.outline_step_var.set(f"{step_index}. {title}")
    else:
        item = self._architecture_sections_by_id.get(item_id)
        if item is None: return
        content, title, status = item.get("content", ""), item.get("title", ""), "自定义分区"
    self.architecture_section_text.delete("0.0", "end")
    self.architecture_section_text.insert("0.0", content)
    self.architecture_section_status_label.configure(text=f"当前：{title}（{status}）")
    self.architecture_extraction_parent_label.configure(text=title)
    self._set_architecture_active_baseline(item_id, item, content)


def _set_architecture_active_baseline(self, item_id, section, editor_text):
    self._architecture_active_item_id = item_id
    self._architecture_active_section_key = item_id
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
    return item_id


def _architecture_active_title(self):
    if self._architecture_active_item_id == self._architecture_overview_item:
        return "总览"
    item_id = self._architecture_active_item_id
    index = _outline_tree_step_index(item_id)
    if index:
        return OUTLINE_STEPS[index - 1]
    section = self._architecture_sections_by_id.get(item_id)
    return section.get("title", "当前分区") if isinstance(section, dict) else "当前分区"


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
    editor_text = self.architecture_section_text.get("0.0", "end-1c")
    try:
        item_id = self._architecture_active_item_id
        index = _outline_tree_step_index(item_id)
        if index:
            _outline_workflow(self).update(index, editor_text, "manual")
            _outline_workflow(self).write_confirmed_sections()
        elif item_id and item_id.startswith("custom-"):
            _outline_workflow(self).update_custom_section(item_id, editor_text)
        else:
            NovelProjectRepository(filepath).write(NovelProjectRepository.ARCHITECTURE, editor_text)
    except (OSError, ValueError) as exc:
        messagebox.showerror("保存失败", str(exc))
        return False
    if index:
        self.load_outline_workflow_step()
    else:
        self.refresh_architecture_sections(select_key=item_id)
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
    if self.is_architecture_overview_selected():
        messagebox.showinfo("无法删除", "总览是分区树的根节点，不能删除。")
        return
    selection = self.architecture_section_tree.selection()
    item_id = selection[0] if selection else ""
    if _outline_tree_step_index(item_id):
        messagebox.showinfo("无法删除", "34 个固定分区不能删除。")
        return
    section = self.get_selected_architecture_section()
    if not isinstance(section, dict):
        messagebox.showwarning("未选择分区", "请先从左侧选择要删除的分区。")
        return
    if not messagebox.askyesno(
        "确认删除分区",
        f"确定删除自定义分区“{section.get('title', item_id)}”吗？",
    ):
        return
    try:
        _outline_workflow(self).delete_custom_section(item_id)
    except (OSError, ValueError, KeyError) as exc:
        messagebox.showerror("删除失败", str(exc))
        return
    self.architecture_section_guide_text.delete("0.0", "end")
    self.refresh_architecture_sections(select_key="outline-step-1")
    self.log(f"已删除自定义分区“{section.get('title', item_id)}”。")


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
    if self._architecture_active_item_id and self._architecture_active_item_id != self._architecture_overview_item:
        if _outline_tree_step_index(self._architecture_active_item_id) or str(self._architecture_active_item_id).startswith("custom-"):
            self.save_architecture_section()
            return
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


def clear_current_architecture_section(self):
    """Clear only the selected section's own body, preserving its children."""
    if self.is_architecture_overview_selected():
        messagebox.showwarning("无法清空总览", "请先选择一个具体分区；总览节点不能清空。")
        return
    selection = self.architecture_section_tree.selection()
    item_id = selection[0] if selection else ""
    step_index = _outline_tree_step_index(item_id)
    section = self.get_selected_architecture_section()
    if not step_index and not isinstance(section, dict):
        messagebox.showwarning("未选择分区", "请先从左侧选择要清空的分区。")
        return
    if not step_index and not self.filepath_var.get().strip():
        messagebox.showwarning("缺少工程目录", "请先设置工程目录。")
        return
    if not messagebox.askyesno(
        "确认清空分区",
        f"确定清空“{OUTLINE_STEPS[step_index - 1] if step_index else section.get('title', item_id)}”的正文吗？",
    ):
        return
    try:
        workflow = _outline_workflow(self)
        if step_index:
            workflow.update(step_index, "", "manual")
            workflow.write_confirmed_sections()
        else:
            workflow.update_custom_section(item_id, "")
    except (OSError, ValueError, KeyError) as exc:
        messagebox.showerror("清空失败", str(exc))
        return
    self.architecture_section_text.delete("0.0", "end")
    self._architecture_active_original_text = ""
    self._architecture_pending_save = False
    self.refresh_architecture_sections(select_key=item_id)
    self._set_architecture_tree_selection(item_id)
    self._display_architecture_section(item_id)
    self.log("已清空当前分区正文。")


def save_architecture_section(self):
    if self._architecture_active_item_id and self._architecture_active_item_id != self._architecture_overview_item:
        if _outline_tree_step_index(self._architecture_active_item_id) or str(self._architecture_active_item_id).startswith("custom-"):
            if self._save_active_architecture_section():
                self.log(f"已保存小说架构分区：{self._architecture_active_title()}。")
            return
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
    overview_selected = self.is_architecture_overview_selected()
    title = simpledialog.askstring(
        "新增子分区",
        "新增用户自定义分区名称：",
        parent=self.master,
    )
    if title is None:
        return
    try:
        item = _outline_workflow(self).add_custom_section(title)
    except (OSError, ValueError) as exc:
        messagebox.showerror("新增失败", str(exc))
        return
    self.refresh_architecture_sections(select_key=item["id"])
    self.log(f"已新增自定义分区：{title.strip()}。")


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
    # Resolve edits made in the advanced section editor before clearing the
    # complete document.  Clearing first would remove the section that the
    # save action needs to locate, causing a misleading "保存失败" dialog.
    if self.architecture_section_has_unsaved_changes():
        current_name = self._architecture_active_title()
        reasons = self.architecture_section_unsaved_reasons()
        reason_text = "\n".join(f"- {reason}" for reason in reasons)
        choice = messagebox.askyesnocancel(
            "分区尚未保存",
            f"“{current_name}”存在以下未保存内容：\n\n"
            f"{reason_text}\n\n"
            "选择“是”保存后清空，选择“否”放弃修改，选择“取消”继续编辑。",
        )
        if choice is None:
            return
        if choice:
            if not self._save_active_architecture_section():
                return
        else:
            _show_complete_architecture(
                self, self._architecture_active_document_snapshot
            )
        self._architecture_pending_save = False
        self._architecture_pending_reason = ""

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
