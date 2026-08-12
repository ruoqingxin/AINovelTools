# ui/setting_tab.py
# -*- coding: utf-8 -*-
import os
import customtkinter as ctk
from tkinter import messagebox
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
    editor_frame.rowconfigure(1, weight=3)
    editor_frame.rowconfigure(3, weight=1)
    editor_frame.columnconfigure(0, weight=1)

    params_frame = ctk.CTkFrame(self.setting_tab)
    params_frame.grid(row=0, column=1, sticky="nsew", padx=(2, 5), pady=5)
    params_frame.rowconfigure(0, weight=1)
    params_frame.columnconfigure(0, weight=1)
    build_architecture_params_area(self, params_frame)

    toolbar = ctk.CTkFrame(editor_frame, fg_color="transparent")
    toolbar.grid(row=0, column=0, sticky="ew", padx=5, pady=5)
    toolbar.columnconfigure(1, weight=1)

    load_btn = ctk.CTkButton(toolbar, text="加载架构", command=self.load_novel_architecture, font=("Microsoft YaHei", 12))
    load_btn.grid(row=0, column=0, padx=(0, 8), sticky="w")

    self.setting_word_count_label = ctk.CTkLabel(toolbar, text="字数：0", font=("Microsoft YaHei", 12))
    self.setting_word_count_label.grid(row=0, column=1, sticky="w")

    clear_btn = ctk.CTkButton(toolbar, text="清空内容", command=self.clear_novel_architecture, width=90, fg_color="#c0392b", hover_color="#a93226", font=("Microsoft YaHei", 12))
    clear_btn.grid(row=0, column=2, padx=8, sticky="e")

    save_btn = ctk.CTkButton(toolbar, text="保存修改", command=self.save_novel_architecture, width=90, font=("Microsoft YaHei", 12))
    save_btn.grid(row=0, column=3, sticky="e")

    self.setting_text = ctk.CTkTextbox(editor_frame, wrap="word", font=("Microsoft YaHei", 12))
    TextWidgetContextMenu(self.setting_text)
    self.setting_text.grid(row=1, column=0, sticky="nsew", padx=5, pady=(0, 5))

    ctk.CTkLabel(editor_frame, text="个人修改意见", anchor="w", font=("Microsoft YaHei", 12, "bold")).grid(row=2, column=0, sticky="ew", padx=5, pady=(4, 2))
    self.architecture_revision_guide_text = ctk.CTkTextbox(editor_frame, wrap="word", height=100, font=("Microsoft YaHei", 12))
    TextWidgetContextMenu(self.architecture_revision_guide_text)
    self.architecture_revision_guide_text.grid(row=3, column=0, sticky="nsew", padx=5, pady=(0, 5))

    self.btn_revise_architecture = ctk.CTkButton(editor_frame, text="AI 重新写小说架构", command=self.revise_novel_architecture_ui, height=34, font=("Microsoft YaHei", 12))
    self.btn_revise_architecture.grid(row=4, column=0, sticky="ew", padx=5, pady=(0, 5))

    def update_word_count(event=None):
        text = self.setting_text.get("0.0", "end-1c")
        count = get_word_count(text)
        self.setting_word_count_label.configure(text=f"字数：{count}")

    self.setting_text.bind("<KeyRelease>", update_word_count)
    self.setting_text.bind("<ButtonRelease>", update_word_count)

def load_novel_architecture(self):
    filepath = self.filepath_var.get().strip()
    if not filepath:
        messagebox.showwarning("警告", "请先设置保存文件路径")
        return
    filename = os.path.join(filepath, "Novel_architecture.txt")
    content = read_file(filename)
    self.setting_text.delete("0.0", "end")
    self.setting_text.insert("0.0", content)
    self.log("已加载 Novel_architecture.txt 内容到编辑区。")

def save_novel_architecture(self):
    filepath = self.filepath_var.get().strip()
    if not filepath:
        messagebox.showwarning("警告", "请先设置保存文件路径。")
        return
    content = self.setting_text.get("0.0", "end").strip()
    filename = os.path.join(filepath, "Novel_architecture.txt")
    if save_string_to_txt(content, filename):
        self.log("已保存对 Novel_architecture.txt 的修改。")
    else:
        messagebox.showerror("保存失败", "无法保存小说架构，请检查目录权限或 app.log。")

def clear_novel_architecture(self):
    if not self.setting_text.get("0.0", "end").strip():
        return
    if not messagebox.askyesno("清空小说架构", "确定清空当前编辑区吗？\n磁盘文件不会改变，除非随后点击“保存修改”。"):
        return
    self.setting_text.delete("0.0", "end")
    self.setting_word_count_label.configure(text="字数：0")
    self.log("已清空小说架构编辑区，尚未写入文件。")
