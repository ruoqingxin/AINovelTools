import unittest
import sys
import types
from unittest.mock import patch

try:
    from langchain_core.documents import Document
except ImportError:
    class Document:
        def __init__(self, page_content, metadata=None):
            self.page_content = page_content
            self.metadata = metadata or {}

    langchain_core = types.ModuleType("langchain_core")
    documents_module = types.ModuleType("langchain_core.documents")
    documents_module.Document = Document
    langchain_core.documents = documents_module
    sys.modules["langchain_core"] = langchain_core
    sys.modules["langchain_core.documents"] = documents_module

from novel_generator.vectorstore_utils import (
    get_knowledge_context_from_store,
    replace_source_documents,
    update_vector_store,
)


class FakeStore:
    def __init__(self):
        self.deleted = []
        self.added = []
        self.searches = []

    def get(self, **kwargs):
        return {
            "ids": ["old-id"],
            "documents": ["old text"],
            "metadatas": [{"source_id": "chapter:3"}],
        }

    def delete(self, ids):
        self.deleted.append(ids)

    def add_documents(self, documents, ids):
        self.added.append((documents, ids))

    def similarity_search(self, query, k, filter):
        self.searches.append((query, k, filter))
        return [
            Document(page_content="既有世界设定", metadata={"source_name": "世界观.md"}),
        ]


class VectorStoreTest(unittest.TestCase):
    def test_knowledge_context_uses_only_knowledge_and_keeps_source(self):
        store = FakeStore()

        context = get_knowledge_context_from_store(store, ["世界", "历史"], k=3)

        self.assertEqual(context, "[来源：世界观.md]\n既有世界设定")
        self.assertEqual(store.searches[0], ("世界", 3, {"source_type": "knowledge"}))
        self.assertEqual(len(store.searches), 2)

    def test_chapter_update_replaces_existing_source_with_metadata(self):
        store = FakeStore()
        with patch("novel_generator.vectorstore_utils.load_vector_store", return_value=store):
            result = update_vector_store(object(), "第一句。第二句。", "project", chapter_number=3)

        self.assertTrue(result)
        self.assertEqual(store.deleted, [["old-id"]])
        documents, ids = store.added[0]
        self.assertTrue(ids[0].startswith("chapter:3:"))
        self.assertEqual(documents[0].metadata["source_type"], "chapter")
        self.assertEqual(documents[0].metadata["chapter_number"], 3)

    def test_replace_source_documents_restores_old_data_on_failure(self):
        store = FakeStore()

        def add_with_failure(documents, ids):
            if ids == ["new-id"]:
                raise RuntimeError("write failed")
            store.added.append((documents, ids))

        store.add_documents = add_with_failure
        with self.assertRaises(RuntimeError):
            replace_source_documents(
                store,
                [Document(page_content="new text", metadata={"source_id": "chapter:3"})],
                ["new-id"],
                "chapter:3",
            )

        self.assertEqual(store.deleted, [["old-id"], ["new-id"]])
        self.assertEqual(store.added[0][1], ["old-id"])
        self.assertEqual(store.added[0][0][0].page_content, "old text")


if __name__ == "__main__":
    unittest.main()
