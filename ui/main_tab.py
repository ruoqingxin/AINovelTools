# ui/main_tab.py
# -*- coding: utf-8 -*-
import customtkinter as ctk

from ui.context_menu import TextWidgetContextMenu
from ui.chapters_tab import build_chapter_navigation
from utils import get_word_count


FONT = ("Microsoft YaHei", 12)


def build_global_log_area(self):
    """Build the window-level log that stays visible while tabs change."""
    self.global_log_frame = ctk.CTkFrame(self.master)
    self.global_log_frame.grid(
        row=0, column=0, sticky="ew", padx=5, pady=(5, 0)
    )
    self.global_log_frame.columnconfigure(0, weight=1)

    self.task_status_label = ctk.CTkLabel(
        self.global_log_frame,
        text="状态：就绪",
        anchor="w",
        font=("Microsoft YaHei", 11),
        text_color=("#475467", "#98A2B3"),
    )
    self.task_status_label.grid(row=0, column=0, sticky="ew", padx=8, pady=(4, 0))
    self.task_progress_bar = ctk.CTkProgressBar(self.global_log_frame, height=8)
    self.task_progress_bar.grid(row=0, column=1, padx=(8, 8), pady=(6, 0), sticky="ew")
    self.task_progress_bar.set(0)
    self.global_log_frame.columnconfigure(1, weight=0, minsize=180)

    self.global_log_header = _build_log_header(
        self, self.global_log_frame, 1, "btn_clear_log"
    )
    self.btn_view_log_details = ctk.CTkButton(
        self.global_log_header,
        text="查看详情",
        command=self.show_log_details,
        width=80,
        height=26,
        font=FONT,
    )
    self.btn_view_log_details.grid(row=0, column=2, padx=(8, 0), sticky="e")
    self.btn_cancel_ai = ctk.CTkButton(
        self.global_log_header,
        text="中止 AI",
        command=self.cancel_active_operation,
        state="disabled",
        width=80,
        height=26,
        font=FONT,
        fg_color=("#b42318", "#8f1d16"),
        hover_color=("#912018", "#731712"),
    )
    self.btn_cancel_ai.grid(row=0, column=3, padx=(8, 0), sticky="e")
    self.log_text = ctk.CTkTextbox(
        self.global_log_frame, height=46, wrap="word", font=FONT
    )
    TextWidgetContextMenu(self.log_text)
    self.log_text.grid(row=2, column=0, sticky="ew", padx=5, pady=(0, 5))
    self.log_text.configure(state="disabled")


def build_chapter_editor_tab(self):
    """Build the dedicated current-chapter writing workspace."""
    self.chapter_editor_tab = self.tabview.add("章节创作")
    self.chapter_editor_tab.rowconfigure(0, weight=1)
    self.chapter_editor_tab.columnconfigure(
        0, weight=3, uniform="chapter_columns", minsize=620
    )
    self.chapter_editor_tab.columnconfigure(
        1, weight=2, uniform="chapter_columns", minsize=440
    )

    self.chapter_left_frame = ctk.CTkFrame(self.chapter_editor_tab)
    self.chapter_left_frame.grid(row=0, column=0, sticky="nsew", padx=2, pady=2)
    self.chapter_right_frame = ctk.CTkFrame(self.chapter_editor_tab)
    self.chapter_right_frame.grid(row=0, column=1, sticky="nsew", padx=2, pady=2)

    build_left_layout(self)
    build_chapter_right_layout(self)
    build_chapter_navigation(self)


def _build_log_header(self, parent, row, button_attr):
    header = ctk.CTkFrame(parent, fg_color="transparent")
    header.grid(row=row, column=0, padx=5, pady=(5, 0), sticky="ew")
    header.columnconfigure(0, weight=1)
    ctk.CTkLabel(header, text="输出日志（只读）", font=FONT).grid(
        row=0, column=0, sticky="w"
    )
    clear_button = ctk.CTkButton(
        header,
        text="清空日志",
        command=self.clear_app_log,
        width=80,
        height=26,
        font=FONT,
    )
    clear_button.grid(row=0, column=1, sticky="e")
    setattr(self, button_attr, clear_button)
    return header


def build_left_layout(self):
    """Build the side-by-side chapter version editors."""
    frame = self.chapter_left_frame
    frame.grid_rowconfigure(0, weight=1)
    frame.columnconfigure(0, weight=1)

    comparison = ctk.CTkFrame(frame, fg_color="transparent")
    comparison.grid(row=0, column=0, sticky="nsew", padx=3, pady=3)
    comparison.rowconfigure(1, weight=1)
    comparison.columnconfigure((0, 1), weight=1, uniform="chapter_versions")

    self.chapter_before_label = ctk.CTkLabel(
        comparison, text="修改前正文（只读）  字数：0", font=FONT
    )
    self.chapter_before_label.grid(row=0, column=0, padx=3, sticky="w")
    self.chapter_label = ctk.CTkLabel(
        comparison, text="修改后正文（可编辑）  字数：0", font=FONT
    )
    self.chapter_label.grid(row=0, column=1, padx=3, sticky="w")

    self.chapter_before_result = ctk.CTkTextbox(
        comparison, wrap="word", font=("Microsoft YaHei", 14)
    )
    TextWidgetContextMenu(self.chapter_before_result)
    self.chapter_before_result.grid(
        row=1, column=0, sticky="nsew", padx=(3, 2), pady=(0, 3)
    )
    self.chapter_before_result.configure(state="disabled")

    self.chapter_result = ctk.CTkTextbox(
        comparison, wrap="word", font=("Microsoft YaHei", 14)
    )
    TextWidgetContextMenu(self.chapter_result)
    self.chapter_result.grid(
        row=1, column=1, sticky="nsew", padx=(2, 3), pady=(0, 3)
    )

    def update_word_count(_event=None):
        count = get_word_count(self.chapter_result.get("0.0", "end-1c"))
        if getattr(self, "_chapter_draft_dirty", False):
            self._set_chapter_draft_dirty(True)
        else:
            self.chapter_label.configure(text=f"修改后正文（可编辑）  字数：{count} · 已保存")

    self.chapter_result.bind("<KeyRelease>", update_word_count)
    self.chapter_result.bind("<ButtonRelease>", update_word_count)
    self.chapter_result.bind(
        "<KeyRelease>", lambda _event: self._set_chapter_draft_dirty(True), add="+"
    )


def build_chapter_right_layout(self):
    self.chapter_right_frame.grid_rowconfigure(0, weight=1)
    self.chapter_right_frame.grid_rowconfigure(1, weight=0)
    self.chapter_right_frame.columnconfigure(0, weight=1)
