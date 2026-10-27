//! The native menu bar. Custom items are forwarded to the UI as a `menu` event
//! carrying the item id; the predefined Edit items keep copy/paste working.

use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, Runtime};

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let item = |id: &str, label: &str, accelerator: Option<&str>| {
        let builder = MenuItemBuilder::with_id(id, label);
        match accelerator {
            Some(a) => builder.accelerator(a).build(app),
            None => builder.build(app),
        }
    };

    let app_menu = SubmenuBuilder::new(app, "Onyx")
        .item(&PredefinedMenuItem::about(app, Some("About Onyx"), None)?)
        .separator()
        .item(&item("settings", "Settings…", Some("CmdOrCtrl+,"))?)
        .separator()
        .item(&PredefinedMenuItem::services(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::hide(app, None)?)
        .item(&PredefinedMenuItem::hide_others(app, None)?)
        .item(&PredefinedMenuItem::show_all(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::quit(app, None)?)
        .build()?;

    let file = SubmenuBuilder::new(app, "File")
        .item(&item("new-query", "New Query", Some("CmdOrCtrl+T"))?)
        .item(&item("new-connection", "New Connection…", Some("CmdOrCtrl+N"))?)
        .item(&item("save-query", "Save Query…", Some("CmdOrCtrl+S"))?)
        .item(&item("open-file", "Open Database File…", Some("CmdOrCtrl+O"))?)
        .separator()
        .item(&item("close-tab", "Close Tab", Some("CmdOrCtrl+W"))?)
        .item(&item("close-window", "Close Window", Some("CmdOrCtrl+Shift+W"))?)
        .build()?;

    let edit = SubmenuBuilder::new(app, "Edit")
        .item(&PredefinedMenuItem::undo(app, None)?)
        .item(&PredefinedMenuItem::redo(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, None)?)
        .item(&PredefinedMenuItem::copy(app, None)?)
        .item(&PredefinedMenuItem::paste(app, None)?)
        .item(&PredefinedMenuItem::select_all(app, None)?)
        .build()?;

    // Run shortcuts live in the editor (⌘↵, ⇧⌘↵, ⇧⌘F); the menu lists them without stealing keys.
    let query = SubmenuBuilder::new(app, "Query")
        .item(&item("run", "Run Statement  ⌘↵", None)?)
        .item(&item("run-all", "Run All  ⇧⌘↵", None)?)
        .item(&item("cancel", "Cancel Query", Some("CmdOrCtrl+."))?)
        .item(&item("format", "Format SQL  ⇧⌘F", None)?)
        .separator()
        .item(&item("explain", "Explain", Some("CmdOrCtrl+E"))?)
        .item(&item("ask-ai", "Write SQL from a Description…", Some("CmdOrCtrl+Shift+I"))?)
        .build()?;

    let mut view = SubmenuBuilder::new(app, "View")
        .item(&item("palette", "Command Palette…", Some("CmdOrCtrl+K"))?)
        .separator()
        .item(&item("toggle-sidebar", "Toggle Sidebar", Some("CmdOrCtrl+B"))?)
        .item(&item("sidebar-side", "Move Sidebar Left or Right", Some("CmdOrCtrl+Alt+B"))?)
        .item(&item("toggle-results", "Toggle Results", Some("CmdOrCtrl+J"))?)
        .item(&item("toggle-ide", "Toggle IDE Mode", Some("CmdOrCtrl+Shift+E"))?)
        .item(&item("toggle-split", "Split Editor", Some("CmdOrCtrl+Backslash"))?)
        .item(&item("toggle-privacy", "Privacy Mode (Mask Personal Data)", Some("CmdOrCtrl+Shift+P"))?)
        .separator()
        .item(&PredefinedMenuItem::fullscreen(app, None)?);
    if cfg!(debug_assertions) {
        view = view.separator().item(&item("reload", "Reload", Some("CmdOrCtrl+R"))?);
    }
    let view = view.build()?;

    let window = SubmenuBuilder::new(app, "Window")
        .item(&PredefinedMenuItem::minimize(app, None)?)
        .item(&PredefinedMenuItem::maximize(app, None)?)
        .build()?;

    MenuBuilder::new(app).items(&[&app_menu, &file, &edit, &query, &view, &window]).build()
}

pub fn handle<R: Runtime>(app: &AppHandle<R>, id: &str) {
    let window = app.get_webview_window("main");
    match (id, window) {
        ("close-window", Some(w)) => {
            let _ = w.close();
        }
        ("reload", Some(w)) => {
            let _ = w.reload();
        }
        _ => {
            let _ = app.emit("menu", id);
        }
    }
}
