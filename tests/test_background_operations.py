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


class BackgroundOperationTest(unittest.TestCase):
    def test_generation_operations_map_to_their_own_buttons(self):
        self.assertEqual(
            {
                "generate_architecture": "btn_generate_architecture",
                "generate_blueprint": "btn_generate_directory",
                "revise_architecture": "btn_revise_architecture",
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


if __name__ == "__main__":
    unittest.main()
