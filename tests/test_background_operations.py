import threading
import unittest

from ui.main_window import NovelGeneratorGUI
from ui.generation_handlers import _BACKGROUND_OPERATION_BUTTONS


class FakeMaster:
    def after(self, delay, callback):
        callback()


class FakeButton:
    def __init__(self):
        self.state = "normal"
        self.enabled = threading.Event()

    def configure(self, **kwargs):
        self.state = kwargs["state"]
        if self.state == "normal":
            self.enabled.set()


class FakeCancelButton:
    def __init__(self):
        self.state = "disabled"
        self.text = "中止 AI"

    def configure(self, **kwargs):
        self.state = kwargs.get("state", self.state)
        self.text = kwargs.get("text", self.text)


class BackgroundOperationTest(unittest.TestCase):
    def test_generation_operations_map_to_their_own_buttons(self):
        self.assertEqual(
            {
                "generate_architecture": "btn_generate_architecture",
                "generate_blueprint": "btn_generate_directory",
                "revise_architecture": "btn_revise_architecture",
                "revise_architecture_section": "btn_revise_architecture_section",
                "revise_blueprint": "btn_revise_blueprint",
                "generate_chapter": "btn_generate_chapter",
                "revise_chapter": "btn_revise_chapter",
                "finalize_chapter": "btn_finalize_chapter",
                "consistency_check": "btn_check_consistency",
                "batch_generate": "btn_batch_generate",
                "import_knowledge": "btn_import_knowledge",
            },
            _BACKGROUND_OPERATION_BUTTONS,
        )

    def test_rejects_overlapping_project_operations(self):
        gui = object.__new__(NovelGeneratorGUI)
        gui.master = FakeMaster()
        gui._closing = False
        gui._operation_lock = threading.Lock()
        gui._active_operations = set()
        gui._active_cancellation_token = None
        gui.btn_cancel_ai = FakeCancelButton()
        button = FakeButton()
        started = threading.Event()
        release = threading.Event()
        completed = threading.Event()

        def worker():
            started.set()
            release.wait(timeout=2)
            completed.set()

        self.assertTrue(gui.start_background_operation("generate", worker, button))
        self.assertTrue(started.wait(timeout=2))
        self.assertEqual("disabled", button.state)
        self.assertFalse(gui.start_background_operation("finalize", lambda: None))

        release.set()
        self.assertTrue(completed.wait(timeout=2))
        self.assertTrue(button.enabled.wait(timeout=2))
        self.assertEqual(set(), gui._active_operations)
        self.assertEqual("normal", button.state)

    def test_cancel_active_operation_stops_a_blocked_ai_request(self):
        from ai_cancellation import run_cancellable_request

        gui = object.__new__(NovelGeneratorGUI)
        gui.master = FakeMaster()
        gui._closing = False
        gui._operation_lock = threading.Lock()
        gui._active_operations = set()
        gui._active_cancellation_token = None
        gui.btn_cancel_ai = FakeCancelButton()
        gui.log = lambda _message: None
        gui.safe_log = lambda _message: None

        request_started = threading.Event()
        operation_finished = threading.Event()

        def blocked_request():
            request_started.set()
            threading.Event().wait(5)

        def operation():
            try:
                run_cancellable_request(blocked_request)
            finally:
                operation_finished.set()

        self.assertTrue(gui.start_background_operation("blocked", operation))
        self.assertTrue(request_started.wait(timeout=2))
        gui.cancel_active_operation()

        self.assertTrue(operation_finished.wait(timeout=2))

    def test_adapter_reports_prompt_waiting_and_response(self):
        from ai_cancellation import (
            CancellableAdapter,
            CancellationToken,
            reset_current_token,
            reset_progress_callback,
            set_current_token,
            set_progress_callback,
        )

        class SlowAdapter:
            def invoke(self, prompt):
                threading.Event().wait(0.05)
                return f"reply to {prompt}"

        messages = []
        token_context = set_current_token(CancellationToken())
        progress_context = set_progress_callback(messages.append)
        try:
            adapter = CancellableAdapter(SlowAdapter())
            result = adapter.invoke("完整提示词")
        finally:
            reset_progress_callback(progress_context)
            reset_current_token(token_context)

        self.assertEqual("reply to 完整提示词", result)
        self.assertIn("[发送给 AI]\n完整提示词", messages)
        self.assertIn("[AI 返回]\nreply to 完整提示词", messages)


if __name__ == "__main__":
    unittest.main()
