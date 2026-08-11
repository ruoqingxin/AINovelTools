# -*- coding: utf-8 -*-
import importlib.util
import io
from pathlib import Path
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

COMMON_PATH = Path(__file__).resolve().parents[1] / "novel_generator" / "common.py"
SPEC = importlib.util.spec_from_file_location("common_under_test", COMMON_PATH)
common = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(common)

invoke_with_cleaning = common.invoke_with_cleaning
remove_think_tags = common.remove_think_tags
normalize_llm_text = common.normalize_llm_text


class FakeLLMAdapter:
    def __init__(self, response):
        self.response = response

    def invoke(self, prompt):
        return self.response


class SequenceLLMAdapter:
    def __init__(self, responses):
        self.responses = iter(responses)

    def invoke(self, prompt):
        return next(self.responses)


class CommonCleaningTest(unittest.TestCase):
    def test_remove_think_tags_strips_reasoning_blocks(self):
        text = "prefix<think>internal reasoning</think>body"

        self.assertEqual("prefixbody", remove_think_tags(text))

    def test_invoke_with_cleaning_removes_think_tags_from_llm_output(self):
        adapter = FakeLLMAdapter(
            "```<think>internal reasoning should be hidden</think>\nChapter text```"
        )

        with redirect_stdout(io.StringIO()):
            result = invoke_with_cleaning(adapter, "write chapter")

        self.assertEqual("Chapter text", result)

    def test_normalize_llm_text_supports_block_responses(self):
        response = [
            {"type": "reasoning", "content": ""},
            {"type": "text", "text": "第一段"},
            {"type": "text", "text": "\n第二段"},
        ]

        self.assertEqual("第一段\n第二段", normalize_llm_text(response))

    def test_empty_response_uses_backoff_before_retry(self):
        adapter = SequenceLLMAdapter(["", "```markdown\n正文\n```"])

        with (
            patch.object(common.random, "uniform", return_value=1.0),
            patch.object(common.time, "sleep") as sleep,
        ):
            result = invoke_with_cleaning(adapter, "write", retry_delay=0.5)

        self.assertEqual("正文", result)
        sleep.assert_called_once_with(0.5)


if __name__ == "__main__":
    unittest.main()
