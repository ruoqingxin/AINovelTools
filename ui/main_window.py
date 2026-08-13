# ui/main_window.py
# -*- coding: utf-8 -*-
import os
import threading
import logging
import traceback
import time
import customtkinter as ctk
import tkinter as tk
from tkinter import filedialog, messagebox
from .role_library import RoleLibrary
from app_runtime import APP_LOG_HANDLER_MARKER, get_application_dir, get_config_path, get_log_path
from llm_adapters import create_llm_adapter
from novel_generator.storage import NovelProjectRepository
from ai_cancellation import (
    CancellationToken,
    OperationCancelled,
    reset_progress_callback,
    reset_current_token,
    set_progress_callback,
    set_current_token,
)

from config_manager import load_config, save_config, test_llm_config, test_embedding_config
from utils import read_file, get_word_count
from tooltips import tooltips

from ui.context_menu import TextWidgetContextMenu
from ui.main_tab import build_chapter_editor_tab, build_global_log_area
from ui.config_tab import load_config_btn, save_config_btn, save_embedding_config
from ui.novel_params_tab import (
    build_chapter_params_area,
    build_optional_buttons_area,
)
from ui.generation_handlers import (
    generate_chapter_blueprint_ui,
    revise_architecture_section_ui,
    revise_chapter_blueprint_ui,
    generate_chapter_draft_ui,
    revise_chapter_draft_ui,
    finalize_chapter_ui,
    do_consistency_check,
    import_knowledge_handler,
    import_knowledge_files,
    import_knowledge_folder,
    clear_vectorstore_handler,
    show_plot_arcs_ui,
    generate_batch_ui,
    show_finalize_result,
)
from ui.setting_tab import (
    add_architecture_subsection,
    apply_extracted_architecture_content,
    architecture_section_has_unsaved_changes,
    architecture_section_unsaved_reasons,
    _architecture_active_title,
    _architecture_item_key,
    _display_architecture_section,
    _save_active_architecture_section,
    _set_architecture_active_baseline,
    _set_architecture_tree_selection,
    build_setting_tab,
    clear_novel_architecture,
    delete_selected_architecture_section,
    get_selected_architecture_section,
    is_architecture_overview_selected,
    load_novel_architecture,
    on_architecture_editor_tab_changed,
    on_architecture_section_selected,
    refresh_architecture_sections,
    save_architecture_section,
    sync_architecture_section,
    save_novel_architecture,
    update_architecture_workflow_state,
    update_architecture_input_visibility,
    toggle_architecture_input_panel,
    load_outline_workflow_step,
    load_outline_workflow_project,
    confirm_outline_step,
    extract_outline_step_from_file,
    derive_outline_step_with_ai,
    finalize_outline_workflow,
)
from ui.directory_tab import build_directory_tab, load_chapter_blueprint, save_chapter_blueprint, clear_chapter_blueprint
from ui.character_tab import build_character_tab, load_character_state, save_character_state
from ui.summary_tab import build_summary_tab, load_global_summary, save_global_summary
from ui.chapters_tab import refresh_chapters_list, on_chapter_selected, load_chapter_content, save_current_chapter, prev_chapter, next_chapter, build_chapter_navigation
from ui.other_settings import build_other_settings_tab


LOG_ROLE_STYLES = {
    "[发送给 AI]": ("◆ 我的请求", "log_ai_request", "#1976d2"),
    "[AI 返回]": ("◆ AI 返回", "log_ai_response", "#16803a"),
}


def split_log_role_marker(message: str):
    """Return a display marker, tag and untouched body for AI interaction logs."""
    for source_marker, (display_marker, tag_name, color) in LOG_ROLE_STYLES.items():
        if message == source_marker:
            return display_marker, tag_name, color, ""
        prefix = source_marker + "\n"
        if message.startswith(prefix):
            return display_marker, tag_name, color, message[len(prefix):]
    return None


class NovelGeneratorGUI:
    """
    小说生成器的主GUI类，包含所有的界面布局、事件处理、与后端逻辑的交互等。
    """
    def __init__(self, master):
        self.master = master
        self._closing = False
        self._operation_lock = threading.Lock()
        self._active_operations = set()
        self._active_cancellation_token = None
        self._task_status_after_id = None
        self._task_started_at = None
        self._task_status_message = "就绪"
        self._chapter_draft_dirty = False
        self._chapter_draft_baseline = ""
        self._project_persist_after_id = None
        self.master.title("AI 小说生成器")
        try:
            icon_path = get_application_dir() / "icon.ico"
            if icon_path.exists():
                self.master.iconbitmap(str(icon_path))
        except (OSError, tk.TclError):
            logging.debug("Unable to load the application icon", exc_info=True)
        screen_width = self.master.winfo_screenwidth()
        screen_height = self.master.winfo_screenheight()
        window_width = min(1450, max(800, screen_width - 100))
        window_height = min(900, max(600, screen_height - 120))
        window_x = max(0, (screen_width - window_width) // 2)
        window_y = max(0, (screen_height - window_height) // 2)
        self.master.geometry(f"{window_width}x{window_height}+{window_x}+{window_y}")
        self.master.minsize(min(1080, window_width), min(680, window_height))

        # --------------- 配置文件路径 ---------------
        self.config_file = str(get_config_path())
        self.loaded_config = load_config(self.config_file)

        llm_configs = self.loaded_config.get("llm_configs", {})
        last_llm_config_name = self.loaded_config.get("last_llm_config_name")
        if last_llm_config_name not in llm_configs:
            last_llm_config_name = next(iter(llm_configs), "")
        llm_conf = llm_configs.get(last_llm_config_name, {})
        choose_configs = self.loaded_config.get("choose_configs", {})

        embedding_configs = self.loaded_config.get("embedding_configs", {})
        last_embedding = self.loaded_config.get("last_embedding_interface_format", "OpenAI")
        if last_embedding not in embedding_configs:
            last_embedding = next(iter(embedding_configs), "OpenAI")

        if last_embedding in embedding_configs:
            emb_conf = embedding_configs[last_embedding]
        else:
            emb_conf = {
                "api_key": "",
                "base_url": "https://api.openai.com/v1",
                "model_name": "text-embedding-3-small",
                "retrieval_k": 4
            }

        # PenBo 增加代理功能支持
        proxy_setting = self.loaded_config.get("proxy_setting", {})
        proxy_url = proxy_setting.get("proxy_url", "127.0.0.1")
        proxy_port = proxy_setting.get("proxy_port", "")
        if proxy_setting.get("enabled", False):
            os.environ['HTTP_PROXY'] = f"http://{proxy_url}:{proxy_port}"
            os.environ['HTTPS_PROXY'] = f"http://{proxy_url}:{proxy_port}"
        else:
            os.environ.pop('HTTP_PROXY', None)  
            os.environ.pop('HTTPS_PROXY', None)



        # -- LLM通用参数 --
        # self.llm_conf_name = next(iter(self.loaded_config["llm_configs"]))
        self.api_key_var = ctk.StringVar(value=llm_conf.get("api_key", ""))
        self.base_url_var = ctk.StringVar(value=llm_conf.get("base_url", "https://api.openai.com/v1"))
        self.interface_format_var = ctk.StringVar(value=llm_conf.get("interface_format", "OpenAI"))
        self.model_name_var = ctk.StringVar(value=llm_conf.get("model_name", "gpt-5.5"))
        self.temperature_var = ctk.DoubleVar(value=llm_conf.get("temperature", 0.7))
        self.max_tokens_var = ctk.IntVar(value=llm_conf.get("max_tokens", 8192))
        self.timeout_var = ctk.IntVar(value=llm_conf.get("timeout", 600))
        self.interface_config_var = ctk.StringVar(value=last_llm_config_name)



        # -- Embedding相关 --
        self.embedding_interface_format_var = ctk.StringVar(value=last_embedding)
        self.embedding_api_key_var = ctk.StringVar(value=emb_conf.get("api_key", ""))
        self.embedding_url_var = ctk.StringVar(value=emb_conf.get("base_url", "https://api.openai.com/v1"))
        self.embedding_model_name_var = ctk.StringVar(value=emb_conf.get("model_name", "text-embedding-3-small"))
        self.embedding_retrieval_k_var = ctk.StringVar(value=str(emb_conf.get("retrieval_k", 4)))


        # -- 生成配置相关 --
        def choose_llm_config(key):
            selected = choose_configs.get(key)
            if selected in llm_configs:
                return selected
            return last_llm_config_name

        self.architecture_llm_var = ctk.StringVar(value=choose_llm_config("architecture_llm"))
        self.chapter_outline_llm_var = ctk.StringVar(value=choose_llm_config("chapter_outline_llm"))
        self.final_chapter_llm_var = ctk.StringVar(value=choose_llm_config("final_chapter_llm"))
        self.consistency_review_llm_var = ctk.StringVar(value=choose_llm_config("consistency_review_llm"))
        self.prompt_draft_llm_var = ctk.StringVar(value=choose_llm_config("prompt_draft_llm"))





        # -- 小说参数相关 --
        if self.loaded_config and "other_params" in self.loaded_config:
            op = self.loaded_config["other_params"]
            self.topic_default = op.get("topic", "")
            self.genre_var = ctk.StringVar(value=op.get("genre", "玄幻"))
            self.num_chapters_var = ctk.StringVar(value=str(op.get("num_chapters", 10)))
            self.word_number_var = ctk.StringVar(value=str(op.get("word_number", 3000)))
            self.filepath_var = ctk.StringVar(value=op.get("filepath", ""))
            self.chapter_num_var = ctk.StringVar(value=str(op.get("chapter_num", "1")))
            self.characters_involved_var = ctk.StringVar(value=op.get("characters_involved", ""))
            self.key_items_var = ctk.StringVar(value=op.get("key_items", ""))
            self.scene_location_var = ctk.StringVar(value=op.get("scene_location", ""))
            self.time_constraint_var = ctk.StringVar(value=op.get("time_constraint", ""))
            legacy_guidance = op.get("user_guidance", "")
            self.planning_guidance_default = op.get("planning_guidance") or legacy_guidance
            self.chapter_guidance_default = op.get("chapter_guidance", "")
            self.webdav_url_var = ctk.StringVar(value=op.get("webdav_url", ""))
            self.webdav_username_var = ctk.StringVar(value=op.get("webdav_username", ""))
            self.webdav_password_var = ctk.StringVar(value=op.get("webdav_password", ""))

        else:
            self.topic_default = ""
            self.genre_var = ctk.StringVar(value="玄幻")
            self.num_chapters_var = ctk.StringVar(value="10")
            self.word_number_var = ctk.StringVar(value="3000")
            self.filepath_var = ctk.StringVar(value="")
            self.chapter_num_var = ctk.StringVar(value="1")
            self.characters_involved_var = ctk.StringVar(value="")
            self.key_items_var = ctk.StringVar(value="")
            self.scene_location_var = ctk.StringVar(value="")
            self.time_constraint_var = ctk.StringVar(value="")
            self.planning_guidance_default = ""
        self.chapter_guidance_default = ""

        self.blueprint_mode_var = ctk.StringVar(value="全书蓝图")
        self.blueprint_start_var = ctk.StringVar(value="1")
        self.blueprint_end_var = ctk.StringVar(value=str(self.num_chapters_var.get()))
        self.blueprint_phase_var = ctk.StringVar(value="")

        # --------------- 全局日志与整体Tab布局 ---------------
        self.master.grid_rowconfigure(0, weight=0)
        self.master.grid_rowconfigure(1, weight=1)
        self.master.grid_columnconfigure(0, weight=1)

        build_global_log_area(self)

        self.tabview = ctk.CTkTabview(self.master)
        self.tabview.grid(row=1, column=0, sticky="nsew")

        # 创建各个标签页
        build_setting_tab(self)
        build_directory_tab(self)
        build_chapter_editor_tab(self)
        build_chapter_params_area(self, start_row=0)
        build_optional_buttons_area(self, start_row=1)
        build_character_tab(self)
        build_summary_tab(self)
        build_other_settings_tab(self)

        self.master.protocol("WM_DELETE_WINDOW", self.close)
        self.master.after_idle(self.finish_startup)


    # ----------------- 通用辅助函数 -----------------
    def show_tooltip(self, key: str):
        info_text = tooltips.get(key, "暂无说明")
        messagebox.showinfo("参数说明", info_text)

    def safe_get_int(self, var, default=1):
        try:
            val_str = str(var.get()).strip()
            return int(val_str)
        except (TypeError, ValueError, tk.TclError):
            var.set(str(default))
            return default

    def log(self, message: str):
        for log_widget in self._log_widgets():
            try:
                log_widget.configure(state="normal")
                self._insert_colored_log(log_widget, message)
                log_widget.see("end")
                log_widget.configure(state="disabled")
            except tk.TclError:
                continue

    @staticmethod
    def _insert_colored_log(log_widget, message: str):
        role = split_log_role_marker(message)
        if role is None:
            log_widget.insert("end", message + "\n")
            return
        marker, tag_name, color, body = role
        log_widget.tag_config(tag_name, foreground=color)
        log_widget.insert("end", marker, tag_name)
        log_widget.insert("end", "\n")
        if body:
            log_widget.insert("end", body)
        log_widget.insert("end", "\n")

    def _insert_log_history(self, log_widget, content: str):
        """Restore copied log history while retaining role marker colors."""
        history_markers = {
            "[发送给 AI]": LOG_ROLE_STYLES["[发送给 AI]"],
            "[AI 返回]": LOG_ROLE_STYLES["[AI 返回]"],
            "◆ 我的请求": LOG_ROLE_STYLES["[发送给 AI]"],
            "◆ AI 返回": LOG_ROLE_STYLES["[AI 返回]"],
        }
        cursor = 0
        while cursor < len(content):
            candidates = []
            for marker in history_markers:
                index = content.find(marker, cursor)
                if index >= 0 and (index == 0 or content[index - 1] == "\n"):
                    candidates.append((index, marker))
            if not candidates:
                log_widget.insert("end", content[cursor:])
                break
            marker_start, source_marker = min(candidates, key=lambda item: item[0])
            if marker_start > cursor:
                log_widget.insert("end", content[cursor:marker_start])
            marker_end = content.find("\n", marker_start)
            if marker_end < 0:
                marker_end = len(content)
            display_marker, tag_name, color = history_markers[source_marker]
            log_widget.tag_config(tag_name, foreground=color)
            log_widget.insert("end", display_marker, tag_name)
            if marker_end < len(content):
                log_widget.insert("end", "\n")
                cursor = marker_end + 1
            else:
                cursor = marker_end

    def _log_widgets(self):
        widgets = []
        for widget_name in ("log_text", "detail_log_text"):
            widget = getattr(self, widget_name, None)
            if widget is not None and widget not in widgets:
                widgets.append(widget)
        return tuple(widgets)

    def show_log_details(self):
        """Open a large read-only window and keep it synchronized with the log."""
        existing = getattr(self, "_log_detail_window", None)
        try:
            if existing is not None and existing.winfo_exists():
                existing.deiconify()
                existing.lift()
                existing.focus_force()
                return
        except tk.TclError:
            pass

        window = ctk.CTkToplevel(self.master)
        window.title("运行日志详情")
        window.geometry("1100x720")
        window.minsize(760, 500)
        window.transient(self.master)
        window.grid_rowconfigure(1, weight=1)
        window.grid_columnconfigure(0, weight=1)

        header = ctk.CTkFrame(window, fg_color="transparent")
        header.grid(row=0, column=0, sticky="ew", padx=10, pady=(10, 4))
        header.columnconfigure(0, weight=1)
        ctk.CTkLabel(
            header,
            text="输出日志（只读）",
            font=("Microsoft YaHei", 14, "bold"),
        ).grid(row=0, column=0, sticky="w")
        ctk.CTkButton(
            header,
            text="清空日志",
            command=self.clear_app_log,
            width=90,
            height=28,
            font=("Microsoft YaHei", 12),
        ).grid(row=0, column=1, padx=(8, 0))
        ctk.CTkButton(
            header,
            text="关闭",
            command=self._close_log_details,
            width=70,
            height=28,
            font=("Microsoft YaHei", 12),
        ).grid(row=0, column=2, padx=(8, 0))

        detail_log_text = ctk.CTkTextbox(
            window,
            wrap="word",
            font=("Microsoft YaHei", 13),
        )
        TextWidgetContextMenu(detail_log_text)
        detail_log_text.grid(
            row=1, column=0, sticky="nsew", padx=10, pady=(4, 10)
        )
        source_log = getattr(self, "log_text", None)
        if source_log is not None:
            content = source_log.get("0.0", "end-1c")
            if content:
                self._insert_log_history(detail_log_text, content)
                detail_log_text.see("end")
        detail_log_text.configure(state="disabled")

        self._log_detail_window = window
        self.detail_log_text = detail_log_text
        window.protocol("WM_DELETE_WINDOW", self._close_log_details)
        window.after(50, window.focus_force)

    def _close_log_details(self):
        window = getattr(self, "_log_detail_window", None)
        self._log_detail_window = None
        self.detail_log_text = None
        if window is not None:
            try:
                window.destroy()
            except tk.TclError:
                pass

    def safe_log(self, message: str):
        self.call_in_ui(lambda: (self.log(message), self._set_task_status_from_log(message)))

    def _set_task_status_from_log(self, message: str):
        if self._task_started_at is not None:
            self._task_status_message = str(message).strip().replace("\n", " ")
        self.set_task_status(self._task_status_message if self._task_started_at else message)

    def set_task_status(self, message: str):
        label = getattr(self, "task_status_label", None)
        if label is None:
            return
        text = str(message).strip().replace("\n", " ") or "就绪"
        if len(text) > 100:
            text = text[:97] + "..."
        if self._task_started_at is not None:
            elapsed = int(max(0, time.monotonic() - self._task_started_at))
            text = f"{text} · 已耗时 {elapsed // 60:02d}:{elapsed % 60:02d}"
        label.configure(text=f"状态：{text}")

    def _refresh_task_status_clock(self):
        if self._task_started_at is not None:
            self.set_task_status(self._task_status_message)
            self._task_status_after_id = self.master.after(1000, self._refresh_task_status_clock)

    def _begin_task_status(self, message: str):
        self._task_started_at = time.monotonic()
        self._task_status_message = message
        self.set_task_status(message)
        progress = getattr(self, "task_progress_bar", None)
        if progress is not None:
            progress.set(0)
        self._task_status_after_id = self.master.after(1000, self._refresh_task_status_clock)

    def _end_task_status(self, message: str):
        self._task_started_at = None
        task_status_after_id = getattr(self, "_task_status_after_id", None)
        if task_status_after_id is not None:
            try:
                self.master.after_cancel(task_status_after_id)
            except tk.TclError:
                pass
            self._task_status_after_id = None
        self.set_task_status(message)
        progress = getattr(self, "task_progress_bar", None)
        if progress is not None:
            progress.set(0)

    def set_task_progress(self, value: float):
        progress = getattr(self, "task_progress_bar", None)
        if progress is not None:
            progress.configure(mode="determinate")
            progress.set(max(0.0, min(1.0, float(value))))

    def call_in_ui(self, callback) -> bool:
        """Schedule a callback only while the Tk application is alive."""
        if getattr(self, "_closing", False):
            return False

        def guarded_callback():
            if not getattr(self, "_closing", False):
                callback()

        try:
            self.master.after(0, guarded_callback)
            return True
        except (RuntimeError, tk.TclError):
            return False

    def start_background_operation(self, name: str, target, button=None) -> bool:
        """Start one named daemon task and reject accidental duplicate launches."""
        with self._operation_lock:
            if self._closing:
                return False
            if self._active_operations:
                self.safe_log("已有后台任务正在运行，请等待当前任务完成。")
                return False
            self._active_operations.add(name)
            cancellation_token = CancellationToken()
            self._active_cancellation_token = cancellation_token

        if button is not None:
            button.configure(state="disabled")
        cancel_button = getattr(self, "btn_cancel_ai", None)
        if cancel_button is not None:
            self.call_in_ui(lambda: cancel_button.configure(state="normal"))
        self.call_in_ui(lambda: self._begin_task_status(f"正在执行：{name}"))

        def run():
            context_token = set_current_token(cancellation_token)
            progress_token = set_progress_callback(self.safe_log)
            try:
                target()
                cancellation_token.raise_if_cancelled()
            except OperationCancelled:
                self.safe_log("⏹ AI 操作已中止，未完成的结果已丢弃。")
            finally:
                reset_progress_callback(progress_token)
                reset_current_token(context_token)
                with self._operation_lock:
                    self._active_operations.discard(name)
                    if self._active_cancellation_token is cancellation_token:
                        self._active_cancellation_token = None
                if button is not None:
                    self.enable_button_safe(button)
                if cancel_button is not None:
                    self.call_in_ui(lambda: cancel_button.configure(state="disabled"))
                self.call_in_ui(lambda: self._end_task_status("任务结束"))

        try:
            threading.Thread(
                target=run,
                daemon=True,
                name=f"ai-novel-{name}",
            ).start()
            return True
        except Exception:
            with self._operation_lock:
                self._active_operations.discard(name)
                if self._active_cancellation_token is cancellation_token:
                    self._active_cancellation_token = None
            if button is not None:
                button.configure(state="normal")
            if cancel_button is not None:
                cancel_button.configure(state="disabled")
            raise

    def cancel_active_operation(self):
        """Request cancellation of the currently active AI operation."""
        with self._operation_lock:
            token = self._active_cancellation_token
            active_operations = tuple(self._active_operations)
        if token is None or not active_operations:
            self.log("当前没有可中止的 AI 操作。")
            return
        token.cancel()
        self.btn_cancel_ai.configure(state="disabled", text="正在中止...")
        self.log("正在中止当前 AI 操作...")

        def restore_label():
            if not self._closing:
                self.btn_cancel_ai.configure(text="中止 AI")

        self.master.after(500, restore_label)

    def close(self):
        """Close cleanly, warning when background work is still in progress."""
        if not self._confirm_unsaved_content():
            return
        self.persist_project_settings()
        with self._operation_lock:
            active_operations = tuple(self._active_operations)
        if active_operations and not messagebox.askyesno(
            "任务仍在运行",
            "仍有生成或导入任务在后台运行。现在退出将中止这些任务，确定退出吗？",
        ):
            return
        self._closing = True
        if self._active_cancellation_token is not None:
            self._active_cancellation_token.cancel()
        logging.info("Application closing; active operations: %s", active_operations)
        self.master.destroy()

    @staticmethod
    def _service_config_ready(config: dict) -> bool:
        interface_format = str(config.get("interface_format", "")).strip().lower()
        if not config.get("base_url") or not config.get("model_name"):
            return False
        return interface_format in {"ollama", "ml studio"} or bool(config.get("api_key"))

    def _restore_project_files(self) -> int:
        project_path = self.filepath_var.get().strip()
        if not project_path or not os.path.isdir(project_path):
            return 0

        restored = 0
        text_files = (
            ("Novel_architecture.txt", self.setting_text, self.setting_word_count_label),
            ("Novel_directory.txt", self.directory_text, self.directory_word_count_label),
            ("character_state.txt", self.character_text, self.character_wordcount_label),
            ("global_summary.txt", self.summary_text, self.word_count_label),
        )
        for filename, widget, count_label in text_files:
            content = read_file(os.path.join(project_path, filename))
            if not content:
                continue
            widget.delete("0.0", "end")
            widget.insert("0.0", content)
            count_label.configure(text=f"字数：{get_word_count(content)}")
            restored += 1

        try:
            chapter_number = max(1, int(self.chapter_num_var.get()))
        except (TypeError, ValueError):
            chapter_number = 1
            self.chapter_num_var.set("1")
        repository = NovelProjectRepository(project_path)
        before_text = repository.read_chapter_revision_source(chapter_number)
        if before_text:
            self.show_chapter_before_textbox(before_text)
            restored += 1
        chapter_text = repository.read_chapter(chapter_number)
        if chapter_text:
            self.show_chapter_in_textbox(chapter_text)
            restored += 1
        return restored

    def finish_startup(self):
        """恢复项目内容，并将用户定位到当前最需要处理的配置或工作区。"""
        restored = self._restore_project_files()
        self.update_architecture_workflow_state()
        config = self.loaded_config
        llm_configs = config.get("llm_configs", {})
        task_configs = config.get("choose_configs", {})
        missing_llm = any(
            not self._service_config_ready(llm_configs.get(config_name, {}))
            for config_name in task_configs.values()
        )

        project_path = self.filepath_var.get().strip()
        vectorstore_exists = os.path.isdir(os.path.join(project_path, "vectorstore"))
        embedding_name = config.get("last_embedding_interface_format", "OpenAI")
        embedding_config = config.get("embedding_configs", {}).get(embedding_name, {})

        if missing_llm:
            self.tabview.set("设置")
            self.config_tabview.set("大模型设置")
            self.log("启动检查：任务所用大模型配置不完整，请填写并保存后再开始生成。")
        elif vectorstore_exists and not self._service_config_ready(embedding_config):
            self.tabview.set("设置")
            self.config_tabview.set("嵌入模型设置")
            self.log("启动检查：项目已有知识库，请先补全并保存嵌入模型配置。")
        else:
            self.tabview.set("大纲工作台")
            if restored:
                self.log(f"已恢复当前项目，共加载 {restored} 项内容。")

    def clear_app_log(self):
        """清空界面日志和 app.log，并与正在写入的日志处理器同步。"""
        if not messagebox.askyesno("确认清空日志", "确定要清空全部运行日志吗？此操作无法恢复。"):
            return

        file_handlers = [
            handler
            for handler in logging.getLogger().handlers
            if isinstance(handler, logging.FileHandler)
            and (
                getattr(handler, APP_LOG_HANDLER_MARKER, False)
                or os.path.basename(handler.baseFilename).lower() == "app.log"
            )
        ]
        log_paths = {
            os.path.abspath(handler.baseFilename)
            for handler in file_handlers
        } or {str(get_log_path().resolve())}

        acquired_handlers = []
        try:
            for handler in file_handlers:
                handler.acquire()
                acquired_handlers.append(handler)
                handler.flush()
            for log_path in log_paths:
                with open(log_path, "w", encoding="utf-8"):
                    pass
            for log_widget in self._log_widgets():
                try:
                    log_widget.configure(state="normal")
                    log_widget.delete("0.0", "end")
                    log_widget.configure(state="disabled")
                except tk.TclError:
                    continue
            messagebox.showinfo("清空日志", "运行日志已清空。")
        except OSError as exc:
            messagebox.showerror("清空失败", f"无法清空 app.log：{exc}")
        finally:
            for handler in reversed(acquired_handlers):
                handler.release()

    def disable_button_safe(self, btn):
        self.call_in_ui(lambda: btn.configure(state="disabled"))

    def enable_button_safe(self, btn):
        self.call_in_ui(lambda: btn.configure(state="normal"))

    def handle_exception(self, context: str):
        full_message = f"{context}\n{traceback.format_exc()}"
        logging.error(full_message)
        self.safe_log(f"{context}。详情已写入 app.log。")

    def show_chapter_in_textbox(self, text: str, mark_dirty: bool = False):
        self.chapter_result.delete("0.0", "end")
        self.chapter_result.insert("0.0", text)
        self.chapter_result.see("end")
        self._chapter_draft_baseline = text
        self._set_chapter_draft_dirty(mark_dirty)

    def show_chapter_before_textbox(self, text: str):
        self.chapter_before_result.configure(state="normal")
        self.chapter_before_result.delete("0.0", "end")
        self.chapter_before_result.insert("0.0", text)
        self.chapter_before_result.see("0.0")
        self.chapter_before_result.configure(state="disabled")
        self.chapter_before_label.configure(
            text=f"修改前正文（只读）  字数：{get_word_count(text)}"
        )

    def clear_chapter_before_textbox(self):
        self.show_chapter_before_textbox("")
    
    def test_llm_config(self):
        """
        测试当前的LLM配置是否可用
        """
        interface_format = self.interface_format_var.get().strip()
        api_key = self.api_key_var.get().strip()
        base_url = self.base_url_var.get().strip()
        model_name = self.model_name_var.get().strip()
        temperature = self.temperature_var.get()
        max_tokens = self.max_tokens_var.get()
        timeout = self.timeout_var.get()

        self.start_background_operation(
            "test_llm_config",
            lambda: test_llm_config(
                interface_format=interface_format,
                api_key=api_key,
                base_url=base_url,
                model_name=model_name,
                temperature=temperature,
                max_tokens=max_tokens,
                timeout=timeout,
                log_func=self.safe_log,
                handle_exception_func=self.handle_exception,
            ),
        )

    def test_embedding_config(self):
        """
        测试当前的Embedding配置是否可用
        """
        api_key = self.embedding_api_key_var.get().strip()
        base_url = self.embedding_url_var.get().strip()
        interface_format = self.embedding_interface_format_var.get().strip()
        model_name = self.embedding_model_name_var.get().strip()

        self.start_background_operation(
            "test_embedding_config",
            lambda: test_embedding_config(
                api_key=api_key,
                base_url=base_url,
                interface_format=interface_format,
                model_name=model_name,
                log_func=self.safe_log,
                handle_exception_func=self.handle_exception,
            ),
        )
    
    def browse_folder(self):
        selected_dir = filedialog.askdirectory()
        if selected_dir:
            self.filepath_var.set(selected_dir)
            self.persist_project_settings()

    def persist_project_settings(self):
        """Persist project inputs without replacing model settings."""
        try:
            config = load_config(self.config_file)
            other = dict(config.get("other_params", {}))
            fields = {
                "filepath": self.filepath_var.get().strip(),
                "genre": self.genre_var.get().strip(),
                "num_chapters": self.safe_get_int(self.num_chapters_var, 10),
                "word_number": self.safe_get_int(self.word_number_var, 3000),
                "chapter_num": self.chapter_num_var.get().strip(),
                "characters_involved": self.characters_involved_var.get().strip(),
                "key_items": self.key_items_var.get().strip(),
                "scene_location": self.scene_location_var.get().strip(),
                "time_constraint": self.time_constraint_var.get().strip(),
            }
            if hasattr(self, "topic_text"):
                fields["topic"] = self.topic_text.get("0.0", "end").strip()
            if hasattr(self, "planning_guide_text"):
                fields["planning_guidance"] = self.planning_guide_text.get("0.0", "end").strip()
            if hasattr(self, "user_guide_text"):
                fields["chapter_guidance"] = self.user_guide_text.get("0.0", "end").strip()
            other.update(fields)
            config["other_params"] = other
            if save_config(config, self.config_file):
                self.loaded_config = config
                return True
        except (OSError, tk.TclError, ValueError) as exc:
            logging.warning("保存工程设置失败: %s", exc)
        return False

    def _schedule_persist_project_settings(self):
        if self._project_persist_after_id is not None:
            try:
                self.master.after_cancel(self._project_persist_after_id)
            except tk.TclError:
                pass
        self._project_persist_after_id = self.master.after(600, self._run_scheduled_project_persist)

    def _run_scheduled_project_persist(self):
        self._project_persist_after_id = None
        if not self._closing:
            self.persist_project_settings()

    def _set_chapter_draft_dirty(self, dirty: bool):
        self._chapter_draft_dirty = bool(dirty)
        label = getattr(self, "chapter_label", None)
        if label is not None:
            try:
                current_text = self.chapter_result.get("0.0", "end-1c")
            except (AttributeError, tk.TclError):
                current_text = ""
            count = get_word_count(current_text) if isinstance(current_text, str) else 0
            marker = " · 未保存" if dirty else " · 已保存"
            label.configure(text=f"修改后正文（可编辑）  字数：{count}{marker}")

    def save_current_draft(self):
        filepath = self.filepath_var.get().strip()
        if not filepath:
            messagebox.showwarning("无法保存", "请先设置工程目录。")
            return False
        content = self.chapter_result.get("0.0", "end").strip()
        if not content:
            messagebox.showwarning("无法保存", "当前草稿为空。")
            return False
        try:
            chapter_number = self.safe_get_int(self.chapter_num_var, 1)
            NovelProjectRepository(filepath).write_chapter(chapter_number, content)
            self._chapter_draft_baseline = content
            self._set_chapter_draft_dirty(False)
            self.persist_project_settings()
            self.safe_log(f"第 {chapter_number} 章草稿已保存。")
            return True
        except (OSError, ValueError) as exc:
            messagebox.showerror("保存失败", str(exc))
            return False

    def _confirm_unsaved_content(self):
        if not self._chapter_draft_dirty:
            return True
        choice = messagebox.askyesnocancel("草稿尚未保存", "当前章节草稿有未保存修改，是否先保存？")
        if choice is None:
            return False
        return not choice or self.save_current_draft()

    def validate_generation_config(self, task_key: str, require_embedding: bool = False):
        filepath = self.filepath_var.get().strip()
        if not filepath:
            return "请先设置工程目录。"
        if not os.path.isdir(filepath):
            return f"工程目录不存在：{filepath}。请先选择有效目录。"
        config_var = getattr(self, f"{task_key}_llm_var", None)
        if config_var is None:
            return f"未找到任务“{task_key}”对应的模型配置。"
        selected = config_var.get().strip()
        try:
            from config_manager import get_llm_config
            config = get_llm_config(self.loaded_config, selected)
        except (ValueError, TypeError) as exc:
            return str(exc)
        if not self._service_config_ready(config):
            return f"模型配置“{selected}”未完成，请填写 API Key、Base URL 和模型名称并保存。"
        if self.safe_get_int(self.num_chapters_var, 0) < 1:
            return "总章节数必须大于 0。"
        if self.safe_get_int(self.word_number_var, 0) < 1:
            return "目标字数必须大于 0。"
        if require_embedding:
            emb_format = self.embedding_interface_format_var.get().strip().lower()
            if not self.embedding_url_var.get().strip() or not self.embedding_model_name_var.get().strip():
                return "Embedding 配置不完整，请填写服务地址和模型名称。"
            if emb_format not in {"ollama", "ml studio"} and not self.embedding_api_key_var.get().strip():
                return "当前 Embedding 服务需要 API Key。"
        return None

    def show_character_import_window(self):
        """显示角色导入窗口"""
        import_window = ctk.CTkToplevel(self.master)
        import_window.title("导入角色信息")
        import_window.geometry("600x500")
        import_window.transient(self.master)  # 设置为父窗口的临时窗口
        import_window.grab_set()  # 保持窗口在顶层
        
        # 主容器
        main_frame = ctk.CTkFrame(import_window)
        main_frame.pack(fill="both", expand=True, padx=10, pady=10)
        
        # 滚动容器
        scroll_frame = ctk.CTkScrollableFrame(main_frame)
        scroll_frame.pack(fill="both", expand=True, padx=5, pady=5)
        
        # 获取角色库路径
        role_lib_path = os.path.join(self.filepath_var.get().strip(), "角色库")
        self.selected_roles = []  # 存储选中的角色名称
        
        # 动态加载角色分类
        if os.path.exists(role_lib_path):
            # 配置网格布局参数
            scroll_frame.columnconfigure(0, weight=1)
            max_roles_per_row = 4
            current_row = 0
            
            for category in os.listdir(role_lib_path):
                category_path = os.path.join(role_lib_path, category)
                if os.path.isdir(category_path):
                    # 创建分类容器
                    category_frame = ctk.CTkFrame(scroll_frame)
                    category_frame.grid(row=current_row, column=0, sticky="w", pady=(10,5), padx=5)
                    
                    # 添加分类标签
                    category_label = ctk.CTkLabel(category_frame, text=f"【{category}】", 
                                                font=("Microsoft YaHei", 12, "bold"))
                    category_label.grid(row=0, column=0, padx=(0,10), sticky="w")
                    
                    # 初始化角色排列参数
                    role_count = 0
                    row_num = 0
                    col_num = 1  # 从第1列开始（第0列是分类标签）
                    
                    # 添加角色复选框
                    for role_file in os.listdir(category_path):
                        if role_file.endswith(".txt"):
                            role_name = os.path.splitext(role_file)[0]
                            if not any(name == role_name for _, name in self.selected_roles):
                                chk = ctk.CTkCheckBox(category_frame, text=role_name)
                                chk.grid(row=row_num, column=col_num, padx=5, pady=2, sticky="w")
                                self.selected_roles.append((chk, role_name))
                                
                                # 更新行列位置
                                role_count += 1
                                col_num += 1
                                if col_num > max_roles_per_row:
                                    col_num = 1
                                    row_num += 1
                    
                    # 如果没有角色，调整分类标签占满整行
                    if role_count == 0:
                        category_label.grid(columnspan=max_roles_per_row+1, sticky="w")
                    
                    # 更新主布局的行号
                    current_row += 1
                    
                    # 添加分隔线
                    separator = ctk.CTkFrame(scroll_frame, height=1, fg_color="gray")
                    separator.grid(row=current_row, column=0, sticky="ew", pady=5)
                    current_row += 1
        
        # 底部按钮框架
        btn_frame = ctk.CTkFrame(main_frame)
        btn_frame.pack(fill="x", pady=10)
        
        # 选择按钮
        def confirm_selection():
            selected = [name for chk, name in self.selected_roles if chk.get() == 1]
            self.char_inv_text.delete("0.0", "end")
            selected_text = ", ".join(selected)
            self.char_inv_text.insert("0.0", selected_text)
            self.characters_involved_var.set(selected_text)
            import_window.destroy()
            
        btn_confirm = ctk.CTkButton(btn_frame, text="选择", command=confirm_selection)
        btn_confirm.pack(side="left", padx=20)
        
        # 取消按钮
        btn_cancel = ctk.CTkButton(btn_frame, text="取消", command=import_window.destroy)
        btn_cancel.pack(side="right", padx=20)

    def show_role_library(self):
        save_path = self.filepath_var.get().strip()
        if not save_path:
            messagebox.showwarning("警告", "请先设置保存路径")
            return
        
        # 初始化LLM适配器
        llm_adapter = create_llm_adapter(
            interface_format=self.interface_format_var.get(),
            base_url=self.base_url_var.get(),
            model_name=self.model_name_var.get(),
            api_key=self.api_key_var.get(),
            temperature=self.temperature_var.get(),
            max_tokens=self.max_tokens_var.get(),
            timeout=self.timeout_var.get()
        )
        
        # 传递LLM适配器实例到角色库
        if hasattr(self, '_role_lib'):
            if self._role_lib.window and self._role_lib.window.winfo_exists():
                self._role_lib.window.destroy()
        
        self._role_lib = RoleLibrary(
            self.master,
            save_path,
            llm_adapter,
            start_ai_operation=self.start_background_operation,
            cancel_ai_operation=self.cancel_active_operation,
        )

    # ----------------- 将导入的各模块函数直接赋给类方法 -----------------
    generate_chapter_blueprint_ui = generate_chapter_blueprint_ui
    revise_architecture_section_ui = revise_architecture_section_ui
    revise_chapter_blueprint_ui = revise_chapter_blueprint_ui
    generate_chapter_draft_ui = generate_chapter_draft_ui
    revise_chapter_draft_ui = revise_chapter_draft_ui
    finalize_chapter_ui = finalize_chapter_ui
    do_consistency_check = do_consistency_check
    generate_batch_ui = generate_batch_ui
    import_knowledge_handler = import_knowledge_handler
    import_knowledge_files = import_knowledge_files
    import_knowledge_folder = import_knowledge_folder
    clear_vectorstore_handler = clear_vectorstore_handler
    show_plot_arcs_ui = show_plot_arcs_ui
    load_config_btn = load_config_btn
    save_config_btn = save_config_btn
    save_embedding_config = save_embedding_config
    load_novel_architecture = load_novel_architecture
    save_novel_architecture = save_novel_architecture
    update_architecture_workflow_state = update_architecture_workflow_state
    update_architecture_input_visibility = update_architecture_input_visibility
    toggle_architecture_input_panel = toggle_architecture_input_panel
    load_outline_workflow_step = load_outline_workflow_step
    load_outline_workflow_project = load_outline_workflow_project
    confirm_outline_step = confirm_outline_step
    extract_outline_step_from_file = extract_outline_step_from_file
    derive_outline_step_with_ai = derive_outline_step_with_ai
    finalize_outline_workflow = finalize_outline_workflow
    clear_novel_architecture = clear_novel_architecture
    delete_architecture_section = delete_selected_architecture_section
    on_architecture_editor_tab_changed = on_architecture_editor_tab_changed
    refresh_architecture_sections = refresh_architecture_sections
    on_architecture_section_selected = on_architecture_section_selected
    get_selected_architecture_section = get_selected_architecture_section
    is_architecture_overview_selected = is_architecture_overview_selected
    save_architecture_section = save_architecture_section
    sync_architecture_section = sync_architecture_section
    apply_extracted_architecture_content = apply_extracted_architecture_content
    architecture_section_has_unsaved_changes = architecture_section_has_unsaved_changes
    architecture_section_unsaved_reasons = architecture_section_unsaved_reasons
    _architecture_active_title = _architecture_active_title
    _architecture_item_key = _architecture_item_key
    _display_architecture_section = _display_architecture_section
    _save_active_architecture_section = _save_active_architecture_section
    _set_architecture_active_baseline = _set_architecture_active_baseline
    _set_architecture_tree_selection = _set_architecture_tree_selection
    add_architecture_subsection = add_architecture_subsection
    load_chapter_blueprint = load_chapter_blueprint
    save_chapter_blueprint = save_chapter_blueprint
    clear_chapter_blueprint = clear_chapter_blueprint
    load_character_state = load_character_state
    save_character_state = save_character_state
    load_global_summary = load_global_summary
    save_global_summary = save_global_summary
    refresh_chapters_list = refresh_chapters_list
    on_chapter_selected = on_chapter_selected
    save_current_chapter = save_current_chapter
    prev_chapter = prev_chapter
    next_chapter = next_chapter
    build_chapter_navigation = build_chapter_navigation
    show_finalize_result = show_finalize_result
    test_llm_config = test_llm_config
    test_embedding_config = test_embedding_config
    browse_folder = browse_folder
