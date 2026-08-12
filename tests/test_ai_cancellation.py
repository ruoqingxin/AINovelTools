import threading
import unittest

from ai_cancellation import (
    CancellationToken,
    reset_current_token,
    reset_progress_callback,
    run_cancellable_request,
    set_current_token,
    set_progress_callback,
)


class AiCancellationTest(unittest.TestCase):
    def test_blocked_request_reports_waiting_heartbeat(self):
        release = threading.Event()
        messages = []
        token_context = set_current_token(CancellationToken())
        progress_context = set_progress_callback(messages.append)
        try:
            result = run_cancellable_request(
                lambda: release.wait(0.05) or "done",
                waiting_label="测试请求",
                heartbeat_seconds=0.01,
            )
        finally:
            reset_progress_callback(progress_context)
            reset_current_token(token_context)

        self.assertEqual("done", result)
        self.assertTrue(
            any("[测试请求] 仍在等待返回" in message for message in messages)
        )


if __name__ == "__main__":
    unittest.main()
