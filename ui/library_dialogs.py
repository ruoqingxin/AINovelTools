# -*- coding: utf-8 -*-
"""角色库和写作技能选择弹窗。"""
import tkinter as tk
from tkinter import messagebox

import customtkinter as ctk

from llm_adapters import create_llm_adapter
from services.skill_service import SkillService
from ui.role_library import RoleLibrary


def show_role_library(window):
    save_path = window.filepath_var.get().strip()
    if not save_path:
        messagebox.showwarning("警告", "请先设置保存路径")
        return
    llm_adapter = create_llm_adapter(
        interface_format=window.interface_format_var.get(),
        base_url=window.base_url_var.get(),
        model_name=window.model_name_var.get(),
        api_key=window.api_key_var.get(),
        temperature=window.temperature_var.get(),
        max_tokens=window.max_tokens_var.get(),
        timeout=window.timeout_var.get(),
    )
    if hasattr(window, "_role_lib") and window._role_lib.window.winfo_exists():
        window._role_lib.window.destroy()
    window._role_lib = RoleLibrary(window.master, save_path, llm_adapter)


def show_skill_selector(window):
    skills = SkillService(window.loaded_config).load()
    if not skills:
        messagebox.showinfo("写作技能", "当前技能库中没有可用的 JSON 技能。")
        return
    dialog = ctk.CTkToplevel(window.master)
    dialog.title("工程写作技能")
    dialog.geometry("460x520")
    frame = ctk.CTkScrollableFrame(dialog)
    frame.pack(fill="both", expand=True, padx=10, pady=10)
    variables = {}
    selected = set(getattr(window, "selected_skill_ids", []))
    for skill_id, skill in skills.items():
        variable = tk.BooleanVar(value=skill_id in selected)
        variables[skill_id] = variable
        ctk.CTkCheckBox(frame, text=str(skill["name"]), variable=variable).pack(anchor="w", pady=4)

    def confirm():
        window.selected_skill_ids = [item for item, variable in variables.items() if variable.get()]
        window.save_project_settings()
        dialog.destroy()

    ctk.CTkButton(dialog, text="确认", command=confirm).pack(pady=(0, 10))
    dialog.transient(window.master)
    dialog.grab_set()
