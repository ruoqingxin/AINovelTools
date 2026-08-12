#novel_generator/vectorstore_utils.py
# -*- coding: utf-8 -*-
"""
向量库相关操作（初始化、更新、检索、清空、文本切分等）
"""
import os
import hashlib
import logging
import traceback
import ssl
import warnings
from typing import Optional
# 禁用特定的Torch警告
warnings.filterwarnings('ignore', message='.*Torch was not compiled with flash attention.*')
os.environ["TOKENIZERS_PARALLELISM"] = "false"  # 禁用tokenizer并行警告

from .common import call_with_retry
from .text_utils import split_sentences


def open_vector_store(filepath: str):
    """Open the persisted collection without requiring an embedding service."""
    from chromadb.config import Settings
    from langchain_chroma import Chroma

    store_dir = get_vectorstore_dir(filepath)
    if not os.path.isdir(store_dir):
        return None
    return Chroma(
        persist_directory=store_dir,
        client_settings=Settings(anonymized_telemetry=False),
        collection_name="novel_collection",
    )


def list_knowledge_sources(filepath: str) -> tuple[dict, ...]:
    """List imported knowledge sources and reconstruct their readable content."""
    store = open_vector_store(filepath)
    if store is None:
        return ()
    result = store.get(
        where={"source_type": "knowledge"},
        include=["documents", "metadatas"],
    )
    grouped = {}
    for document, metadata in zip(
        result.get("documents", []), result.get("metadatas", [])
    ):
        metadata = metadata or {}
        source_id = metadata.get("source_id")
        if not source_id:
            continue
        source = grouped.setdefault(
            source_id,
            {
                "source_id": source_id,
                "source_name": metadata.get("source_name", "未知来源"),
                "chunks": [],
            },
        )
        source["chunks"].append(
            (int(metadata.get("chunk_index", 0)), str(document or ""))
        )

    sources = []
    for source in grouped.values():
        chunks = sorted(source.pop("chunks"), key=lambda item: item[0])
        content = "\n\n".join(text for _, text in chunks if text.strip())
        sources.append(
            {
                **source,
                "chunk_count": len(chunks),
                "character_count": len(content),
                "content": content,
            }
        )
    return tuple(sorted(sources, key=lambda item: item["source_name"].lower()))


def delete_knowledge_sources(filepath: str, source_ids) -> int:
    """Delete only the selected imported sources from the vector collection."""
    store = open_vector_store(filepath)
    if store is None:
        return 0
    deleted = 0
    for source_id in dict.fromkeys(source_ids):
        existing = store.get(where={"source_id": source_id}, include=[])
        ids = existing.get("ids", []) if existing else []
        if ids:
            store.delete(ids=ids)
            deleted += 1
    return deleted

def get_vectorstore_dir(filepath: str) -> str:
    """获取 vectorstore 路径"""
    return os.path.join(filepath, "vectorstore")

def clear_vector_store(filepath: str) -> bool:
    """清空 清空向量库"""
    import shutil
    store_dir = get_vectorstore_dir(filepath)
    if not os.path.exists(store_dir):
        logging.info("No vector store found to clear.")
        return False
    try:
        shutil.rmtree(store_dir)
        logging.info(f"Vector store directory '{store_dir}' removed.")
        return True
    except Exception as e:
        logging.error(f"无法删除向量库文件夹，请关闭程序后手动删除 {store_dir}。\n {str(e)}")
        traceback.print_exc()
        return False

def init_vector_store(embedding_adapter, texts, filepath: str, metadatas=None, ids=None):
    """
    在 filepath 下创建/加载一个 Chroma 向量库并插入 texts。
    如果Embedding失败，则返回 None，不中断任务。
    """
    from langchain.embeddings.base import Embeddings as LCEmbeddings
    from chromadb.config import Settings
    from langchain_chroma import Chroma
    from langchain_core.documents import Document

    store_dir = get_vectorstore_dir(filepath)
    os.makedirs(store_dir, exist_ok=True)
    metadatas = metadatas or [{} for _ in texts]
    documents = [
        Document(page_content=str(text), metadata=metadata)
        for text, metadata in zip(texts, metadatas)
    ]

    try:
        class LCEmbeddingWrapper(LCEmbeddings):
            def embed_documents(self, texts):
                return call_with_retry(
                    func=embedding_adapter.embed_documents,
                    max_retries=3,
                    fallback_return=[],
                    texts=texts
                )
            def embed_query(self, query: str):
                res = call_with_retry(
                    func=embedding_adapter.embed_query,
                    max_retries=3,
                    fallback_return=[],
                    query=query
                )
                return res

        chroma_embedding = LCEmbeddingWrapper()
        vectorstore = Chroma.from_documents(
            documents,
            embedding=chroma_embedding,
            persist_directory=store_dir,
            client_settings=Settings(anonymized_telemetry=False),
            collection_name="novel_collection",
            ids=ids,
        )
        return vectorstore
    except Exception as e:
        logging.warning(f"Init vector store failed: {e}")
        traceback.print_exc()
        return None

def load_vector_store(embedding_adapter, filepath: str):
    """
    读取已存在的 Chroma 向量库。若不存在则返回 None。
    如果加载失败（embedding 或IO问题），则返回 None。
    """
    from langchain.embeddings.base import Embeddings as LCEmbeddings
    from chromadb.config import Settings
    from langchain_chroma import Chroma
    store_dir = get_vectorstore_dir(filepath)
    if not os.path.exists(store_dir):
        logging.info("Vector store not found. Will return None.")
        return None

    try:
        class LCEmbeddingWrapper(LCEmbeddings):
            def embed_documents(self, texts):
                return call_with_retry(
                    func=embedding_adapter.embed_documents,
                    max_retries=3,
                    fallback_return=[],
                    texts=texts
                )
            def embed_query(self, query: str):
                return call_with_retry(
                    func=embedding_adapter.embed_query,
                    max_retries=3,
                    fallback_return=[],
                    query=query
                )

        chroma_embedding = LCEmbeddingWrapper()
        return Chroma(
            persist_directory=store_dir,
            embedding_function=chroma_embedding,
            client_settings=Settings(anonymized_telemetry=False),
            collection_name="novel_collection"
        )
    except Exception as e:
        logging.warning(f"Failed to load vector store: {e}")
        traceback.print_exc()
        return None


def replace_source_documents(store, documents, ids, source_id: str) -> bool:
    """替换同一来源的索引；写入失败时尽量恢复旧文档。"""
    existing = store.get(
        where={"source_id": source_id},
        include=["documents", "metadatas"],
    )
    old_ids = existing.get("ids", []) if existing else []
    old_texts = existing.get("documents", []) if existing else []
    old_metadatas = existing.get("metadatas", []) if existing else []

    try:
        if old_ids:
            store.delete(ids=old_ids)
        store.add_documents(documents, ids=ids)
        return True
    except Exception:
        try:
            from langchain_core.documents import Document

            store.delete(ids=ids)
            if old_ids:
                old_documents = [
                    Document(page_content=text, metadata=metadata or {})
                    for text, metadata in zip(old_texts, old_metadatas)
                ]
                store.add_documents(old_documents, ids=old_ids)
        except Exception as rollback_error:
            logging.error("Vector store rollback failed: %s", rollback_error)
        raise

def split_by_length(text: str, max_length: int = 500):
    """按照 max_length 切分文本"""
    segments = []
    start_idx = 0
    while start_idx < len(text):
        end_idx = min(start_idx + max_length, len(text))
        segment = text[start_idx:end_idx]
        segments.append(segment.strip())
        start_idx = end_idx
    return segments

def split_text_for_vectorstore(chapter_text: str, max_length: int = 500, similarity_threshold: float = 0.7):
    """
    对新的章节文本进行分段后,再用于存入向量库。
    使用 embedding 进行文本相似度计算。
    """
    if not chapter_text.strip():
        return []
    
    sentences = split_sentences(chapter_text)
    if not sentences:
        return []
    
    # 直接按长度分段,不做相似度合并
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

def update_vector_store(
    embedding_adapter,
    new_chapter: str,
    filepath: str,
    chapter_number: Optional[int] = None,
) -> bool:
    """
    将最新章节文本插入到向量库中。
    若库不存在则初始化；若初始化/更新失败，则跳过。
    """
    from langchain_core.documents import Document
    splitted_texts = split_text_for_vectorstore(new_chapter)
    if not splitted_texts:
        logging.warning("No valid text to insert into vector store. Skipping.")
        return False

    source_id = f"chapter:{chapter_number}" if chapter_number is not None else "chapter:unknown"
    metadatas = [
        {
            "source_type": "chapter",
            "source_id": source_id,
            "chapter_number": chapter_number if chapter_number is not None else 0,
            "chunk_index": index,
        }
        for index in range(len(splitted_texts))
    ]
    ids = [
        f"{source_id}:{index}:{hashlib.sha256(text.encode('utf-8')).hexdigest()[:16]}"
        for index, text in enumerate(splitted_texts)
    ]

    store = load_vector_store(embedding_adapter, filepath)
    if not store:
        logging.info("Vector store does not exist or failed to load. Initializing a new one for new chapter...")
        store = init_vector_store(
            embedding_adapter,
            splitted_texts,
            filepath,
            metadatas=metadatas,
            ids=ids,
        )
        if not store:
            logging.warning("Init vector store failed, skip embedding.")
        else:
            logging.info("New vector store created successfully.")
        return store is not None

    try:
        docs = [
            Document(page_content=str(text), metadata=metadata)
            for text, metadata in zip(splitted_texts, metadatas)
        ]
        replace_source_documents(store, docs, ids, source_id)
        logging.info("Vector store updated with the new chapter splitted segments.")
        return True
    except Exception as e:
        logging.warning(f"Failed to update vector store: {e}")
        traceback.print_exc()
        return False

def get_relevant_context_from_vector_store(embedding_adapter, query: str, filepath: str, k: int = 2) -> str:
    """
    从向量库中检索与 query 最相关的 k 条文本，拼接后返回。
    如果向量库加载/检索失败，则返回空字符串。
    最终只返回最多2000字符的检索片段。
    """
    store = load_vector_store(embedding_adapter, filepath)
    if not store:
        logging.info("No vector store found or load failed. Returning empty context.")
        return ""

    try:
        docs = store.similarity_search(query, k=k)
        if not docs:
            logging.info(f"No relevant documents found for query '{query}'. Returning empty context.")
            return ""
        combined = "\n".join([d.page_content for d in docs])
        if len(combined) > 2000:
            combined = combined[:2000]
        return combined
    except Exception as e:
        logging.warning(f"Similarity search failed: {e}")
        traceback.print_exc()
        return ""


def get_knowledge_context_from_store(
    store,
    queries: list[str],
    k: int = 4,
    max_chars: int = 8000,
) -> str:
    """按多个主题检索知识库内容，并保留来源信息供生成提示词使用。"""
    if not store or not queries:
        return ""

    unique_documents = []
    seen = set()
    for query in queries:
        docs = store.similarity_search(
            query,
            k=max(1, k),
            filter={"source_type": "knowledge"},
        )
        for doc in docs:
            text = doc.page_content.strip()
            if not text:
                continue
            source = doc.metadata.get("source_name", "未知来源")
            key = (source, text)
            if key in seen:
                continue
            seen.add(key)
            unique_documents.append(f"[来源：{source}]\n{text}")

    context = "\n\n".join(unique_documents)
    if len(context) > max_chars:
        context = context[:max_chars].rstrip() + "\n（其余检索内容因长度限制省略）"
    return context

def _get_sentence_transformer(model_name: str = 'paraphrase-MiniLM-L6-v2'):
    """获取sentence transformer模型，处理SSL问题"""
    try:
        # 设置torch环境变量
        os.environ["TORCH_ALLOW_TF32_CUBLAS_OVERRIDE"] = "0"
        os.environ["TORCH_CUDNN_V8_API_ENABLED"] = "0"
        
        # 禁用SSL验证
        ssl._create_default_https_context = ssl._create_unverified_context
        
        # ...existing code...
    except Exception as e:
        logging.error(f"Failed to load sentence transformer model: {e}")
        traceback.print_exc()
        return None
