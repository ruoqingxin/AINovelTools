import json
import os
from tkinter import filedialog, messagebox, ttk

import customtkinter as ctk

from ai_cancellation import raise_if_cancelled
from config_manager import get_llm_config
from llm_adapters import create_llm_adapter
from novel_generator import delete_knowledge_sources, list_knowledge_sources
from novel_generator.common import invoke_with_cleaning


FONT = ("Microsoft YaHei", 12)
TITLE_FONT = ("Microsoft YaHei", 15, "bold")
MAX_EXTRACTION_CHARS = 120_000


def parse_extracted_planning(response: str) -> dict:
    """Parse the model's structured planning suggestions."""
    data = json.loads(response.strip())
    if not isinstance(data, dict):
        raise ValueError("AI 返回的提炼结果不是 JSON 对象")
    result = {
        "topic": str(data.get("topic", "")).strip(),
        "genre": str(data.get("genre", "")).strip(),
        "planning_guidance": str(data.get("planning_guidance", "")).strip(),
    }
    try:
        result["num_chapters"] = max(1, int(data.get("num_chapters", 0)))
    except (TypeError, ValueError):
        result["num_chapters"] = 0
    if not result["topic"] or not result["planning_guidance"]:
        raise ValueError("AI 返回结果缺少故事主题或全书规划要求")
    return result


class KnowledgeManager:
    def __init__(self, app):
        self.app = app
        self.sources = ()
        self.window = ctk.CTkToplevel(app.master)
        self.window.title("资料库管理与创作提炼")
        self.window.geometry("1100x760")
        self.window.minsize(900, 650)
        self.window.transient(app.master)
        self.window.protocol("WM_DELETE_WINDOW", self.window.destroy)
        self._build_ui()
        self.refresh_sources()

    def _build_ui(self):
        self.window.grid_rowconfigure(1, weight=3)
        self.window.grid_rowconfigure(3, weight=2)
        self.window.grid_columnconfigure(0, weight=1)

        header = ctk.CTkFrame(self.window, fg_color="transparent")
        header.grid(row=0, column=0, sticky="ew", padx=10, pady=(10, 4))
        header.columnconfigure(0, weight=1)
        ctk.CTkLabel(header, text="当前已导入资料", font=TITLE_FONT).grid(
            row=0, column=0, sticky="w"
        )
        ctk.CTkButton(header, text="添加文件", width=90, command=self.add_files).grid(
            row=0, column=1, padx=3
        )
        ctk.CTkButton(header, text="添加文件夹", width=100, command=self.add_folder).grid(
            row=0, column=2, padx=3
        )
        ctk.CTkButton(header, text="删除选中", width=90, command=self.delete_selected).grid(
            row=0, column=3, padx=3
        )
        ctk.CTkButton(header, text="刷新", width=70, command=self.refresh_sources).grid(
            row=0, column=4, padx=(3, 0)
        )

        source_area = ctk.CTkFrame(self.window)
        source_area.grid(row=1, column=0, sticky="nsew", padx=10, pady=4)
        source_area.grid_rowconfigure(0, weight=1)
        source_area.grid_columnconfigure(0, weight=2)
        source_area.grid_columnconfigure(1, weight=3)

        self.source_tree = ttk.Treeview(
            source_area,
            columns=("name", "chunks", "characters"),
            show="headings",
            selectmode="extended",
        )
        self.source_tree.heading("name", text="资料名称")
        self.source_tree.heading("chunks", text="分段")
        self.source_tree.heading("characters", text="字符数")
        self.source_tree.column("name", width=300, anchor="w")
        self.source_tree.column("chunks", width=60, anchor="center")
        self.source_tree.column("characters", width=90, anchor="e")
        self.source_tree.grid(row=0, column=0, sticky="nsew", padx=(5, 3), pady=5)
        self.source_tree.bind("<<TreeviewSelect>>", self._show_selected_content)

        self.preview_text = ctk.CTkTextbox(source_area, wrap="word", font=FONT)
        self.preview_text.grid(row=0, column=1, sticky="nsew", padx=(3, 5), pady=5)
        self.preview_text.configure(state="disabled")

        extract_header = ctk.CTkFrame(self.window, fg_color="transparent")
        extract_header.grid(row=2, column=0, sticky="ew", padx=10, pady=(8, 4))
        extract_header.columnconfigure(0, weight=1)
        ctk.CTkLabel(extract_header, text="从资料提炼全书规划", font=TITLE_FONT).grid(
            row=0, column=0, sticky="w"
        )
        self.extract_button = ctk.CTkButton(
            extract_header,
            text="提炼选中资料",
            width=110,
            command=lambda: self.extract_planning(selected_only=True),
        )
        self.extract_button.grid(row=0, column=1, padx=3)
        self.extract_all_button = ctk.CTkButton(
            extract_header,
            text="提炼全部资料",
            width=110,
            command=lambda: self.extract_planning(selected_only=False),
        )
        self.extract_all_button.grid(row=0, column=2, padx=3)
        ctk.CTkButton(
            extract_header,
            text="中止 AI",
            width=80,
            command=self.app.cancel_active_operation,
            fg_color=("#b42318", "#8f1d16"),
            hover_color=("#912018", "#731712"),
        ).grid(row=0, column=3, padx=(3, 0))

        result = ctk.CTkFrame(self.window)
        result.grid(row=3, column=0, sticky="nsew", padx=10, pady=(4, 10))
        result.grid_columnconfigure(1, weight=1)
        result.grid_rowconfigure(3, weight=1)
        ctk.CTkLabel(result, text="故事主题", font=FONT).grid(
            row=0, column=0, sticky="nw", padx=8, pady=6
        )
        self.topic_result = ctk.CTkTextbox(result, height=70, wrap="word", font=FONT)
        self.topic_result.grid(row=0, column=1, columnspan=3, sticky="ew", padx=8, pady=6)
        ctk.CTkLabel(result, text="类型", font=FONT).grid(
            row=1, column=0, sticky="w", padx=8, pady=4
        )
        self.genre_result = ctk.CTkEntry(result, font=FONT)
        self.genre_result.grid(row=1, column=1, sticky="ew", padx=8, pady=4)
        ctk.CTkLabel(result, text="建议章节数", font=FONT).grid(
            row=1, column=2, sticky="e", padx=8, pady=4
        )
        self.chapter_result = ctk.CTkEntry(result, width=90, font=FONT)
        self.chapter_result.grid(row=1, column=3, sticky="e", padx=8, pady=4)
        ctk.CTkLabel(result, text="全书规划要求", font=FONT).grid(
            row=2, column=0, sticky="nw", padx=8, pady=6
        )
        self.guidance_result = ctk.CTkTextbox(result, wrap="word", font=FONT)
        self.guidance_result.grid(
            row=2, column=1, columnspan=3, rowspan=2, sticky="nsew", padx=8, pady=6
        )
        ctk.CTkButton(
            result,
            text="应用到全书规划",
            command=self.apply_to_planning,
            height=34,
            font=FONT,
        ).grid(row=4, column=0, columnspan=4, sticky="ew", padx=8, pady=8)

    def refresh_sources(self):
        try:
            self.sources = list_knowledge_sources(self.app.filepath_var.get().strip())
        except Exception as exc:
            messagebox.showerror("读取失败", f"无法读取已导入资料：{exc}", parent=self.window)
            return
        self.source_tree.delete(*self.source_tree.get_children())
        for index, source in enumerate(self.sources):
            self.source_tree.insert(
                "",
                "end",
                iid=str(index),
                values=(
                    source["source_name"],
                    source["chunk_count"],
                    source["character_count"],
                ),
            )
        self.window.title(f"资料库管理与创作提炼 - 已导入 {len(self.sources)} 项")
        self._show_selected_content()

    def _selected_sources(self):
        return tuple(self.sources[int(item)] for item in self.source_tree.selection())

    def _show_selected_content(self, _event=None):
        selected = self._selected_sources()
        content = "\n\n".join(
            f"===== {source['source_name']} =====\n{source['content']}"
            for source in selected
        )
        self.preview_text.configure(state="normal")
        self.preview_text.delete("0.0", "end")
        self.preview_text.insert("0.0", content)
        self.preview_text.configure(state="disabled")

    def add_files(self):
        files = filedialog.askopenfilenames(
            parent=self.window,
            title="选择一个或多个资料文件",
            filetypes=[("资料文件", "*.txt *.md"), ("所有文件", "*.*")],
        )
        if files:
            self.app.import_knowledge_files(files, on_complete=self.refresh_sources)

    def add_folder(self):
        folder = filedialog.askdirectory(parent=self.window, title="选择资料文件夹")
        if folder:
            self.app.import_knowledge_folder(folder, on_complete=self.refresh_sources)

    def delete_selected(self):
        selected = self._selected_sources()
        if not selected:
            messagebox.showinfo("删除资料", "请先选择要删除的资料。", parent=self.window)
            return
        names = "、".join(source["source_name"] for source in selected)
        if not messagebox.askyesno(
            "确认删除", f"确定从资料库删除以下 {len(selected)} 项吗？\n\n{names}", parent=self.window
        ):
            return
        try:
            deleted = delete_knowledge_sources(
                self.app.filepath_var.get().strip(),
                [source["source_id"] for source in selected],
            )
            self.app.log(f"已从资料库删除 {deleted} 项资料。")
            self.refresh_sources()
        except Exception as exc:
            messagebox.showerror("删除失败", str(exc), parent=self.window)

    def extract_planning(self, selected_only: bool):
        sources = self._selected_sources() if selected_only else self.sources
        if not sources:
            messagebox.showinfo("资料提炼", "没有可提炼的资料。", parent=self.window)
            return
        combined = "\n\n".join(
            f"===== 资料：{source['source_name']} =====\n{source['content']}"
            for source in sources
        )
        if len(combined) > MAX_EXTRACTION_CHARS:
            combined = combined[:MAX_EXTRACTION_CHARS]
            self.app.log(f"资料总长度超过 {MAX_EXTRACTION_CHARS} 字，本次提炼使用前 {MAX_EXTRACTION_CHARS} 字。")

        llm_config = get_llm_config(
            self.app.loaded_config, self.app.architecture_llm_var.get()
        )
        current_chapters = self.app.safe_get_int(self.app.num_chapters_var, 10)
        prompt = f"""你是一名专业小说策划编辑。请阅读以下资料，提炼一份可直接用于长篇小说规划的创作输入。

要求：
1. 故事主题要概括核心主线、主要矛盾和主角目标，可写一至三段。
2. 类型使用简洁的中文类型名称。
3. 建议合理的章节数；若资料没有明确篇幅，以当前章节数 {current_chapters} 为基准。
4. 全书规划要求需明确世界观约束、人物关系、情节走向、必须保留的事实、写作风格和禁忌，使用可执行的条目。
5. 只输出合法 JSON，不要 Markdown，不要解释。

JSON 格式：
{{"topic":"...","genre":"...","num_chapters":100,"planning_guidance":"..."}}

待提炼资料：
{combined}
"""

        def task():
            try:
                adapter = create_llm_adapter(
                    interface_format=llm_config["interface_format"],
                    api_key=llm_config.get("api_key", ""),
                    base_url=llm_config["base_url"],
                    model_name=llm_config["model_name"],
                    temperature=llm_config["temperature"],
                    max_tokens=llm_config["max_tokens"],
                    timeout=llm_config["timeout"],
                )
                response = invoke_with_cleaning(adapter, prompt)
                raise_if_cancelled()
                extracted = parse_extracted_planning(response)
                self.app.call_in_ui(lambda: self._show_extracted(extracted))
                self.app.safe_log("资料提炼完成，可检查修改后应用到全书规划。")
            except Exception as exc:
                self.app.handle_exception("从资料提炼全书规划时出错")
                self.app.call_in_ui(
                    lambda error=str(exc): messagebox.showerror(
                        "提炼失败", error, parent=self.window
                    )
                )

        active_button = self.extract_button if selected_only else self.extract_all_button
        self.app.start_background_operation(
            "extract_knowledge", task, active_button
        )

    def _show_extracted(self, extracted: dict):
        self.topic_result.delete("0.0", "end")
        self.topic_result.insert("0.0", extracted["topic"])
        self.genre_result.delete(0, "end")
        self.genre_result.insert(0, extracted["genre"])
        self.chapter_result.delete(0, "end")
        if extracted["num_chapters"]:
            self.chapter_result.insert(0, str(extracted["num_chapters"]))
        self.guidance_result.delete("0.0", "end")
        self.guidance_result.insert("0.0", extracted["planning_guidance"])

    def apply_to_planning(self):
        topic = self.topic_result.get("0.0", "end").strip()
        guidance = self.guidance_result.get("0.0", "end").strip()
        if not topic or not guidance:
            messagebox.showwarning(
                "无法应用", "故事主题和全书规划要求不能为空。", parent=self.window
            )
            return
        self.app.topic_text.delete("0.0", "end")
        self.app.topic_text.insert("0.0", topic)
        genre = self.genre_result.get().strip()
        if genre:
            self.app.genre_var.set(genre)
        chapters = self.chapter_result.get().strip()
        if chapters.isdigit() and int(chapters) > 0:
            self.app.num_chapters_var.set(chapters)
        self.app.planning_guide_text.delete("0.0", "end")
        self.app.planning_guide_text.insert("0.0", guidance)
        self.app.tabview.set("小说架构")
        self.app.log("已将资料提炼结果应用到全书规划。")
        messagebox.showinfo("应用完成", "已回填故事主题、类型、章节数和全书规划要求。", parent=self.window)
