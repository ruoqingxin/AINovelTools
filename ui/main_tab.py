# ui/main_tab.py
# -*- coding: utf-8 -*-
import customtkinter as ctk

from ui.context_menu import TextWidgetContextMenu
from utils import get_word_count


FONT = ("Microsoft YaHei", 12)


def build_main_tab(self):
    """Build the project setup and full-book planning workspace."""
    self.main_tab = self.tabview.add("全书规划")
    self.main_tab.rowconfigure(0, weight=1)
    self.main_tab.columnconfigure(0, weight=3, uniform="planning_columns", minsize=560)
    self.main_tab.columnconfigure(1, weight=2, uniform="planning_columns", minsize=440)

    self.planning_left_frame = ctk.CTkFrame(self.main_tab)
    self.planning_left_frame.grid(row=0, column=0, sticky="nsew", padx=2, pady=2)
    self.right_frame = ctk.CTkFrame(self.main_tab)
    self.right_frame.grid(row=0, column=1, sticky="nsew", padx=2, pady=2)

    build_planning_log_layout(self)
    build_right_layout(self)


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


def build_planning_log_layout(self):
    self.planning_left_frame.rowconfigure(0, weight=0)
    self.planning_left_frame.rowconfigure(1, weight=1)
    self.planning_left_frame.columnconfigure(0, weight=1)

    _build_log_header(self, self.planning_left_frame, 0, "btn_clear_planning_log")
    self.planning_log_text = ctk.CTkTextbox(
        self.planning_left_frame, wrap="word", font=FONT
    )
    TextWidgetContextMenu(self.planning_log_text)
    self.planning_log_text.grid(row=1, column=0, sticky="nsew", padx=5, pady=(0, 5))
    self.planning_log_text.configure(state="disabled")


def build_left_layout(self):
    """Chapter text editor and its synchronized operation log."""
    frame = self.chapter_left_frame
    frame.grid_rowconfigure(0, weight=0)
    frame.grid_rowconfigure(1, weight=2)
    frame.grid_rowconfigure(2, weight=0)
    frame.grid_rowconfigure(3, weight=1)
    frame.columnconfigure(0, weight=1)

    self.chapter_label = ctk.CTkLabel(
        frame, text="当前章节正文（可编辑）  字数：0", font=FONT
    )
    self.chapter_label.grid(row=0, column=0, padx=5, pady=(5, 0), sticky="w")

    self.chapter_result = ctk.CTkTextbox(frame, wrap="word", font=("Microsoft YaHei", 14))
    TextWidgetContextMenu(self.chapter_result)
    self.chapter_result.grid(row=1, column=0, sticky="nsew", padx=5, pady=(0, 5))

    def update_word_count(_event=None):
        count = get_word_count(self.chapter_result.get("0.0", "end-1c"))
        self.chapter_label.configure(text=f"当前章节正文（可编辑）  字数：{count}")

    self.chapter_result.bind("<KeyRelease>", update_word_count)
    self.chapter_result.bind("<ButtonRelease>", update_word_count)

    _build_log_header(self, frame, 2, "btn_clear_log")
    self.log_text = ctk.CTkTextbox(frame, wrap="word", font=FONT)
    TextWidgetContextMenu(self.log_text)
    self.log_text.grid(row=3, column=0, sticky="nsew", padx=5, pady=(0, 5))
    self.log_text.configure(state="disabled")


def build_right_layout(self):
    self.right_frame.grid_rowconfigure(0, weight=1)
    self.right_frame.columnconfigure(0, weight=1)


def build_chapter_right_layout(self):
    self.chapter_right_frame.grid_rowconfigure(0, weight=1)
    self.chapter_right_frame.grid_rowconfigure(1, weight=0)
    self.chapter_right_frame.columnconfigure(0, weight=1)
