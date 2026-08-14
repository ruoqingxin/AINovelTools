# ui/directory_tab.py
# -*- coding: utf-8 -*-
import os
import customtkinter as ctk
from tkinter import messagebox
from utils import read_file, save_string_to_txt, get_word_count
from ui.context_menu import TextWidgetContextMenu
from ui.novel_params_tab import build_blueprint_generation_area

def build_directory_tab(self):
    self.directory_tab = self.tabview.add("蓝图工作台")
    self.directory_tab.rowconfigure(0, weight=0)
    self.directory_tab.rowconfigure(1, weight=0)
    self.directory_tab.rowconfigure(2, weight=3)
    self.directory_tab.rowconfigure(4, weight=1)
    self.directory_tab.columnconfigure(0, weight=1)

    build_blueprint_generation_area(self, self.directory_tab)

    toolbar = ctk.CTkFrame(self.directory_tab, fg_color="transparent")
    toolbar.grid(row=1, column=0, sticky="ew", padx=5, pady=5)
    toolbar.columnconfigure(1, weight=1)

    load_btn = ctk.CTkButton(toolbar, text="重新加载蓝图", command=self.load_chapter_blueprint, font=("Microsoft YaHei", 12))
    load_btn.grid(row=0, column=0, padx=(0, 8), sticky="w")

    self.directory_word_count_label = ctk.CTkLabel(toolbar, text="字数：0", font=("Microsoft YaHei", 12))
    self.directory_word_count_label.grid(row=0, column=1, sticky="w")

    clear_btn = ctk.CTkButton(toolbar, text="清空内容", command=self.clear_chapter_blueprint, width=90, fg_color="#c0392b", hover_color="#a93226", font=("Microsoft YaHei", 12))
    clear_btn.grid(row=0, column=2, padx=8, sticky="e")

    save_btn = ctk.CTkButton(toolbar, text="保存修改", command=self.save_chapter_blueprint, width=90, font=("Microsoft YaHei", 12))
    save_btn.grid(row=0, column=3, sticky="e")

    self.directory_text = ctk.CTkTextbox(self.directory_tab, wrap="word", font=("Microsoft YaHei", 12))
    
    def update_word_count(event=None):
        text = self.directory_text.get("0.0", "end-1c")
        count = get_word_count(text)
        self.directory_word_count_label.configure(text=f"字数：{count}")
    
    self.directory_text.bind("<KeyRelease>", update_word_count)
    self.directory_text.bind("<ButtonRelease>", update_word_count)
    TextWidgetContextMenu(self.directory_text)
    self.directory_text.grid(row=2, column=0, sticky="nsew", padx=5, pady=(0, 5))

    ctk.CTkLabel(self.directory_tab, text="告诉 AI 你想怎样调整蓝图（可选范围、节奏、冲突或阶段目标）", anchor="w", font=("Microsoft YaHei", 12, "bold")).grid(row=3, column=0, sticky="ew", padx=5, pady=(4, 2))
    self.blueprint_revision_guide_text = ctk.CTkTextbox(self.directory_tab, wrap="word", height=100, font=("Microsoft YaHei", 12))
    TextWidgetContextMenu(self.blueprint_revision_guide_text)
    self.blueprint_revision_guide_text.grid(row=4, column=0, sticky="nsew", padx=5, pady=(0, 5))

    self.btn_revise_blueprint = ctk.CTkButton(self.directory_tab, text="按意见重写蓝图", command=self.revise_chapter_blueprint_ui, height=34, font=("Microsoft YaHei", 12))
    self.btn_revise_blueprint.grid(row=5, column=0, sticky="ew", padx=5, pady=(0, 5))

def load_chapter_blueprint(self):
    filepath = self.filepath_var.get().strip()
    if not filepath:
        messagebox.showwarning("警告", "请先设置保存文件路径")
        return
    filename = os.path.join(filepath, "Novel_directory.txt")
    content = read_file(filename)
    self.directory_text.delete("0.0", "end")
    self.directory_text.insert("0.0", content)
    self.directory_word_count_label.configure(text=f"字数：{get_word_count(content)}")
    self.log("已加载 Novel_directory.txt 内容到编辑区。")

def save_chapter_blueprint(self):
    filepath = self.filepath_var.get().strip()
    if not filepath:
        messagebox.showwarning("警告", "请先设置保存文件路径")
        return
    content = self.directory_text.get("0.0", "end").strip()
    filename = os.path.join(filepath, "Novel_directory.txt")
    if save_string_to_txt(content, filename):
        self.log("已保存对 Novel_directory.txt 的修改。")
    else:
        messagebox.showerror("保存失败", "无法保存章节蓝图，请检查目录权限或 app.log。")

def clear_chapter_blueprint(self):
    if not self.directory_text.get("0.0", "end").strip():
        return
    if not messagebox.askyesno("清空章节蓝图", "确定清空当前编辑区吗？\n磁盘文件不会改变，除非随后点击“保存修改”。"):
        return
    self.directory_text.delete("0.0", "end")
    self.directory_word_count_label.configure(text="字数：0")
    self.log("已清空章节蓝图编辑区，尚未写入文件。")


def _set_volume_plan_text(self, content):
    self.blueprint_volume_plan_text.delete("0.0", "end")
    self.blueprint_volume_plan_text.insert("0.0", content)
    self.persist_project_settings()
