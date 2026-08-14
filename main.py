# main.py
# -*- coding: utf-8 -*-
import sys
from pathlib import Path

from app_runtime import configure_app_logging, install_exception_logging


def _ensure_project_dependencies():
    """Allow direct ``python main.py`` launches to use the bundled venv."""
    try:
        import customtkinter  # noqa: F401
        return
    except ModuleNotFoundError:
        pass
    project_root = Path(__file__).resolve().parent
    site_packages = project_root / ".venv" / "Lib" / "site-packages"
    if site_packages.is_dir() and str(site_packages) not in sys.path:
        sys.path.insert(0, str(site_packages))


def main():
    configure_app_logging()
    install_exception_logging()

    _ensure_project_dependencies()
    import customtkinter as ctk
    from ui import NovelGeneratorGUI

    app = ctk.CTk()
    NovelGeneratorGUI(app)
    app.mainloop()

if __name__ == "__main__":
    main()
