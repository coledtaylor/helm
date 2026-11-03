//! Notifications on Windows: a balloon from an icon of its own in the
//! notification area (`Shell_NotifyIconW` with `NIF_INFO`), which Windows 10
//! and 11 show as a toast. Each notice has a hidden message-only window on a
//! thread of its own, which adds the icon with the balloon, and takes both
//! away once the balloon is dismissed, clicked or timed out, or after
//! [`LINGER`] at most. The texts are copied into the balloon's own fields:
//! plain text, which the shell draws as it is.

use std::io;
use std::sync::{OnceLock, mpsc};

use windows_sys::Win32::Foundation::{
    ERROR_CLASS_ALREADY_EXISTS, GetLastError, HWND, LPARAM, LRESULT, WPARAM,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::Shell::{
    NIF_ICON, NIF_INFO, NIF_MESSAGE, NIF_TIP, NIIF_INFO, NIM_ADD, NIM_DELETE, NIN_BALLOONHIDE,
    NIN_BALLOONTIMEOUT, NIN_BALLOONUSERCLICK, NOTIFYICONDATAW, Shell_NotifyIconW,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyIcon, DestroyWindow, DispatchMessageW, GetMessageW,
    HICON, HWND_MESSAGE, KillTimer, MSG, PostQuitMessage, RegisterClassExW, SetTimer,
    TranslateMessage, WM_APP, WM_DESTROY, WM_TIMER, WNDCLASSEXW,
};

use super::{Notice, ShowNotice};
use crate::platform::tray::windows::{app_icon, wide};
use crate::{Error, Result};

/// The window class each notice's window is made from.
const CLASS_NAME: &str = "FlotiHostNotice";

/// What the shell sends about the balloon; `lParam` says what happened.
const CALLBACK: u32 = WM_APP + 1;

/// The icon's id among its window's icons; it has one.
const ICON_ID: u32 = 1;

/// The timer that takes the icon away when the shell never says the balloon
/// is done.
const TIMER_ID: usize = 1;

/// How long the icon stays at most, in milliseconds.
const LINGER: u32 = 60_000;

/// The Windows implementation.
#[derive(Debug, Clone, Copy, Default)]
pub struct Native;

impl ShowNotice for Native {
    fn show(&self, notice: &Notice) -> Result<()> {
        let (shown, taken) = mpsc::channel();
        let notice = notice.clone();
        std::thread::Builder::new()
            .name("notice".to_owned())
            .spawn(move || serve(&notice, &shown))
            .map_err(|err| Error::io("start a notification's thread", err))?;
        match taken.recv() {
            Ok(result) => result,
            Err(_) => Err(Error::io(
                "show a notification",
                io::Error::other("its thread ended before the shell took it"),
            )),
        }
    }
}

/// The notice's thread: makes its window, adds the icon with the balloon,
/// says whether the shell took it, then runs the window's messages until
/// the balloon is done.
fn serve(notice: &Notice, shown: &mpsc::Sender<Result<()>>) {
    let icon = app_icon();
    let window = match make_window() {
        Ok(window) => window,
        Err(err) => {
            let _ = shown.send(Err(err));
            destroy_icon(icon);
            return;
        }
    };
    let mut data = icon_data(window);
    data.uFlags = NIF_ICON | NIF_TIP | NIF_MESSAGE | NIF_INFO;
    data.uCallbackMessage = CALLBACK;
    data.hIcon = icon;
    data.szTip = fixed("Floti host");
    data.szInfoTitle = fixed(&notice.title);
    data.szInfo = fixed(&notice.body);
    data.dwInfoFlags = NIIF_INFO;
    // SAFETY: a filled structure of its own size, for this thread's window.
    if unsafe { Shell_NotifyIconW(NIM_ADD, &data) } == 0 {
        // No shell to take it: a session with no desktop, such as a
        // service's.
        let _ = shown.send(Err(Error::unsupported(
            "a notification where Windows has no notification area",
        )));
        // SAFETY: this thread's own window.
        unsafe { DestroyWindow(window) };
        destroy_icon(icon);
        return;
    }
    let _ = shown.send(Ok(()));
    // SAFETY: this thread's window, and a timer of its own on it.
    unsafe { SetTimer(window, TIMER_ID, LINGER, None) };
    run_messages();
    destroy_icon(icon);
}

fn destroy_icon(icon: HICON) {
    if !icon.is_null() {
        // SAFETY: made by `app_icon` and no longer in the shell's hands.
        unsafe { DestroyIcon(icon) };
    }
}

fn icon_data(window: HWND) -> NOTIFYICONDATAW {
    NOTIFYICONDATAW {
        cbSize: std::mem::size_of::<NOTIFYICONDATAW>() as u32,
        hWnd: window,
        uID: ICON_ID,
        ..Default::default()
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

/// A message-only window for one notice's icon.
fn make_window() -> Result<HWND> {
    static REGISTERED: OnceLock<std::result::Result<(), u32>> = OnceLock::new();
    let class = wide(CLASS_NAME);
    // SAFETY: this module's own image.
    let instance = unsafe { GetModuleHandleW(std::ptr::null()) };
    let registered = REGISTERED.get_or_init(|| {
        // SAFETY: zeroed is a valid empty class description.
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
            "register a notification's window",
            io::Error::from_raw_os_error(*code as i32),
        ));
    }
    // SAFETY: the class above, an empty title, the message-only parent, and
    // no creation data.
    let window = unsafe {
        CreateWindowExW(
            0,
            class.as_ptr(),
            class.as_ptr(),
            0,
            0,
            0,
            0,
            0,
            HWND_MESSAGE,
            std::ptr::null_mut(),
            instance,
            std::ptr::null(),
        )
    };
    if window.is_null() {
        return Err(Error::io(
            "make a notification's window",
            io::Error::last_os_error(),
        ));
    }
    Ok(window)
}

/// The window's messages: the balloon done, or the timer up, takes the icon
/// away and ends the window and its thread.
///
/// # Safety
///
/// Called by Windows for windows of [`CLASS_NAME`].
unsafe extern "system" fn window_proc(
    window: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    // SAFETY: as the function's contract says, throughout.
    unsafe {
        let done = match message {
            CALLBACK => matches!(
                (lparam & 0xFFFF) as u32,
                NIN_BALLOONHIDE | NIN_BALLOONTIMEOUT | NIN_BALLOONUSERCLICK
            ),
            WM_TIMER => wparam == TIMER_ID,
            WM_DESTROY => {
                PostQuitMessage(0);
                return 0;
            }
            _ => false,
        };
        if !done {
            return DefWindowProcW(window, message, wparam, lparam);
        }
        KillTimer(window, TIMER_ID);
        let data = icon_data(window);
        Shell_NotifyIconW(NIM_DELETE, &data);
        DestroyWindow(window);
        0
    }
}

/// `text` in a fixed field of `N` UTF-16 units: cut to fit with room for the
/// nul, never inside a pair.
fn fixed<const N: usize>(text: &str) -> [u16; N] {
    let mut units: Vec<u16> = text.encode_utf16().take(N - 1).collect();
    if units
        .last()
        .is_some_and(|unit| (0xD800..0xDC00).contains(unit))
    {
        units.pop();
    }
    let mut field = [0; N];
    field[..units.len()].copy_from_slice(&units);
    field
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn s6_a_long_title_is_cut_to_the_balloons_field_and_ends_in_nul() {
        let title = "\"a phone with a very long name indeed\" connected from another computer";
        let field: [u16; 64] = fixed(title);
        assert_eq!(field[63], 0);
        let shown = String::from_utf16_lossy(&field[..63]);
        assert!(title.starts_with(&shown), "{shown}");
        // A pair is never cut in half.
        let emoji: [u16; 4] = fixed("ab\u{1F600}");
        assert_eq!(&emoji, &[u16::from(b'a'), u16::from(b'b'), 0, 0]);
    }
}
