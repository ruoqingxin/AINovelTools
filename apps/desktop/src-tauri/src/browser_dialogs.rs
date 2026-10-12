use tauri::{
    AppHandle, RunEvent, Runtime, Webview, Window,
    ipc::Invoke,
    plugin::{Plugin, TauriPlugin},
    webview::PageLoadPayload,
};

struct BrowserDialogs<R: Runtime>(TauriPlugin<R>);

// Keep the native file/message commands, but do not inject the plugin's
// Promise-returning window.confirm shim into synchronous editing guards.
pub(crate) fn init<R: Runtime>() -> impl Plugin<R> {
    BrowserDialogs(tauri_plugin_dialog::init())
}

impl<R: Runtime> Plugin<R> for BrowserDialogs<R> {
    fn name(&self) -> &'static str {
        self.0.name()
    }

    fn initialize(
        &mut self,
        app: &AppHandle<R>,
        config: serde_json::Value,
    ) -> Result<(), Box<dyn std::error::Error>> {
        self.0.initialize(app, config)
    }

    fn extend_api(&mut self, invoke: Invoke<R>) -> bool {
        self.0.extend_api(invoke)
    }

    fn window_created(&mut self, window: Window<R>) {
        self.0.window_created(window);
    }

    fn webview_created(&mut self, webview: Webview<R>) {
        self.0.webview_created(webview);
    }

    fn on_navigation(&mut self, webview: &Webview<R>, url: &tauri::Url) -> bool {
        self.0.on_navigation(webview, url)
    }

    fn on_page_load(&mut self, webview: &Webview<R>, payload: &PageLoadPayload<'_>) {
        self.0.on_page_load(webview, payload);
    }

    fn on_event(&mut self, app: &AppHandle<R>, event: &RunEvent) {
        self.0.on_event(app, event);
    }
}
