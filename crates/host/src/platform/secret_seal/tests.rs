use super::*;

#[test]
fn a_key_seal_round_trips_and_never_holds_the_value_in_the_clear() {
    let seal = KeySeal::new(&KeySeal::random_key().unwrap());
    let plain = b"s3cret value";
    let sealed = seal.seal(plain).unwrap();
    assert!(!sealed.windows(plain.len()).any(|window| window == plain));
    assert_eq!(seal.unseal(&sealed).unwrap(), plain);
    assert_ne!(
        seal.seal(plain).unwrap(),
        sealed,
        "every seal has its own nonce"
    );
    assert_eq!(format!("{seal:?}"), "KeySeal(..)");
}

#[test]
fn a_key_seal_refuses_what_another_key_sealed_or_what_was_changed() {
    let seal = KeySeal::new(&KeySeal::random_key().unwrap());
    let other = KeySeal::new(&KeySeal::random_key().unwrap());
    let sealed = seal.seal(b"value").unwrap();
    assert!(matches!(other.unseal(&sealed), Err(SealError::Failed(_))));
    let mut changed = sealed.clone();
    *changed.last_mut().unwrap() ^= 1;
    assert!(seal.unseal(&changed).is_err());
    assert!(seal.unseal(&[]).is_err());
    assert!(seal.unseal(&sealed[..10]).is_err());
}

#[test]
fn a_stored_key_is_read_back_only_when_it_is_one() {
    let key = KeySeal::random_key().unwrap();
    let sealed = KeySeal::new(&key).seal(b"value").unwrap();
    let again = KeySeal::from_stored(&key).unwrap();
    assert_eq!(again.unseal(&sealed).unwrap(), b"value");
    assert!(KeySeal::from_stored(&key[..31]).is_none());
}

#[test]
fn with_no_store_nothing_is_sealed() {
    assert!(!Unavailable.available());
    assert_eq!(Unavailable.seal(b"v"), Err(SealError::Unavailable));
    assert_eq!(Unavailable.unseal(b"v"), Err(SealError::Unavailable));
}

#[test]
fn an_installed_host_keeps_todays_store_entry() {
    let entry = StoreEntry::installed();
    assert_eq!(entry.keychain_service(), "Floti");
    assert_eq!(entry.keychain_account(), "plugin-secrets-key");
    assert_eq!(
        entry.secret_service_attributes(),
        [
            ("application", "floti".to_owned()),
            ("purpose", "plugin-secrets-key".to_owned()),
        ]
    );
    assert_eq!(entry.secret_service_label(), "Floti plugin secrets key");
}

#[test]
fn each_moved_data_folder_has_a_store_entry_of_its_own_every_time() {
    let one = std::path::Path::new("/home/someone/dev one/helm-data");
    let two = std::path::Path::new("/home/someone/dev two/helm-data");
    let installed = StoreEntry::installed();
    let first = StoreEntry::for_moved_data_folder(one);
    let second = StoreEntry::for_moved_data_folder(two);

    assert_eq!(first, StoreEntry::for_moved_data_folder(one), "stable");
    assert_eq!(second, StoreEntry::for_moved_data_folder(two), "stable");
    for (entry, folder) in [(&first, one), (&second, two)] {
        let tag = data_folder_tag(folder);
        assert_eq!(entry.keychain_service(), "Floti");
        assert_eq!(
            entry.keychain_account(),
            format!("plugin-secrets-key-{tag}")
        );
        assert_eq!(
            entry.secret_service_attributes(),
            [
                ("application", "floti".to_owned()),
                ("purpose", format!("plugin-secrets-key-{tag}")),
            ]
        );
        assert!(entry.secret_service_label().contains(&tag));
        assert_ne!(entry.keychain_account(), installed.keychain_account());
        assert_ne!(
            entry.secret_service_label(),
            installed.secret_service_label()
        );
    }
    assert_ne!(first.keychain_account(), second.keychain_account());
    assert_ne!(
        first.secret_service_attributes(),
        second.secret_service_attributes()
    );
}

#[test]
fn a_moved_folders_secret_service_purpose_is_never_the_installed_hosts() {
    // The Secret Service finds items holding at least the attributes asked
    // for, so a moved folder's entry must differ in a value, not by an extra
    // attribute, or the installed host's search would find it.
    let installed = StoreEntry::installed().secret_service_attributes();
    let moved = StoreEntry::for_moved_data_folder(std::path::Path::new("/tmp/data"))
        .secret_service_attributes();
    let keys = |attributes: &[(&'static str, String); 2]| [attributes[0].0, attributes[1].0];
    assert_eq!(keys(&moved), keys(&installed));
    assert_eq!(moved[1].0, "purpose");
    assert_ne!(moved[1].1, installed[1].1);
    assert!(!installed.iter().all(|wanted| moved.contains(wanted)));
}

#[test]
fn a_data_folder_tag_follows_the_launchers_rule() {
    // The launcher names a socket folder with the first twelve hex
    // characters of the SHA-256 of the data folder's path.
    assert_eq!(data_folder_tag(std::path::Path::new("abc")), "ba7816bf8f01");
    let folder =
        std::path::Path::new("/Users/someone/Library/Application Support/Helm Dev/dev/helm-data");
    let tag = data_folder_tag(folder);
    assert_eq!(tag.len(), 12);
    assert!(
        tag.chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
    );
    assert_eq!(
        tag,
        crate::config_console::sha256_hex(folder.to_string_lossy().as_bytes())[..12]
    );
}
