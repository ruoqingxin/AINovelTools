# ui/main_window.py
# -*- coding: utf-8 -*-
import os
import threading
import logging
import traceback
import customtkinter as ctk
from tkinter import filedialog, messagebox

from config_manager import load_config, test_llm_config, test_embedding_config
from utils import read_file
from tooltips import tooltips

from ui.library_dialogs import show_role_library, show_skill_selector
from ui.main_tab import build_main_tab
from ui.config_tab import build_config_tabview, load_config_btn, save_config_btn
from ui.novel_params_tab import build_novel_params_area, build_optional_buttons_area
from ui.generation_handlers import (
    generate_novel_architecture_ui,
    generate_chapter_blueprint_ui,
    generate_chapter_draft_ui,
    finalize_chapter_ui,
    do_consistency_check,
    import_knowledge_handler,
    clear_vectorstore_handler,
    show_plot_arcs_ui,
    generate_batch_ui
)
from ui.setting_tab import (
    build_setting_tab,
    confirm_novel_architecture,
    load_novel_architecture,
    save_novel_architecture,
)
from ui.directory_tab import build_directory_tab, load_chapter_blueprint, save_chapter_blueprint
from ui.character_tab import build_character_tab, load_character_state, save_character_state
from ui.summary_tab import build_summary_tab, load_global_summary, save_global_summary
from ui.chapters_tab import build_chapters_tab, refresh_chapters_list, on_chapter_selected, save_current_chapter, is_chapter_dirty, prev_chapter, next_chapter
from ui.other_settings import build_other_settings_tab
from services.task_controller import TaskController, TaskAlreadyRunning
from services.model_config import get_task_llm_config as load_task_llm_config
from services.project_manager import ProjectManager, ProjectError
from services.chapter_service import ChapterService
from services.chapter_context import ChapterContextBuilder
from services.blueprint_service import BlueprintService
from services.outline_service import OutlineService
from services.skill_service import SkillService
from domain.chapter_state import ChapterContinuityError


class NovelGeneratorGUI:
    """
    小说生成器的主GUI类，包含所有的界面布局、事件处理、与后端逻辑的交互等。
    """
    def __init__(self, master):
        self.master = master
        self._prompt_cancel_event = threading.Event()
        self.task_controller = TaskController(self)
        self.master.title("Novel Generator GUI")
        try:
            if os.path.exists("icon.ico"):
                self.master.iconbitmap("icon.ico")
        except Exception:
            pass
        self.master.geometry("1350x840")

        # --------------- 配置文件路径 ---------------
        self.config_file = "config.json"
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

        webdav_config = self.loaded_config.get("webdav_config", {})
        self.webdav_url_var = ctk.StringVar(value=webdav_config.get("webdav_url", ""))
        self.webdav_username_var = ctk.StringVar(value=webdav_config.get("webdav_username", ""))
        self.webdav_password_var = ctk.StringVar(value=webdav_config.get("webdav_password", ""))

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
            self.user_guidance_default = op.get("user_guidance", "")
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
            self.user_guidance_default = ""

        legacy_params = self.loaded_config.get("other_params", {})
        self.project_manager = ProjectManager(
            self.loaded_config,
            self.config_file,
            self.task_controller,
        )
        initial_project = (
            self.loaded_config.get("current_project")
            or legacy_params.get("filepath", "")
        )
        if initial_project and os.path.isdir(initial_project):
            try:
                project = self.project_manager.open_project(initial_project, legacy_params)
                self.apply_project_settings(project)
            except ProjectError as exc:
                logging.error("无法恢复最近工程: %s", exc)

        # --------------- 整体Tab布局 ---------------
        self.tabview = ctk.CTkTabview(self.master)
        self.tabview.pack(fill="both", expand=True)

        # 创建各个标签页
        build_main_tab(self)
        build_config_tabview(self)
        build_novel_params_area(self, start_row=1)
        build_optional_buttons_area(self, start_row=2)
        build_setting_tab(self)
        build_directory_tab(self)
        build_character_tab(self)
        build_summary_tab(self)
        build_chapters_tab(self)
        build_other_settings_tab(self)
        if self.project_manager.current_path:
            self.refresh_project_views()
        self.master.protocol("WM_DELETE_WINDOW", self.on_app_close)

        # English Mode Button
        self.english_mode_btn = ctk.CTkButton(
            self.master, 
            text="to English mode", 
            width=100, 
            height=20,
            
            command=self.toggle_english_mode
        )
        self.english_mode_btn.place(relx=0.98, rely=0.015, anchor="ne")


    # ----------------- 通用辅助函数 -----------------
    def show_tooltip(self, key: str):
        info_text = tooltips.get(key, "暂无说明")
        messagebox.showinfo("参数说明", info_text)

    def safe_get_int(self, var, default=1):
        try:
            val_str = str(var.get()).strip()
            return int(val_str)
        except:
            var.set(str(default))
            return default

    def log(self, message: str):
        self.log_text.configure(state="normal")
        self.log_text.insert("end", message + "\n")
        self.log_text.see("end")
        self.log_text.configure(state="disabled")

    def safe_log(self, message: str):
        self.master.after(0, lambda: self.log(message))

    def disable_button_safe(self, btn):
        self.master.after(0, lambda: btn.configure(state="disabled"))

    def enable_button_safe(self, btn):
        self.master.after(0, lambda: btn.configure(state="normal"))

    def run_background_task(self, task_id, worker):
        """兼容现有无参数 worker，并把控制器取消令牌用于 Prompt 等待。"""
        def controlled_worker(cancel_event):
            self._prompt_cancel_event = cancel_event
            return worker()

        try:
            return self.task_controller.run(task_id, controlled_worker)
        except TaskAlreadyRunning:
            self.safe_log("已有后台任务正在运行，请等待当前任务结束。")
            return None

    def get_task_llm_config(self, task_key, selected_name=None):
        return load_task_llm_config(self.loaded_config, task_key, selected_name)

    def collect_project_settings(self):
        return {
            "version": 1,
            "name": os.path.basename(self.filepath_var.get().rstrip("/\\")),
            "topic": self.topic_text.get("0.0", "end-1c").strip(),
            "genre": self.genre_var.get().strip(),
            "num_chapters": self.safe_get_int(self.num_chapters_var, 10),
            "word_number": self.safe_get_int(self.word_number_var, 3000),
            "current_chapter": self.safe_get_int(self.chapter_num_var, 1),
            "chapter_guidance": self.user_guide_text.get("0.0", "end-1c").strip(),
            "characters_involved": self.char_inv_text.get("0.0", "end-1c").strip(),
            "key_items": self.key_items_var.get().strip(),
            "scene_location": self.scene_location_var.get().strip(),
            "time_constraint": self.time_constraint_var.get().strip(),
            "selected_skill_ids": list(getattr(self, "selected_skill_ids", [])),
        }

    def save_project_settings(self):
        if not self.project_manager.current_path:
            return False
        return self.project_manager.save_project(self.collect_project_settings())

    def apply_project_settings(self, project):
        if self.project_manager.repository:
            self.chapter_service = ChapterService(self.project_manager.repository)
            self.chapter_context_builder = ChapterContextBuilder(
                self.project_manager.repository,
                SkillService(self.loaded_config),
            )
            self.blueprint_service = BlueprintService(self.project_manager.repository)
            self.outline_service = OutlineService(self.project_manager.repository)
        self.topic_default = project.get("topic", "")
        self.user_guidance_default = project.get("chapter_guidance", "")
        self.genre_var.set(project.get("genre", "玄幻"))
        self.num_chapters_var.set(str(project.get("num_chapters", 10)))
        self.word_number_var.set(str(project.get("word_number", 3000)))
        self.filepath_var.set(self.project_manager.current_path)
        self.chapter_num_var.set(str(project.get("current_chapter", 1)))
        self.characters_involved_var.set(project.get("characters_involved", ""))
        self.key_items_var.set(project.get("key_items", ""))
        self.scene_location_var.set(project.get("scene_location", ""))
        self.time_constraint_var.set(project.get("time_constraint", ""))
        self.selected_skill_ids = list(project.get("selected_skill_ids", []))
        if hasattr(self, "topic_text"):
            self.topic_text.delete("0.0", "end")
            self.topic_text.insert("0.0", self.topic_default)
        if hasattr(self, "user_guide_text"):
            self.user_guide_text.delete("0.0", "end")
            self.user_guide_text.insert("0.0", self.user_guidance_default)
        if hasattr(self, "char_inv_text"):
            self.char_inv_text.delete("0.0", "end")
            self.char_inv_text.insert("0.0", project.get("characters_involved", ""))

    def refresh_project_views(self):
        self.load_novel_architecture()
        self.load_chapter_blueprint()
        self.load_character_state()
        self.load_global_summary()
        self.refresh_chapters_list()
        if not self.chapters_list:
            self.chapter_result.delete("0.0", "end")
            self.chapter_view_text.delete("0.0", "end")
            self._loaded_chapter_number = None
            self._chapter_saved_text = ""
        self.refresh_recent_projects()

    def validate_chapter_generation_target(self, chapter_number):
        if not hasattr(self, "chapter_service"):
            return True
        try:
            self.chapter_service.validate_target(chapter_number)
            return True
        except ChapterContinuityError as exc:
            messagebox.showwarning("章节连续性", str(exc))
            return False

    def build_chapter_context(self, chapter_number):
        if not hasattr(self, "chapter_context_builder"):
            raise RuntimeError("尚未打开小说工程")
        return self.chapter_context_builder.build(
            self.project_manager.project or {},
            chapter_number,
            {"character_names": self.char_inv_text.get("0.0", "end-1c").strip()},
        )

    def refresh_recent_projects(self):
        if not hasattr(self, "recent_project_menu"):
            return
        projects = self.loaded_config.get("recent_projects", [])
        self.recent_project_menu.configure(values=projects or [""])
        self.recent_project_var.set(self.project_manager.current_path or "")

    def switch_project(self, project_path):
        if self.is_chapter_dirty():
            choice = messagebox.askyesnocancel(
                "未保存正文",
                "当前章节有未保存修改。是否保存后切换工程？",
            )
            if choice is None:
                return False
            if choice and not self.save_current_chapter():
                return False
        if self.task_controller.is_running() and not messagebox.askyesno(
            "后台任务运行中",
            "切换工程需要取消当前后台任务，是否继续？",
        ):
            return False
        if self.project_manager.current_path:
            self.save_project_settings()
        if (hasattr(self, "_role_lib") and self._role_lib.window
                and self._role_lib.window.winfo_exists()):
            self._role_lib.window.destroy()
            del self._role_lib
        self.selected_roles = []
        legacy = self.loaded_config.get("other_params", {})
        try:
            project = self.project_manager.switch_project(project_path, legacy)
        except ProjectError as exc:
            messagebox.showerror("工程切换失败", str(exc))
            return False
        self.apply_project_settings(project)
        self.refresh_project_views()
        self.safe_log(f"已切换小说工程：{self.project_manager.current_path}")
        return True

    def on_app_close(self):
        if self.is_chapter_dirty():
            choice = messagebox.askyesnocancel("未保存正文", "关闭前是否保存当前章节？")
            if choice is None:
                return
            if choice and not self.save_current_chapter():
                return
        if self.task_controller.is_running():
            self.task_controller.cancel()
            if not self.task_controller.wait_for_idle(5):
                messagebox.showwarning("无法关闭", "后台任务尚未结束，请稍后重试。")
                return
        if self.project_manager.current_path:
            self.save_project_settings()
        self.master.destroy()

    def handle_exception(self, context: str):
        full_message = f"{context}\n{traceback.format_exc()}"
        logging.error(full_message)
        self.safe_log(f"{context}。详情已写入 app.log。")

    def show_chapter_in_textbox(self, text: str, chapter_number=None, saved=False):
        self.chapter_result.delete("0.0", "end")
        self.chapter_result.insert("0.0", text)
        self.chapter_result.see("end")
        if chapter_number is not None:
            if saved or self._loaded_chapter_number != chapter_number:
                chapter_file = os.path.join(
                    self.filepath_var.get().strip(),
                    "chapters",
                    f"chapter_{chapter_number}.txt",
                )
                self._chapter_saved_text = text if saved else read_file(chapter_file)
            self._loaded_chapter_number = chapter_number
    
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

        test_llm_config(
            interface_format=interface_format,
            api_key=api_key,
            base_url=base_url,
            model_name=model_name,
            temperature=temperature,
            max_tokens=max_tokens,
            timeout=timeout,
            log_func=self.safe_log,
            handle_exception_func=self.handle_exception,
            task_runner=self.run_background_task,
        )

    def test_embedding_config(self):
        """
        测试当前的Embedding配置是否可用
        """
        api_key = self.embedding_api_key_var.get().strip()
        base_url = self.embedding_url_var.get().strip()
        interface_format = self.embedding_interface_format_var.get().strip()
        model_name = self.embedding_model_name_var.get().strip()

        test_embedding_config(
            api_key=api_key,
            base_url=base_url,
            interface_format=interface_format,
            model_name=model_name,
            log_func=self.safe_log,
            handle_exception_func=self.handle_exception,
            task_runner=self.run_background_task,
        )
    
    def browse_folder(self):
        selected_dir = filedialog.askdirectory()
        if selected_dir:
            self.switch_project(selected_dir)

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
            self.char_inv_text.insert("0.0", ", ".join(selected))
            import_window.destroy()
            
        btn_confirm = ctk.CTkButton(btn_frame, text="选择", command=confirm_selection)
        btn_confirm.pack(side="left", padx=20)
        
        # 取消按钮
        btn_cancel = ctk.CTkButton(btn_frame, text="取消", command=import_window.destroy)
        btn_cancel.pack(side="right", padx=20)

    def show_role_library(self):
        return show_role_library(self)

    def show_skill_selector(self):
        return show_skill_selector(self)

    def toggle_english_mode(self):
        import config_manager
        import importlib
        import prompt_definitions
        
        config_manager.IS_ENGLISH = not config_manager.IS_ENGLISH
        
        try:
            if config_manager.IS_ENGLISH:
                self.english_mode_btn.configure(text="to Chinese mode")
                # Load English prompts and inject them into prompt_definitions module
                source_module = importlib.import_module('prompt_definitions_en')
                importlib.reload(source_module)
                for attr in dir(source_module):
                    if not attr.startswith('__'):
                        setattr(prompt_definitions, attr, getattr(source_module, attr))
            else:
                self.english_mode_btn.configure(text="to English mode")
                # Reload prompt_definitions to restore original Chinese strings from file
                importlib.reload(prompt_definitions)
            
            self.log(f"已切换到 {'英文' if config_manager.IS_ENGLISH else '中文'} 模式")
        except Exception as e:
            self.log(f"切换模式失败: {str(e)}")

    # ----------------- 将导入的各模块函数直接赋给类方法 -----------------
    generate_novel_architecture_ui = generate_novel_architecture_ui
    generate_chapter_blueprint_ui = generate_chapter_blueprint_ui
    generate_chapter_draft_ui = generate_chapter_draft_ui
    finalize_chapter_ui = finalize_chapter_ui
    do_consistency_check = do_consistency_check
    generate_batch_ui = generate_batch_ui
    import_knowledge_handler = import_knowledge_handler
    clear_vectorstore_handler = clear_vectorstore_handler
    show_plot_arcs_ui = show_plot_arcs_ui
    load_config_btn = load_config_btn
    save_config_btn = save_config_btn
    load_novel_architecture = load_novel_architecture
    save_novel_architecture = save_novel_architecture
    confirm_novel_architecture = confirm_novel_architecture
    load_chapter_blueprint = load_chapter_blueprint
    save_chapter_blueprint = save_chapter_blueprint
    load_character_state = load_character_state
    save_character_state = save_character_state
    load_global_summary = load_global_summary
    save_global_summary = save_global_summary
    refresh_chapters_list = refresh_chapters_list
    on_chapter_selected = on_chapter_selected
    save_current_chapter = save_current_chapter
    is_chapter_dirty = is_chapter_dirty
    prev_chapter = prev_chapter
    next_chapter = next_chapter
    test_llm_config = test_llm_config
    test_embedding_config = test_embedding_config
    browse_folder = browse_folder
