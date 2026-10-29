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
