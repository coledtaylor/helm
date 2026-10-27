use std::path::Path;

use super::{StartAtSignIn, StartupKind, linux, macos, windows};

const WINDOWS_BINARY: &str = r"C:\Program Files\Floti App\floti.exe";
const UNIX_BINARY: &str = "/opt/Floti App/bin/floti";
const WINDOWS_USER: &str = r"WORKSTATION\someone";

/// The text between `<open>` and `</open>`.
fn section<'a>(contents: &'a str, open: &str) -> &'a str {
    let start = contents
        .find(&format!("<{open}>"))
        .unwrap_or_else(|| panic!("no <{open}> in:\n{contents}"));
    let end = contents
        .find(&format!("</{open}>"))
        .unwrap_or_else(|| panic!("no </{open}> in:\n{contents}"));
    &contents[start..end]
}

#[test]
fn windows_definition_is_a_logon_task_for_this_user_only_with_least_privilege() {
    let def = windows::logon_task(Path::new(WINDOWS_BINARY), WINDOWS_USER).unwrap();
    assert_eq!(def.kind, StartupKind::LogonTask);
    assert_eq!(def.name, "Floti host");
    assert_eq!(def.file_name, "Floti host.xml");
    assert_eq!(def.user_folder, None);
    let xml = &def.contents;

    assert!(xml.contains(r"<URI>\Floti host</URI>"), "{xml}");
    // Runs `floti host`, with the path quoted because it has spaces.
    assert!(
        xml.contains(r#"<Command>"C:\Program Files\Floti App\floti.exe"</Command>"#),
        "{xml}"
    );
    assert!(xml.contains("<Arguments>host</Arguments>"), "{xml}");

    // One trigger: this user's logon, and nothing else.
    let triggers = section(xml, "Triggers");
    assert_eq!(triggers.matches("Trigger>").count(), 2, "{triggers}");
    assert_eq!(triggers.matches("<LogonTrigger>").count(), 1, "{triggers}");
    assert!(
        triggers.contains(r"<UserId>WORKSTATION\someone</UserId>"),
        "{triggers}"
    );

    // Run as that user, with an interactive token and least privilege.
    let principal = section(xml, "Principals");
    assert!(principal.contains(r"<UserId>WORKSTATION\someone</UserId>"));
    assert!(principal.contains("<LogonType>InteractiveToken</LogonType>"));
    assert!(principal.contains("<RunLevel>LeastPrivilege</RunLevel>"));

    // The host runs until it is stopped; Task Scheduler's default limit would
    // end it after three days.
    assert!(xml.contains("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>"));

    for absent in [
        "BootTrigger",
        "TimeTrigger",
        "HighestAvailable",
        "S-1-5-18",
        "SYSTEM",
        "LocalSystem",
        "NetworkService",
        "LocalService",
        "<GroupId>",
        "Password",
        "S4U",
        "ServiceAccount",
    ] {
        assert!(!xml.contains(absent), "found {absent} in:\n{xml}");
    }
}

#[test]
fn windows_definition_refuses_system_accounts_and_relative_paths() {
    let binary = Path::new(WINDOWS_BINARY);
    for account in [
        r"NT AUTHORITY\SYSTEM",
        "SYSTEM",
        r"WORKGROUP\DESKTOP-1$",
        r"NT AUTHORITY\LOCAL SERVICE",
        r"NT AUTHORITY\NETWORK SERVICE",
        "",
    ] {
        assert!(
            windows::logon_task(binary, account).is_err(),
            "accepted {account:?}"
        );
    }
    for path in [r"floti.exe", r"bin\floti.exe", "/opt/floti"] {
        let err = windows::logon_task(Path::new(path), WINDOWS_USER).unwrap_err();
        assert!(err.to_string().contains("not absolute"), "{err}");
    }
    assert!(windows::logon_task(Path::new(r"\\server\share\floti.exe"), WINDOWS_USER).is_ok());
}

#[test]
fn windows_definition_escapes_the_path_and_is_written_as_utf16() {
    let def = windows::logon_task(Path::new(r"C:\R&D <tools>\floti.exe"), WINDOWS_USER).unwrap();
    assert!(
        def.contents
            .contains(r#"<Command>"C:\R&amp;D &lt;tools&gt;\floti.exe"</Command>"#),
        "{}",
        def.contents
    );

    let bytes = def.file_bytes();
    assert_eq!(&bytes[..2], &[0xFF, 0xFE], "UTF-16LE byte order mark");
    let units: Vec<u16> = bytes[2..]
        .as_chunks::<2>()
        .0
        .iter()
        .map(|&pair| u16::from_le_bytes(pair))
        .collect();
    assert_eq!(String::from_utf16(&units).unwrap(), def.contents);
    assert!(
        def.contents
            .starts_with(r#"<?xml version="1.0" encoding="UTF-16"?>"#)
    );
}

#[test]
fn macos_definition_is_a_launch_agent_that_runs_the_path_as_one_argument() {
    let def = macos::launch_agent(Path::new(UNIX_BINARY)).unwrap();
    assert_eq!(def.kind, StartupKind::LaunchAgent);
    assert_eq!(def.name, "dev.floti.host");
    assert_eq!(def.file_name, "dev.floti.host.plist");
    assert_eq!(def.user_folder, Some("Library/LaunchAgents"));
    let plist = &def.contents;

    assert!(
        plist.contains("<key>Label</key>\n\t<string>dev.floti.host</string>"),
        "{plist}"
    );
    // The path is one element of ProgramArguments, spaces and all, then `host`.
    let args = section(plist, "array");
    assert_eq!(
        args.matches("<string>").count(),
        2,
        "two arguments in:\n{args}"
    );
    assert!(
        args.contains("<string>/opt/Floti App/bin/floti</string>\n\t\t<string>host</string>"),
        "{args}"
    );
    assert!(plist.contains("<key>RunAtLoad</key>\n\t<true/>"), "{plist}");
    assert!(
        plist.contains("<key>LimitLoadToSessionType</key>\n\t<string>Aqua</string>"),
        "{plist}"
    );

    // Never a LaunchDaemon: no user or group to run as, no system folder.
    for absent in [
        "LaunchDaemons",
        "<key>UserName</key>",
        "<key>GroupName</key>",
        "<key>InitGroups</key>",
        "root",
    ] {
        assert!(!plist.contains(absent), "found {absent} in:\n{plist}");
    }
}

#[test]
fn macos_definition_escapes_the_path_and_refuses_a_relative_one() {
    let def = macos::launch_agent(Path::new("/Users/someone/R&D <x>/floti")).unwrap();
    assert!(
        def.contents
            .contains("<string>/Users/someone/R&amp;D &lt;x&gt;/floti</string>"),
        "{}",
        def.contents
    );
    assert_eq!(def.file_bytes(), def.contents.as_bytes());
    assert!(macos::launch_agent(Path::new("bin/floti")).is_err());
    assert!(macos::launch_agent(Path::new("/opt/floti\nhost")).is_err());
}

#[test]
fn linux_definition_is_a_user_unit_wanted_by_default_target_with_the_path_quoted() {
    let def = linux::user_unit(Path::new(UNIX_BINARY)).unwrap();
    assert_eq!(def.kind, StartupKind::SystemdUserUnit);
    assert_eq!(def.name, "floti.service");
    assert_eq!(def.file_name, "floti.service");
    assert_eq!(def.user_folder, Some(".config/systemd/user"));
    let unit = &def.contents;

    let exec: Vec<&str> = unit
        .lines()
        .filter(|line| line.starts_with("ExecStart="))
        .collect();
    assert_eq!(
        exec,
        [r#"ExecStart="/opt/Floti App/bin/floti" host"#],
        "{unit}"
    );

    let wanted: Vec<&str> = unit
        .lines()
        .filter(|line| line.starts_with("WantedBy="))
        .collect();
    assert_eq!(wanted, ["WantedBy=default.target"], "{unit}");

    for absent in [
        "User=",
        "Group=",
        "multi-user.target",
        "graphical.target",
        "sysinit.target",
        "RequiredBy=",
    ] {
        assert!(!unit.contains(absent), "found {absent} in:\n{unit}");
    }
}

#[test]
fn linux_definition_escapes_what_systemd_would_expand() {
    let def = linux::user_unit(Path::new(r#"/home/someone/50% "$HOME" \x/floti"#)).unwrap();
    assert!(
        def.contents
            .contains(r#"ExecStart="/home/someone/50%% \"$$HOME\" \\x/floti" host"#),
        "{}",
        def.contents
    );
    assert_eq!(def.file_bytes(), def.contents.as_bytes());
    assert!(linux::user_unit(Path::new("floti")).is_err());
    assert!(linux::user_unit(Path::new("/opt/floti\nExecStartPre=/bin/x")).is_err());
}

#[test]
fn native_definition_runs_this_binary() {
    let binary = std::env::current_exe().unwrap();
    let def = super::Native.definition(&binary).unwrap();
    assert!(!def.contents.is_empty());
    assert!(def.contents.contains("host"));
}

/// Generating a definition registers nothing: the generators compose text and
/// reach neither the file system, nor a process, nor the OS's own tools.
#[test]
fn generating_any_definition_registers_nothing_with_the_os() {
    let sources = [
        ("mod.rs", include_str!("mod.rs")),
        ("windows.rs", include_str!("windows.rs")),
        ("macos.rs", include_str!("macos.rs")),
        ("linux.rs", include_str!("linux.rs")),
    ];
    let forbidden = [
        "std::process",
        "Command::new",
        "std::fs",
        "fs::",
        "tokio::",
        "std::net",
        "unsafe",
        "windows_sys",
        "libc::",
        "schtasks",
        "launchctl",
        "systemctl",
    ];
    for (file, source) in sources {
        for (number, line) in source.lines().enumerate() {
            for word in forbidden {
                assert!(
                    !line.contains(word),
                    "startup/{file}:{} uses {word}: {line}",
                    number + 1
                );
            }
        }
    }
}

fn env_with(vars: &[(&str, &str)]) -> crate::platform::folders::UserEnv {
    crate::platform::folders::UserEnv {
        home: None,
        vars: vars
            .iter()
            .map(|(name, value)| ((*name).into(), (*value).into()))
            .collect(),
    }
}

/// One sentence, ending at the only full stop, that says where the host
/// starts.
fn assert_one_sentence_about_sign_in(refusal: &str) {
    assert!(
        refusal.starts_with("The Floti host starts at your sign-in"),
        "{refusal}"
    );
    assert_eq!(refusal.matches(". ").count(), 0, "{refusal}");
    assert!(refusal.ends_with('.'), "{refusal}");
}

#[test]
fn s5_a_start_from_an_ssh_session_is_refused_in_one_sentence() {
    for name in ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"] {
        let refusal = super::launch_refusal(
            &env_with(&[(name, "203.0.113.9 50022 192.0.2.1 22")]),
            super::Account::User,
        )
        .unwrap_or_else(|| panic!("{name} set, yet the host would start"));
        assert_one_sentence_about_sign_in(&refusal);
        assert!(refusal.contains("SSH"), "{refusal}");
    }
    assert_eq!(
        super::launch_refusal(&env_with(&[("SSH_CONNECTION", "")]), super::Account::User),
        None,
        "an empty variable is no SSH session"
    );
}

#[test]
fn s5_a_start_as_root_or_a_service_account_is_refused_in_one_sentence() {
    for name in ["root", "the SYSTEM account"] {
        let refusal = super::launch_refusal(&env_with(&[]), super::Account::Privileged(name))
            .unwrap_or_else(|| panic!("running as {name}, yet the host would start"));
        assert_one_sentence_about_sign_in(&refusal);
        assert!(refusal.contains(name), "{refusal}");
    }
}

#[test]
fn s5_a_start_at_the_users_sign_in_is_not_refused() {
    assert_eq!(
        super::launch_refusal(&env_with(&[]), super::Account::User),
        None
    );
    assert_eq!(
        super::launch_refusal(&env_with(&[]), super::Account::Unknown),
        None
    );
    // The tests run as an ordinary user, never root or a service account.
    assert!(
        !matches!(super::account(), super::Account::Privileged(_)),
        "{:?}",
        super::account()
    );
}
