# main.py
# -*- coding: utf-8 -*-
from app_runtime import configure_app_logging, install_exception_logging

def main():
    configure_app_logging()
    install_exception_logging()

    import customtkinter as ctk
    from ui import NovelGeneratorGUI

    app = ctk.CTk()
    NovelGeneratorGUI(app)
    app.mainloop()

if __name__ == "__main__":
    main()
