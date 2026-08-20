# ui/setting_tab.py
# -*- coding: utf-8 -*-
import customtkinter as ctk
from tkinter import messagebox

from utils import get_word_count
from ui.context_menu import TextWidgetContextMenu


def build_setting_tab(self):
    self.setting_tab = self.tabview.add("Novel Architecture")
    self.setting_tab.rowconfigure(0, weight=0)
    self.setting_tab.rowconfigure(1, weight=1)
    self.setting_tab.columnconfigure(0, weight=1)

    ctk.CTkButton(self.setting_tab, text="加载工作流", command=self.load_novel_architecture, font=("Microsoft YaHei", 12)).grid(row=0, column=0, padx=5, pady=5, sticky="w")
    self.setting_word_count_label = ctk.CTkLabel(self.setting_tab, text="字数：0", font=("Microsoft YaHei", 12))
    self.setting_word_count_label.grid(row=0, column=1, padx=5, pady=5, sticky="w")
    self.outline_step_var = ctk.StringVar(value="")
    self.outline_step_menu = ctk.CTkOptionMenu(self.setting_tab, values=[""], variable=self.outline_step_var, command=lambda _value: self.load_novel_architecture(), font=("Microsoft YaHei", 12))
    self.outline_step_menu.grid(row=0, column=2, padx=5, pady=5, sticky="ew")
    ctk.CTkButton(self.setting_tab, text="保存草稿", command=self.save_novel_architecture, font=("Microsoft YaHei", 12)).grid(row=0, column=3, padx=5, pady=5, sticky="e")
    ctk.CTkButton(self.setting_tab, text="确认并渲染", command=self.confirm_novel_architecture, font=("Microsoft YaHei", 12)).grid(row=0, column=4, padx=5, pady=5, sticky="e")

    self.setting_text = ctk.CTkTextbox(self.setting_tab, wrap="word", font=("Microsoft YaHei", 12))
    TextWidgetContextMenu(self.setting_text)
    self.setting_text.grid(row=1, column=0, sticky="nsew", padx=5, pady=5, columnspan=5)

    def update_word_count(event=None):
        self.setting_word_count_label.configure(text=f"字数：{get_word_count(self.setting_text.get('0.0', 'end-1c'))}")

    self.setting_text.bind("<KeyRelease>", update_word_count)
    self.setting_text.bind("<ButtonRelease>", update_word_count)


def load_novel_architecture(self):
    if not self.filepath_var.get().strip():
        messagebox.showwarning("警告", "请先设置保存文件路径")
        return
    if not hasattr(self, "outline_service"):
        messagebox.showwarning("警告", "请先打开小说工程")
        return
    workflow = self.outline_service.load_workflow()
    labels = [f"{step['index']:02d}. {step['title']} [{step['status']}]" for step in workflow["steps"]]
    self._outline_step_labels = dict(zip(labels, [step["id"] for step in workflow["steps"]]))
    self.outline_step_menu.configure(values=labels or [""])
    selected = self.outline_step_var.get()
    if selected not in self._outline_step_labels:
        selected = labels[0] if labels else ""
        self.outline_step_var.set(selected)
    step = self.outline_service.get_step(self._outline_step_labels[selected]) if selected else None
    self.setting_text.delete("0.0", "end")
    self.setting_text.insert("0.0", step["content"] if step else "")
    self.log("已加载大纲工作流步骤到编辑区。")


def save_novel_architecture(self):
    if not hasattr(self, "outline_service") or not getattr(self, "_outline_step_labels", None):
        messagebox.showwarning("警告", "请先加载大纲工作流。")
        return False
    step_id = self._outline_step_labels.get(self.outline_step_var.get())
    if not step_id:
        return False
    self.outline_service.save_step_draft(step_id, self.setting_text.get("0.0", "end-1c"))
    self.load_novel_architecture()
    self.log("已保存大纲步骤草稿。")
    return True


def confirm_novel_architecture(self):
    step_id = getattr(self, "_outline_step_labels", {}).get(self.outline_step_var.get())
    if not self.save_novel_architecture():
        return
    if not step_id:
        return
    try:
        self.outline_service.confirm_step(step_id)
        self.outline_service.render_architecture()
    except ValueError as exc:
        messagebox.showwarning("无法确认", str(exc))
        return
    self.load_novel_architecture()
    self.log("已确认大纲步骤，并重新渲染 Novel_architecture.txt。")
