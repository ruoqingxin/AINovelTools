#novel_generator/knowledge.py
# -*- coding: utf-8 -*-
"""
知识文件导入至向量库（advanced_split_content、import_knowledge_file）
"""
import os
import hashlib
import logging
import traceback
import warnings
from pathlib import Path
from typing import Optional
from novel_generator.vectorstore_utils import (
    init_vector_store,
    load_vector_store,
    replace_source_documents,
)
from novel_generator.text_utils import split_sentences

# 禁用特定的Torch警告
warnings.filterwarnings('ignore', message='.*Torch was not compiled with flash attention.*')
os.environ["TOKENIZERS_PARALLELISM"] = "false"
logging.basicConfig(
    filename='app.log',      # 日志文件名
    filemode='a',            # 追加模式（'w' 会覆盖）
    level=logging.INFO,      # 记录 INFO 及以上级别的日志
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)


def read_knowledge_file(file_path: str) -> str:
    """读取 TXT/Markdown 知识文件，并兼容常见中文编码。"""
    for encoding in ("utf-8-sig", "utf-8", "gb18030", "gbk"):
        try:
            with open(file_path, "r", encoding=encoding) as file:
                return file.read()
        except UnicodeDecodeError:
            continue
        except (OSError, LookupError) as exc:
            logging.warning("读取知识库文件失败 %s: %s", file_path, exc)
            return ""
    logging.warning("无法识别知识库文件编码: %s", file_path)
    return ""


def collect_knowledge_files(folder_path: str) -> tuple[str, ...]:
    """递归收集文件夹中的 TXT 和 Markdown 文件。"""
    folder = Path(folder_path)
    if not folder.is_dir():
        return ()
    return tuple(
        str(path)
        for path in sorted(folder.rglob("*"), key=lambda item: str(item).lower())
        if path.is_file() and path.suffix.lower() in {".txt", ".md"}
    )


def advanced_split_content(content: str, similarity_threshold: float = 0.7, max_length: int = 500) -> list:
    """使用基本分段策略"""
    sentences = split_sentences(content)
    if not sentences:
        return []

    final_segments = []
    current_segment = []
    current_length = 0
    
    for sentence in sentences:
        sentence_length = len(sentence)
        if current_length + sentence_length > max_length:
            if current_segment:
                final_segments.append(" ".join(current_segment))
            current_segment = [sentence]
            current_length = sentence_length
        else:
            current_segment.append(sentence)
            current_length += sentence_length
    
    if current_segment:
        final_segments.append(" ".join(current_segment))
    
    return final_segments

def import_knowledge_file(
    embedding_api_key: str,
    embedding_url: str,
    embedding_interface_format: str,
    embedding_model_name: str,
    file_path: str,
    filepath: str,
    source_name: Optional[str] = None,
    embedding_adapter=None,
) -> bool:
    logging.info(f"开始导入知识库文件: {file_path}, 接口格式: {embedding_interface_format}, 模型: {embedding_model_name}")
    if not os.path.exists(file_path):
        logging.warning(f"知识库文件不存在: {file_path}")
        return False
    content = read_knowledge_file(file_path)
    if not content.strip():
        logging.warning("知识库文件内容为空。")
        return False
    paragraphs = advanced_split_content(content)
    if not paragraphs:
        logging.warning("知识库文件无法切分出有效内容。")
        return False
    source_name = source_name or os.path.abspath(file_path)
    source_id = "knowledge:" + hashlib.sha256(source_name.encode("utf-8")).hexdigest()[:20]
    metadatas = [
        {
            "source_type": "knowledge",
            "source_id": source_id,
            "source_name": os.path.basename(source_name),
            "chunk_index": index,
        }
        for index in range(len(paragraphs))
    ]
    ids = [
        f"{source_id}:{index}:{hashlib.sha256(text.encode('utf-8')).hexdigest()[:16]}"
        for index, text in enumerate(paragraphs)
    ]
    if embedding_adapter is None:
        from embedding_adapters import create_embedding_adapter
        embedding_adapter = create_embedding_adapter(
            embedding_interface_format,
            embedding_api_key,
            embedding_url if embedding_url else "http://localhost:11434/api",
            embedding_model_name
        )
    store = load_vector_store(embedding_adapter, filepath)
    if not store:
        logging.info("Vector store does not exist or load failed. Initializing a new one for knowledge import...")
        store = init_vector_store(
            embedding_adapter,
            paragraphs,
            filepath,
            metadatas=metadatas,
            ids=ids,
        )
        if store:
            logging.info("知识库文件已成功导入至向量库(新初始化)。")
            return True
        else:
            logging.warning("知识库导入失败，跳过。")
            return False
    else:
        try:
            from langchain_core.documents import Document

            docs = [
                Document(page_content=str(text), metadata=metadata)
                for text, metadata in zip(paragraphs, metadatas)
            ]
            replace_source_documents(store, docs, ids, source_id)
            logging.info("知识库文件已成功导入至向量库(追加模式)。")
            return True
        except Exception as e:
            logging.warning(f"知识库导入失败: {e}")
            traceback.print_exc()
            return False
