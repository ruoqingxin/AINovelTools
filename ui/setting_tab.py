# ui/setting_tab.py
# -*- coding: utf-8 -*-
import os
import customtkinter as ctk
from tkinter import messagebox, simpledialog, ttk

from novel_generator.architecture_sections import (
    append_architecture_subsection,
    parse_architecture_sections,
    replace_architecture_section,
    replace_architecture_section_body,
    upsert_architecture_subsection_body,
)
from novel_generator.storage import NovelProjectRepository
from utils import read_file, save_string_to_txt, get_word_count
from ui.context_menu import TextWidgetContextMenu
from ui.novel_params_tab import build_architecture_params_area


def build_setting_tab(self):
    self.setting_tab = self.tabview.add("小说架构")
    self.setting_tab.rowconfigure(0, weight=1)
    self.setting_tab.columnconfigure(0, weight=3, uniform="architecture_columns")
    self.setting_tab.columnconfigure(1, weight=2, uniform="architecture_columns")

    editor_frame = ctk.CTkFrame(self.setting_tab)
    editor_frame.grid(row=0, column=0, sticky="nsew", padx=(5, 2), pady=5)
    editor_frame.rowconfigure(1, weight=1)
    editor_frame.columnconfigure(0, weight=1)

    params_frame = ctk.CTkFrame(self.setting_tab)
    params_frame.grid(row=0, column=1, sticky="nsew", padx=(2, 5), pady=5)
    params_frame.rowconfigure(0, weight=1)
    params_frame.columnconfigure(0, weight=1)
    build_architecture_params_area(self, params_frame)

    toolbar = ctk.CTkFrame(editor_frame, fg_color="transparent")
    toolbar.grid(row=0, column=0, sticky="ew", padx=5, pady=5)
    toolbar.columnconfigure(1, weight=1)

    load_btn = ctk.CTkButton(
        toolbar,
        text="加载架构",
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
    section_tab = self.architecture_editor_tabview.add("分区编辑")
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


def _build_section_editor(self, parent):
    parent.rowconfigure(2, weight=1)
    parent.columnconfigure(0, weight=1)
    parent.columnconfigure(1, weight=3)

    section_toolbar = ctk.CTkFrame(parent, fg_color="transparent")
    section_toolbar.grid(row=0, column=0, columnspan=2, sticky="ew", padx=3, pady=3)
    section_toolbar.columnconfigure(3, weight=1)
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
    self.architecture_section_status_label = ctk.CTkLabel(
        section_toolbar,
        text="从左侧选择要单独修改的内容",
        anchor="w",
    )
    self.architecture_section_status_label.grid(row=0, column=3, sticky="ew")

    extraction_options = ctk.CTkFrame(parent, fg_color="transparent")
    extraction_options.grid(
        row=1, column=0, columnspan=2, sticky="ew", padx=3, pady=(0, 4)
    )
    extraction_options.columnconfigure(3, weight=1)
    ctk.CTkLabel(extraction_options, text="提炼位置").grid(
        row=0, column=0, padx=(0, 6), sticky="w"
    )
    self.architecture_extraction_mode_var = ctk.StringVar(
        value="新建/更新子分区"
    )
    self.architecture_extraction_mode_menu = ctk.CTkOptionMenu(
        extraction_options,
        variable=self.architecture_extraction_mode_var,
        values=["新建/更新子分区", "合并当前分区正文"],
        width=155,
        command=lambda _value: self.update_architecture_extraction_controls(),
    )
    self.architecture_extraction_mode_menu.grid(row=0, column=1, padx=(0, 6))
    self.architecture_extraction_title_entry = ctk.CTkEntry(
        extraction_options,
        placeholder_text="固定子分区名称，例如：境界体系",
        width=220,
    )
    self.architecture_extraction_title_entry.grid(
        row=0, column=2, padx=(0, 6), sticky="ew"
    )
    self.architecture_extraction_location_label = ctk.CTkLabel(
        extraction_options,
        text="将固定追加到当前分区末尾；同名时原位更新",
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
    if self.architecture_editor_tabview.get() == "分区编辑":
        self.refresh_architecture_sections()


def refresh_architecture_sections(self, select_heading=None):
    current_selection = self.architecture_section_tree.selection()
    if select_heading is None and current_selection:
        selected = self._architecture_sections_by_id.get(current_selection[0])
        select_heading = selected.heading if selected else None

    self.architecture_section_tree.delete(
        *self.architecture_section_tree.get_children()
    )
    self._architecture_sections_by_id = {}
    sections = parse_architecture_sections(_architecture_text(self))
    item_by_index = {}
    selected_item = None
    for section in sections:
        item_id = f"section-{section.index}"
        parent_id = item_by_index.get(section.parent_index, "")
        self.architecture_section_tree.insert(
            parent_id,
            "end",
            iid=item_id,
            text=section.title,
            open=section.level <= 2,
        )
        item_by_index[section.index] = item_id
        self._architecture_sections_by_id[item_id] = section
        if select_heading == section.heading:
            selected_item = item_id

    if not sections:
        self.architecture_section_text.delete("0.0", "end")
        self.architecture_section_status_label.configure(
            text="未识别到标题，请先在完整架构中添加 # 标题"
        )
        return

    selected_item = selected_item or item_by_index[sections[0].index]
    self.architecture_section_tree.selection_set(selected_item)
    self.architecture_section_tree.focus(selected_item)
    self.architecture_section_tree.see(selected_item)
    self.on_architecture_section_selected()


def on_architecture_section_selected(self, event=None):
    selection = self.architecture_section_tree.selection()
    if not selection:
        return
    section = self._architecture_sections_by_id.get(selection[0])
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


def get_selected_architecture_section(self):
    selection = self.architecture_section_tree.selection()
    if not selection:
        return None
    return self._architecture_sections_by_id.get(selection[0])


def update_architecture_extraction_controls(self):
    merge_current = (
        self.architecture_extraction_mode_var.get() == "合并当前分区正文"
    )
    self.architecture_extraction_title_entry.configure(
        state="disabled" if merge_current else "normal"
    )
    self.architecture_extraction_location_label.configure(
        text=(
            "只更新当前节点正文，保留全部下级分区及顺序"
            if merge_current
            else "将固定追加到当前分区末尾；同名时原位更新"
        )
    )


def apply_extracted_architecture_content(
    self,
    document,
    parent_section,
    extracted_body,
    mode,
    target_title,
):
    if mode == "合并当前分区正文":
        merged = replace_architecture_section_body(
            document, parent_section, extracted_body
        )
        return merged, parent_section.heading, False
    return upsert_architecture_subsection_body(
        document, parent_section, target_title, extracted_body
    )


def sync_architecture_section(self):
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
    self.log(f"已将分区“{section.title}”同步到总架构编辑区，尚未写入文件。")


def save_architecture_section(self):
    filepath = self.filepath_var.get().strip()
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
    parent = self.get_selected_architecture_section()
    if not filepath:
        messagebox.showwarning("警告", "请先设置保存文件路径。")
        return
    if parent is None:
        messagebox.showwarning("未选择分区", "请先选择新分区所属的上级分区。")
        return
    title = simpledialog.askstring(
        "新增子分区",
        f"在“{parent.title}”下新增分区：",
        parent=self.master,
    )
    if title is None:
        return
    try:
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
    self.log(f"已新增小说架构分区：{title.strip()}。")


def load_novel_architecture(self):
    filepath = self.filepath_var.get().strip()
    if not filepath:
        messagebox.showwarning("警告", "请先设置保存文件路径")
        return
    filename = os.path.join(filepath, "Novel_architecture.txt")
    content = read_file(filename)
    _show_complete_architecture(self, content)
    self.refresh_architecture_sections()
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
    self.refresh_architecture_sections()
    self.log("已清空小说架构编辑区，尚未写入文件。")
