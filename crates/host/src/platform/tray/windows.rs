//! The notification area on Windows: one icon (`Shell_NotifyIconW`) owned by
//! a hidden window on a thread of its own, its menu (`TrackPopupMenu`) on a
//! click, and the question before stopping (`MessageBoxW`).
//!
//! The window is a hidden top-level tool window rather than a message-only
//! one: the shell broadcasts `TaskbarCreated` when Explorer restarts, which
//! a message-only window never receives, and a menu dismisses on a click
//! elsewhere only when its window can come to the foreground, which a
//! message-only window cannot. It is never shown.
//!
//! The icon is the app's own, embedded from its icon file, at the size the
//! notification area draws at this DPI.

use std::cell::Cell;
use std::ffi::c_void;
use std::io;
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock, PoisonError, mpsc};
use std::thread::JoinHandle;

use windows_sys::Win32::Foundation::{
    ERROR_ACCESS_DENIED, ERROR_CLASS_ALREADY_EXISTS, GetLastError, HWND, LPARAM, LRESULT, POINT,
    WPARAM,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Threading::{CREATE_BREAKAWAY_FROM_JOB, CREATE_NEW_PROCESS_GROUP};
use windows_sys::Win32::UI::HiDpi::{
    DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, GetDpiForSystem, GetSystemMetricsForDpi,
    SetThreadDpiAwarenessContext,
};
use windows_sys::Win32::UI::Shell::{
    NIF_ICON, NIF_MESSAGE, NIF_TIP, NIM_ADD, NIM_DELETE, NIM_MODIFY, NOTIFYICONDATAW,
    Shell_NotifyIconW,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    AppendMenuW, CREATESTRUCTW, CreateIconFromResourceEx, CreatePopupMenu, CreateWindowExW,
    DefWindowProcW, DestroyIcon, DestroyMenu, DestroyWindow, DispatchMessageW, GWLP_USERDATA,
    GetCursorPos, GetMessageW, GetWindowLongPtrW, HICON, IDYES, LR_DEFAULTCOLOR, MB_DEFBUTTON2,
    MB_ICONWARNING, MB_SETFOREGROUND, MB_TOPMOST, MB_YESNO, MF_SEPARATOR, MF_STRING, MSG,
    MessageBoxW, PostMessageW, PostQuitMessage, RegisterClassExW, RegisterWindowMessageW,
    SM_CXSMICON, SM_CYSMICON, SendMessageW, SetForegroundWindow, SetWindowLongPtrW,
    TPM_BOTTOMALIGN, TPM_NONOTIFY, TPM_RETURNCMD, TPM_RIGHTBUTTON, TrackPopupMenu,
    TranslateMessage, WM_APP, WM_CLOSE, WM_COMMAND, WM_DESTROY, WM_LBUTTONUP, WM_NCCREATE, WM_NULL,
    WM_RBUTTONUP, WNDCLASSEXW, WS_EX_TOOLWINDOW, WS_POPUP,
};

use super::{
    Answer, NotificationArea, OPEN_LABEL, Question, STOP_LABEL, TOOLTIP_MAX, TrayIcon, TrayItem,
};
use crate::{DesktopCommand, Error, Result};

/// The app's icon file, from which the notification area's icon is drawn.
const APP_ICON: &[u8] = include_bytes!("../../../../../packages/desktop/build/icon.ico");

/// The window class the icon's window is made from.
const CLASS_NAME: &str = "FlotiHostNotificationArea";

/// Shows the icon, or changes its tooltip: `lParam` points at the tooltip,
/// a `[u16; 128]` ending in nul. Answers 1 when the shell took it.
const SHOW: u32 = WM_APP + 1;
/// Takes the icon away.
const HIDE: u32 = WM_APP + 2;
/// What the shell sends when the icon is clicked; `lParam` is the mouse
/// message.
const CLICKED: u32 = WM_APP + 3;
/// Takes the icon away and ends the window and its thread.
const CLOSE: u32 = WM_APP + 4;

/// The menu's items, as `WM_COMMAND` names them.
const OPEN_ID: usize = 1;
const STOP_ID: usize = 2;

/// The icon's id among the window's icons; it has one.
const ICON_ID: u32 = 1;

/// The Windows notification area: a hidden window on a thread of its own.
pub struct Native {
    /// The window, as an address: a window handle may be used from any
    /// thread, though only its own thread runs its messages.
    window: isize,
    thread: Mutex<Option<JoinHandle<()>>>,
}

impl Native {
    /// Starts the window's thread. Nothing shows until [`show`]; each item
    /// the user picks from the icon's menu is handed to `picked`, on that
    /// thread.
    ///
    /// [`show`]: NotificationArea::show
    pub fn start(picked: impl Fn(TrayItem) + Send + 'static) -> Result<Self> {
        let (ready, made) = mpsc::channel();
        let thread = std::thread::Builder::new()
            .name("notification area".to_owned())
            .spawn(move || serve(Box::new(picked), &ready))
            .map_err(|err| Error::io("start the notification area's thread", err))?;
        match made.recv() {
            Ok(Ok(window)) => Ok(Self {
                window,
                thread: Mutex::new(Some(thread)),
            }),
            Ok(Err(err)) => {
                let _ = thread.join();
                Err(err)
            }
            Err(_) => {
                let _ = thread.join();
                Err(Error::io(
                    "start the notification area",
                    io::Error::other("its thread ended before it made its window"),
                ))
            }
        }
    }

    fn hwnd(&self) -> HWND {
        self.window as HWND
    }
}

impl Drop for Native {
    fn drop(&mut self) {
        // SAFETY: the window is this one's, and answers CLOSE on its own
        // thread, inside any menu it is showing; sent once, here.
        unsafe { SendMessageW(self.hwnd(), CLOSE, 0, 0) };
        if let Some(thread) = self
            .thread
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take()
        {
            let _ = thread.join();
        }
    }
}

impl NotificationArea for Native {
    fn show(&self, icon: &TrayIcon) -> Result<()> {
        let tip = tooltip(&icon.tooltip);
        // SAFETY: SendMessageW returns once the window's thread has handled
        // SHOW, which copies the tooltip, so `tip` outlives its use.
        let shown = unsafe { SendMessageW(self.hwnd(), SHOW, 0, tip.as_ptr() as LPARAM) };
        if shown == 1 {
            Ok(())
        } else {
            Err(Error::io(
                "show the host's icon in the notification area",
                io::Error::other("the taskbar did not take it"),
            ))
        }
    }

    fn hide(&self) -> Result<()> {
        // SAFETY: as in `show`, with nothing passed.
        unsafe { SendMessageW(self.hwnd(), HIDE, 0, 0) };
        Ok(())
    }

    fn confirm(&self, question: &Question, answer: Answer) {
        let text = wide(&question.text);
        let title = wide(&question.title);
        // The dialog blocks until it is answered, so it has a thread of its
        // own. One nobody answers holds only that thread: the host stopping
        // for another reason ends the process, and the dialog with it.
        let asked = std::thread::Builder::new()
            .name("notification area question".to_owned())
            .spawn(move || answer(ask(&text, &title)));
        if let Err(err) = asked {
            log_line!("floti host: could not ask before stopping: {err}");
        }
    }

    fn open(&self, desktop: &DesktopCommand) -> Result<()> {
        let start = |flags| {
            Command::new(&desktop.program)
                .args(&desktop.args)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .creation_flags(flags)
                .spawn()
        };
        // Out of the job that ends what the host starts with the host: the
        // desktop must outlive a host it then stops. A job above that one
        // that refuses to let go is no reason not to open it.
        let started = match start(CREATE_BREAKAWAY_FROM_JOB | CREATE_NEW_PROCESS_GROUP) {
            Err(err) if err.raw_os_error() == Some(ERROR_ACCESS_DENIED as i32) => {
                start(CREATE_NEW_PROCESS_GROUP)
            }
            started => started,
        };
        // Dropping the child lets it run on: Windows ends nothing for it.
        started.map(drop).map_err(|err| {
            Error::io(
                format!("open {}", Path::new(&desktop.program).display()),
                err,
            )
        })
    }
}

/// Asks `text` under `title`, both ending in nul, in a dialog drawn at the
/// display's own scale; whether the user said yes. No is the default, so a
/// stray Enter ends nothing.
fn ask(text: &[u16], title: &[u16]) -> bool {
    // SAFETY: the thread's awareness, a plain value; it is this thread's
    // only window.
    unsafe { SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
    // SAFETY: both strings end in nul and outlive the call; no owner.
    let answer = unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            text.as_ptr(),
            title.as_ptr(),
            MB_YESNO | MB_ICONWARNING | MB_DEFBUTTON2 | MB_SETFOREGROUND | MB_TOPMOST,
        )
    };
    if answer == 0 {
        log_line!(
            "floti host: could not ask before stopping: {}",
            io::Error::last_os_error()
        );
    }
    answer == IDYES
}

/// What the window's thread keeps for it, alive for as long as the thread
/// runs its messages. Only shared references reach it, through the
/// window's user data, so a message handled inside the menu's own loop
/// changes it safely.
struct State {
    picked: Box<dyn Fn(TrayItem) + Send>,
    icon: HICON,
    /// The message the shell broadcasts when the taskbar is made again.
    taskbar_created: u32,
    /// The tooltip last asked for.
    tip: Cell<[u16; TOOLTIP_MAX + 1]>,
    /// Whether the icon is wanted, and whether the shell has it.
    wanted: Cell<bool>,
    added: Cell<bool>,
}

/// The window's thread: makes the window, says whether it could, and runs
/// its messages until it is closed.
fn serve(picked: Box<dyn Fn(TrayItem) + Send>, ready: &mpsc::Sender<Result<isize>>) {
    // Drawn at the display's own scale, so the icon and the menu are sharp.
    // SAFETY: the thread's awareness, a plain value.
    unsafe { SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
    let state = State {
        picked,
        icon: app_icon(),
        // SAFETY: a nul-terminated name.
        taskbar_created: unsafe { RegisterWindowMessageW(wide("TaskbarCreated").as_ptr()) },
        tip: Cell::new([0; TOOLTIP_MAX + 1]),
        wanted: Cell::new(false),
        added: Cell::new(false),
    };
    match make_window(&state) {
        Ok(window) => {
            let _ = ready.send(Ok(window as isize));
            run_messages();
        }
        Err(err) => {
            let _ = ready.send(Err(err));
        }
    }
    if !state.icon.is_null() {
        // SAFETY: made by `app_icon` and no longer in the shell's hands.
        unsafe { DestroyIcon(state.icon) };
    }
}

fn run_messages() {
    // SAFETY: a zeroed MSG is what GetMessageW fills.
    let mut msg: MSG = unsafe { std::mem::zeroed() };
    // SAFETY: this thread's messages, into `msg`; 0 is WM_QUIT, -1 an error.
    while unsafe { GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) } > 0 {
        // SAFETY: `msg` is the message just read.
        unsafe {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

/// The hidden window, with `state` in its user data from its first message.
fn make_window(state: &State) -> Result<HWND> {
    static REGISTERED: OnceLock<std::result::Result<(), u32>> = OnceLock::new();
    let class = wide(CLASS_NAME);
    // SAFETY: this module's own image.
    let instance = unsafe { GetModuleHandleW(std::ptr::null()) };
    let registered = REGISTERED.get_or_init(|| {
        let mut class_info: WNDCLASSEXW = unsafe { std::mem::zeroed() };
        class_info.cbSize = std::mem::size_of::<WNDCLASSEXW>() as u32;
        class_info.lpfnWndProc = Some(window_proc);
        class_info.hInstance = instance;
        class_info.lpszClassName = class.as_ptr();
        // SAFETY: a filled class whose name outlives the call; the system
        // copies it.
        if unsafe { RegisterClassExW(&class_info) } != 0 {
            return Ok(());
        }
        // SAFETY: reads this thread's last error.
        match unsafe { GetLastError() } {
            ERROR_CLASS_ALREADY_EXISTS => Ok(()),
            code => Err(code),
        }
    });
    if let Err(code) = registered {
        return Err(Error::io(
            "register the notification area's window",
            io::Error::from_raw_os_error(*code as i32),
        ));
    }
    let title = wide("Floti host");
    // SAFETY: the class above, a nul-terminated title, no parent, and
    // `state`, which outlives the window: the thread destroys the window
    // before it returns.
    let window = unsafe {
        CreateWindowExW(
            WS_EX_TOOLWINDOW,
            class.as_ptr(),
            title.as_ptr(),
            WS_POPUP,
            0,
            0,
            0,
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            instance,
            std::ptr::from_ref(state).cast::<c_void>(),
        )
    };
    if window.is_null() {
        return Err(Error::io(
            "make the notification area's window",
            io::Error::last_os_error(),
        ));
    }
    Ok(window)
}

/// The window's messages.
///
/// # Safety
///
/// Called by Windows for windows of [`CLASS_NAME`], whose user data is null
/// or the [`State`] their thread keeps alive while it runs their messages.
unsafe extern "system" fn window_proc(
    window: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    // SAFETY: as the function's contract says, throughout.
    unsafe {
        if message == WM_NCCREATE {
            let create = lparam as *const CREATESTRUCTW;
            SetWindowLongPtrW(window, GWLP_USERDATA, (*create).lpCreateParams as isize);
            return DefWindowProcW(window, message, wparam, lparam);
        }
        let state = GetWindowLongPtrW(window, GWLP_USERDATA) as *const State;
        let Some(state) = state.as_ref() else {
            return DefWindowProcW(window, message, wparam, lparam);
        };
        match message {
            SHOW => {
                state.tip.set(*(lparam as *const [u16; TOOLTIP_MAX + 1]));
                state.wanted.set(true);
                LRESULT::from(state.notify(window))
            }
            HIDE => {
                state.remove(window);
                0
            }
            CLICKED => {
                let mouse = (lparam & 0xFFFF) as u32;
                if mouse == WM_LBUTTONUP || mouse == WM_RBUTTONUP {
                    state.menu(window);
                }
                0
            }
            WM_COMMAND => {
                state.pick(wparam & 0xFFFF);
                0
            }
            CLOSE => {
                state.remove(window);
                DestroyWindow(window);
                0
            }
            // Only CLOSE ends it: the window and its icon are the host's.
            WM_CLOSE => 0,
            WM_DESTROY => {
                SetWindowLongPtrW(window, GWLP_USERDATA, 0);
                PostQuitMessage(0);
                0
            }
            _ if message == state.taskbar_created && message != 0 => {
                // The taskbar was made again and has no icons: add it back.
                state.added.set(false);
                if state.wanted.get() {
                    state.notify(window);
                }
                0
            }
            _ => DefWindowProcW(window, message, wparam, lparam),
        }
    }
}

impl State {
    fn data(&self, window: HWND) -> NOTIFYICONDATAW {
        NOTIFYICONDATAW {
            cbSize: std::mem::size_of::<NOTIFYICONDATAW>() as u32,
            hWnd: window,
            uID: ICON_ID,
            ..Default::default()
        }
    }

    /// Adds the icon, or changes it once added; whether the shell took it.
    fn notify(&self, window: HWND) -> bool {
        let mut data = self.data(window);
        data.uFlags = NIF_ICON | NIF_TIP | NIF_MESSAGE;
        data.uCallbackMessage = CLICKED;
        data.hIcon = self.icon;
        data.szTip = self.tip.get();
        let action = if self.added.get() {
            NIM_MODIFY
        } else {
            NIM_ADD
        };
        // SAFETY: a filled structure of its own size.
        let took = unsafe { Shell_NotifyIconW(action, &data) } != 0;
        if took {
            self.added.set(true);
        }
        took
    }

    fn remove(&self, window: HWND) {
        self.wanted.set(false);
        if self.added.replace(false) {
            let data = self.data(window);
            // SAFETY: the icon this window added.
            unsafe { Shell_NotifyIconW(NIM_DELETE, &data) };
        }
    }

    /// The icon's menu at the pointer, and what is picked from it.
    fn menu(&self, window: HWND) {
        let open = wide(OPEN_LABEL);
        let stop = wide(STOP_LABEL);
        // SAFETY: a menu made, filled with nul-terminated labels that outlive
        // it, shown and destroyed here; the window is this thread's own.
        let chosen = unsafe {
            let menu = CreatePopupMenu();
            if menu.is_null() {
                return;
            }
            AppendMenuW(menu, MF_STRING, OPEN_ID, open.as_ptr());
            AppendMenuW(menu, MF_SEPARATOR, 0, std::ptr::null());
            AppendMenuW(menu, MF_STRING, STOP_ID, stop.as_ptr());
            let mut at = POINT { x: 0, y: 0 };
            GetCursorPos(&mut at);
            // A menu closes on a click elsewhere only when its window is in
            // the foreground; the message after it lets it close at once.
            SetForegroundWindow(window);
            let chosen = TrackPopupMenu(
                menu,
                TPM_RETURNCMD | TPM_NONOTIFY | TPM_RIGHTBUTTON | TPM_BOTTOMALIGN,
                at.x,
                at.y,
                0,
                window,
                std::ptr::null(),
            );
            PostMessageW(window, WM_NULL, 0, 0);
            DestroyMenu(menu);
            chosen
        };
        self.pick(usize::try_from(chosen).unwrap_or(0));
    }

    fn pick(&self, id: usize) {
        match id {
            OPEN_ID => (self.picked)(TrayItem::OpenDesktop),
            STOP_ID => (self.picked)(TrayItem::StopHost),
            _ => {}
        }
    }
}

/// The app's icon at the size the notification area draws icons at this
/// DPI, or null when Windows would not make it: the shell then shows a
/// blank icon, which still has its tooltip and menu.
fn app_icon() -> HICON {
    // SAFETY: plain values.
    let (width, height) = unsafe {
        let dpi = GetDpiForSystem();
        (
            GetSystemMetricsForDpi(SM_CXSMICON, dpi),
            GetSystemMetricsForDpi(SM_CYSMICON, dpi),
        )
    };
    let Some(image) = icon_image(APP_ICON, u32::try_from(width).unwrap_or(16)) else {
        return std::ptr::null_mut();
    };
    // SAFETY: `image` is one whole image from the icon file, PNG or DIB,
    // which is what an icon resource holds.
    unsafe {
        CreateIconFromResourceEx(
            image.as_ptr(),
            image.len() as u32,
            1,
            0x0003_0000,
            width,
            height,
            LR_DEFAULTCOLOR,
        )
    }
}

/// From an `.ico` file's bytes, the image best drawn at `size` pixels: the
/// smallest at least that wide, or the largest when none is. `None` when the
/// bytes are not an icon file.
fn icon_image(file: &[u8], size: u32) -> Option<&[u8]> {
    let word = |at: usize| Some(u16::from_le_bytes(file.get(at..at + 2)?.try_into().ok()?));
    let dword = |at: usize| Some(u32::from_le_bytes(file.get(at..at + 4)?.try_into().ok()?));
    if word(0)? != 0 || word(2)? != 1 {
        return None;
    }
    let mut best: Option<(u32, usize, usize)> = None;
    for index in 0..usize::from(word(4)?) {
        let entry = 6 + index * 16;
        // A width byte of 0 is 256.
        let width = match *file.get(entry)? {
            0 => 256,
            width => u32::from(width),
        };
        let length = usize::try_from(dword(entry + 8)?).ok()?;
        let offset = usize::try_from(dword(entry + 12)?).ok()?;
        file.get(offset..offset.checked_add(length)?)?;
        let better = match best {
            None => true,
            Some((have, ..)) if have < size => width > have,
            Some((have, ..)) => width >= size && width < have,
        };
        if better {
            best = Some((width, offset, length));
        }
    }
    let (_, offset, length) = best?;
    file.get(offset..offset + length)
}

/// A tooltip as the shell takes it: at most [`TOOLTIP_MAX`] UTF-16 units,
/// never ending inside a pair, then nul.
fn tooltip(text: &str) -> [u16; TOOLTIP_MAX + 1] {
    let mut units: Vec<u16> = text.encode_utf16().take(TOOLTIP_MAX).collect();
    if units
        .last()
        .is_some_and(|unit| (0xD800..0xDC00).contains(unit))
    {
        units.pop();
    }
    let mut tip = [0; TOOLTIP_MAX + 1];
    tip[..units.len()].copy_from_slice(&units);
    tip
}

/// `text` as UTF-16 ending in nul.
fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_icon_drawn_is_the_apps_own_at_the_smallest_size_that_is_not_scaled_up() {
        let at = |size| {
            let image = icon_image(APP_ICON, size).expect("the app's icon file has images");
            // Each image is a PNG or a DIB: the header says how wide it is.
            if image.starts_with(b"\x89PNG") {
                u32::from_be_bytes(image[16..20].try_into().unwrap())
            } else {
                u32::from_le_bytes(image[4..8].try_into().unwrap())
            }
        };
        assert_eq!(at(16), 16);
        assert_eq!(at(20), 24);
        assert_eq!(at(24), 24);
        assert_eq!(at(32), 32);
        assert_eq!(at(1024), 256);
    }

    #[test]
    fn what_is_not_an_icon_file_gives_no_image() {
        assert_eq!(icon_image(b"", 16), None);
        assert_eq!(icon_image(b"\x89PNG\r\n\x1a\n", 16), None);
        // One image, said to run past the end of the file.
        let mut file = vec![0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0, 32, 0];
        file.extend_from_slice(&100u32.to_le_bytes());
        file.extend_from_slice(&22u32.to_le_bytes());
        assert_eq!(icon_image(&file, 16), None);
    }

    #[test]
    fn a_tooltip_is_cut_to_what_the_shell_takes_and_ends_in_nul() {
        let short = tooltip("Helm: 2 sessions running on this PC's host");
        assert_eq!(
            String::from_utf16(&short[..short.iter().position(|&u| u == 0).unwrap()]).unwrap(),
            "Helm: 2 sessions running on this PC's host"
        );
        let long = tooltip(&"x".repeat(300));
        assert_eq!(long[TOOLTIP_MAX], 0);
        assert!(long[..TOOLTIP_MAX].iter().all(|&u| u == u16::from(b'x')));
        // A pair cut in half is dropped whole.
        let paired = tooltip(&format!("{}\u{1F600}", "x".repeat(TOOLTIP_MAX - 1)));
        assert_eq!(paired[TOOLTIP_MAX - 1], 0);
    }
}
