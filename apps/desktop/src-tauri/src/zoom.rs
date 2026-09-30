//! Keeps the webview at 100 %.
//!
//! Ritmo is an application window, not a document viewer: page zoom rescales
//! the entire layout, stops it fitting the screen and makes WebKit repaint a
//! much larger surface, which is what the user felt as lag.
//!
//! Blocking ctrl+wheel from JavaScript does not work — WebKitGTK applies zoom in
//! the UI process before the web content ever sees the event. Resetting
//! `zoom-level` after the fact does not work either: the zoom has already been
//! applied and relayout has already been scheduled. So the event is swallowed
//! at the GTK level, before WebKit can act on it, with the property lock kept as
//! a second line of defence for any other path into zoom.

#[cfg(target_os = "linux")]
pub fn lock<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    use gtk::gdk;
    use gtk::glib;
    use gtk::prelude::WidgetExt;
    use webkit2gtk::WebViewExt;

    let result = window.with_webview(|webview| {
        let view = webview.inner();
        view.set_zoom_level(1.0);

        // GTK delivers scroll to the widget before WebKit interprets it, so
        // returning `Stop` for a ctrl+scroll means the zoom never happens.
        view.connect_scroll_event(|_, event| {
            if event.state().contains(gdk::ModifierType::CONTROL_MASK) {
                glib::Propagation::Stop
            } else {
                glib::Propagation::Proceed
            }
        });

        view.connect_zoom_level_notify(|view| {
            if (view.zoom_level() - 1.0).abs() > f64::EPSILON {
                view.set_zoom_level(1.0);
            }
        });
    });

    match result {
        Ok(()) => tracing::debug!("webview zoom pinned at 1.0 and ctrl+scroll blocked"),
        Err(e) => tracing::warn!(error = %e, "could not pin webview zoom"),
    }
}

#[cfg(not(target_os = "linux"))]
pub fn lock<R: tauri::Runtime>(_window: &tauri::WebviewWindow<R>) {}
