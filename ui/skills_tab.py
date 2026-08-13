# -*- coding: utf-8 -*-
"""Writing skill library and generation-time skill selection UI."""
import os
import uuid
from tkinter import filedialog, messagebox
import customtkinter as ctk


FONT = ("Microsoft YaHei", 12)


def _skills(self):
    skills = self.loaded_config.setdefault("writing_skills", [])
    for skill in skills:
        skill.setdefault("id", str(uuid.uuid4()))
        skill.setdefault("name", "未命名技能")
        skill.setdefault("category", "通用")
        skill.setdefault("description", "")
        skill.setdefault("prompt", "")
        skill.setdefault("enabled", True)
    return skills


def _save(self):
    from config_manager import save_config
    save_config(self.loaded_config, self.config_file)


def build_skills_tab(self, parent):
    self.skills_tab = parent
    self.skills_tab.columnconfigure(0, weight=1)
    self.skills_tab.rowconfigure(1, weight=1)
    header = ctk.CTkFrame(parent, fg_color="transparent")
    header.grid(row=0, column=0, sticky="ew", padx=12, pady=(12, 4))
    header.columnconfigure(0, weight=1)
    ctk.CTkLabel(header, text="写作技能库", font=("Microsoft YaHei", 17, "bold")).grid(row=0, column=0, sticky="w")
    ctk.CTkLabel(header, text="管理可复用的写作规则，生成章节时可自由组合", text_color=("#667085", "#98A2B3")).grid(row=1, column=0, sticky="w", pady=(2, 0))
    ctk.CTkButton(header, text="导入 Markdown", width=110, command=lambda: import_skill_file(self)).grid(row=0, column=1, rowspan=2, padx=5)
    ctk.CTkButton(header, text="新增技能", width=90, command=lambda: edit_skill(self)).grid(row=0, column=2, rowspan=2, padx=(0, 5))

    body = ctk.CTkFrame(parent)
    body.grid(row=1, column=0, sticky="nsew", padx=12, pady=(4, 12))
    body.columnconfigure(0, weight=1)
    body.rowconfigure(1, weight=1)
    self.skills_summary = ctk.CTkLabel(body, text="", anchor="w")
    self.skills_summary.grid(row=0, column=0, sticky="ew", padx=10, pady=8)
    self.skills_list = ctk.CTkScrollableFrame(body, label_text="我的技能")
    self.skills_list.grid(row=1, column=0, sticky="nsew", padx=8, pady=(0, 8))
    refresh_skills(self)


def refresh_skills(self):
    if not hasattr(self, "skills_list"):
        return
    for child in self.skills_list.winfo_children():
        child.destroy()
    skills = _skills(self)
    enabled = sum(1 for item in skills if item.get("enabled", True))
    self.skills_summary.configure(text=f"共 {len(skills)} 个技能 · {enabled} 个已启用")
    if not skills:
        ctk.CTkLabel(self.skills_list, text="还没有技能，点击“新增技能”或导入 Markdown。", text_color=("#667085", "#98A2B3")).pack(pady=30)
        return
    for skill in skills:
        row = ctk.CTkFrame(self.skills_list, border_width=1, border_color=("#D0D5DD", "#475467"))
        row.pack(fill="x", padx=4, pady=4)
        row.columnconfigure(1, weight=1)
        enabled_var = ctk.BooleanVar(value=skill.get("enabled", True))
        ctk.CTkCheckBox(row, text="", width=28, variable=enabled_var, command=lambda s=skill, v=enabled_var: toggle_skill(self, s, v)).grid(row=0, column=0, rowspan=2, padx=(8, 2), pady=8)
        title = f"{skill.get('name', '未命名技能')}  ·  {skill.get('category', '通用')}"
        ctk.CTkLabel(row, text=title, anchor="w", font=("Microsoft YaHei", 13, "bold")).grid(row=0, column=1, sticky="ew", padx=4, pady=(7, 0))
        desc = skill.get("description") or skill.get("prompt", "").replace("\n", " ")[:100]
        ctk.CTkLabel(row, text=desc, anchor="w", justify="left", wraplength=620, text_color=("#475467", "#D0D5DD")).grid(row=1, column=1, sticky="ew", padx=4, pady=(1, 7))
        ctk.CTkButton(row, text="编辑", width=58, command=lambda s=skill: edit_skill(self, s)).grid(row=0, column=2, rowspan=2, padx=4)
        ctk.CTkButton(row, text="删除", width=58, fg_color=("#B42318", "#8F1D16"), hover_color=("#912018", "#731712"), command=lambda s=skill: delete_skill(self, s)).grid(row=0, column=3, rowspan=2, padx=(0, 8))


def toggle_skill(self, skill, value):
    skill["enabled"] = bool(value.get())
    _save(self)
    refresh_skills(self)


def delete_skill(self, skill):
    if not messagebox.askyesno("删除技能", f"确定删除“{skill.get('name', '')}”吗？"):
        return
    self.loaded_config["writing_skills"] = [item for item in _skills(self) if item.get("id") != skill.get("id")]
    _save(self)
    refresh_skills(self)


def edit_skill(self, skill=None):
    skill = skill or {"id": str(uuid.uuid4()), "name": "", "category": "通用", "description": "", "prompt": "", "enabled": True}
    dialog = ctk.CTkToplevel(self.master)
    dialog.title("编辑写作技能")
    dialog.geometry("650x520")
    dialog.grab_set()
    dialog.columnconfigure(1, weight=1)
    for row, label, key in ((0, "名称", "name"), (1, "分类", "category"), (2, "简介", "description")):
        ctk.CTkLabel(dialog, text=label, font=FONT).grid(row=row, column=0, sticky="e", padx=10, pady=8)
        entry = ctk.CTkEntry(dialog, font=FONT)
        entry.insert(0, skill.get(key, ""))
        entry.grid(row=row, column=1, sticky="ew", padx=(0, 12), pady=8)
        setattr(dialog, f"_{key}", entry)
    ctk.CTkLabel(dialog, text="规则提示词", font=FONT).grid(row=3, column=0, sticky="ne", padx=10, pady=8)
    prompt = ctk.CTkTextbox(dialog, height=260, font=FONT, wrap="word")
    prompt.insert("0.0", skill.get("prompt", ""))
    prompt.grid(row=3, column=1, sticky="nsew", padx=(0, 12), pady=8)
    dialog.rowconfigure(3, weight=1)
    def save_skill():
        skill["name"] = dialog._name.get().strip() or "未命名技能"
        skill["category"] = dialog._category.get().strip() or "通用"
        skill["description"] = dialog._description.get().strip()
        skill["prompt"] = prompt.get("0.0", "end-1c").strip()
        if not skill["prompt"]:
            messagebox.showwarning("缺少规则", "请填写技能规则提示词。", parent=dialog)
            return
        skills = _skills(self)
        if not any(item.get("id") == skill.get("id") for item in skills):
            skills.append(skill)
        _save(self)
        refresh_skills(self)
        dialog.destroy()
    ctk.CTkButton(dialog, text="保存技能", command=save_skill, height=34).grid(row=4, column=1, sticky="e", padx=12, pady=10)


def import_skill_file(self):
    path = filedialog.askopenfilename(filetypes=[("Markdown", "*.md"), ("文本", "*.txt"), ("所有文件", "*.*")])
    if not path:
        return
    try:
        content = open(path, "r", encoding="utf-8").read().strip()
    except (OSError, UnicodeDecodeError) as exc:
        messagebox.showerror("导入失败", str(exc))
        return
    name = os.path.splitext(os.path.basename(path))[0]
    skill = {"id": str(uuid.uuid4()), "name": name, "category": "导入", "description": "从 Markdown 导入", "prompt": content, "enabled": True}
    _skills(self).append(skill)
    _save(self)
    refresh_skills(self)


def open_skill_selector(self):
    skills = [s for s in _skills(self) if s.get("enabled", True)]
    if not skills:
        messagebox.showinfo("选择写作技能", "技能库中暂无已启用技能，请先到“设置 > 写作技能”添加。")
        return
    dialog = ctk.CTkToplevel(self.master)
    dialog.title("选择本次生成使用的技能")
    dialog.geometry("560x480")
    dialog.grab_set()
    selected = set(getattr(self, "selected_skill_ids", []))
    vars_by_id = {}
    ctk.CTkLabel(dialog, text="勾选后，技能规则会加入本次章节生成提示词。", anchor="w").pack(fill="x", padx=14, pady=(12, 6))
    frame = ctk.CTkScrollableFrame(dialog)
    frame.pack(fill="both", expand=True, padx=10, pady=5)
    for skill in skills:
        var = ctk.BooleanVar(value=skill.get("id") in selected)
        vars_by_id[skill.get("id")] = var
        ctk.CTkCheckBox(frame, text=f"{skill.get('name')}  ·  {skill.get('category', '通用')}", variable=var).pack(fill="x", padx=8, pady=6)
    def confirm():
        self.selected_skill_ids = [sid for sid, var in vars_by_id.items() if var.get()]
        update_skill_selection_label(self)
        dialog.destroy()
    ctk.CTkButton(dialog, text="确认选择", command=confirm, height=34).pack(anchor="e", padx=14, pady=12)


def get_selected_skill_prompt(self):
    ids = set(getattr(self, "selected_skill_ids", []))
    selected = [s for s in _skills(self) if s.get("id") in ids and s.get("enabled", True) and s.get("prompt", "").strip()]
    if not selected:
        return ""
    return "\n\n【本次启用的写作技能】\n" + "\n\n".join(f"【{s.get('name', '技能')}】\n{s['prompt'].strip()}" for s in selected)


def update_skill_selection_label(self):
    count = len(getattr(self, "selected_skill_ids", []))
    for attr in ("skill_selection_button", "architecture_skill_selection_button", "blueprint_skill_selection_button"):
        button = getattr(self, attr, None)
        if button is not None:
            button.configure(text=f"选择写作技能（{count}）")
