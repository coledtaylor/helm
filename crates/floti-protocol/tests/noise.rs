//! Every connection runs a Noise session: the device proves its key, the host
//! proves the key the device pinned, and every byte after travels sealed.

use floti_protocol::message::{ClientInfo, ClientKind, Hello, StreamData};
use floti_protocol::noise::{
    Initiator, InitiatorStep, KeyPair, MAX_MESSAGE_LEN, MAX_PLAINTEXT_LEN, NoiseError, Opener,
    PendingDevice, PrivateKey, PublicKey, Responder, ResponderStep, Sealer, TAG_LEN, Transport,
};
use floti_protocol::{Bytes, FrameDecoder, Message, ProtocolVersion, encode_frame};

fn keys() -> KeyPair {
    KeyPair::generate().expect("a key pair")
}

/// The host's side up to the point it learns who is connecting.
fn receive(host: &KeyPair, message_1: &[u8]) -> Result<PendingDevice, NoiseError> {
    match Responder::new(host).expect("a responder").push(message_1)? {
        ResponderStep::Received { device, used } => {
            assert_eq!(used, message_1.len());
            Ok(device)
        }
        ResponderStep::Pending(_) => panic!("the whole first message did not complete it"),
    }
}

fn finish(initiator: Initiator, message_2: &[u8]) -> Result<Transport, NoiseError> {
    match initiator.push(message_2)? {
        InitiatorStep::Done { transport, used } => {
            assert_eq!(used, message_2.len());
            Ok(transport)
        }
        InitiatorStep::Pending(_) => panic!("the whole answer did not complete it"),
    }
}

/// A device and a host that completed a handshake: (device, host).
fn session(device: &KeyPair, host: &KeyPair) -> (Transport, Transport) {
    let (initiator, message_1) = Initiator::start(device, &host.public()).expect("a start");
    let pending = receive(host, &message_1).expect("the host reads the first message");
    let (host_side, message_2) = pending.accept().expect("the host answers");
    let device_side = finish(initiator, &message_2).expect("the device checks the answer");
    (device_side, host_side)
}

fn hello_frame() -> Vec<u8> {
    let hello = Message::Hello(Hello {
        protocol: ProtocolVersion::new(1, 0),
        client: ClientInfo {
            name: "test".into(),
            kind: ClientKind::Desktop,
        },
        capabilities: vec!["terminal".into()],
    });
    encode_frame(&hello).expect("an encodable hello")
}

/// A deterministic spread of chunk sizes, from one byte up.
fn split_unevenly(bytes: &[u8]) -> Vec<&[u8]> {
    let mut chunks = Vec::new();
    let mut seed: u32 = 0x9e37_79b9;
    let mut rest = bytes;
    while !rest.is_empty() {
        seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        let len = (seed >> 16) as usize % 7000 + 1;
        let (chunk, tail) = rest.split_at(len.min(rest.len()));
        chunks.push(chunk);
        rest = tail;
    }
    chunks
}

#[test]
fn a_handshake_completes_and_both_directions_round_trip() {
    let device = keys();
    let host = keys();
    let (mut device_side, mut host_side) = session(&device, &host);

    assert_eq!(device_side.peer(), host.public());
    assert_eq!(host_side.peer(), device.public());

    let hello = hello_frame();
    let sealed = device_side.seal(&hello).unwrap();
    assert_ne!(
        &sealed[2..],
        hello.as_slice(),
        "the hello travels encrypted"
    );
    assert_eq!(host_side.open(&sealed).unwrap(), hello);

    let answer = b"welcome, and the bytes of a terminal \x1b[31m\xff\x00".to_vec();
    let sealed = host_side.seal(&answer).unwrap();
    assert_eq!(device_side.open(&sealed).unwrap(), answer);

    for round in 0..5u8 {
        let up = vec![round; 100 + usize::from(round)];
        assert_eq!(host_side.open(&device_side.seal(&up).unwrap()).unwrap(), up);
        let down = vec![255 - round; 50];
        assert_eq!(
            device_side.open(&host_side.seal(&down).unwrap()).unwrap(),
            down
        );
    }
    device_side.finish().unwrap();
    host_side.finish().unwrap();
}

#[test]
fn the_host_learns_the_device_key_from_the_first_message() {
    let device = keys();
    let host = keys();
    let (_, message_1) = Initiator::start(&device, &host.public()).unwrap();
    let pending = receive(&host, &message_1).unwrap();
    assert_eq!(pending.device_key(), device.public());
}

#[test]
fn a_frame_larger_than_one_noise_message_spans_several() {
    let device = keys();
    let host = keys();
    let (mut device_side, mut host_side) = session(&device, &host);

    let data: Vec<u8> = (0..3 * MAX_PLAINTEXT_LEN + 1234)
        .map(|i| (i % 251) as u8)
        .collect();
    let frame = encode_frame(&Message::StreamData(StreamData {
        stream: 7,
        data: Bytes::from(data.clone()),
    }))
    .unwrap();
    assert!(frame.len() > MAX_MESSAGE_LEN);

    let sealed = host_side.seal(&frame).unwrap();
    let messages = frame.len().div_ceil(MAX_PLAINTEXT_LEN);
    assert_eq!(messages, 4);
    assert_eq!(sealed.len(), frame.len() + messages * (2 + TAG_LEN));
    let first_len = usize::from(u16::from_be_bytes([sealed[0], sealed[1]]));
    assert_eq!(first_len, MAX_MESSAGE_LEN);

    let opened = device_side.open(&sealed).unwrap();
    assert_eq!(opened, frame);
    let mut decoder = FrameDecoder::new();
    decoder.push(&opened);
    match decoder.next_message().unwrap().unwrap() {
        Message::StreamData(back) => assert_eq!(back.data.as_slice(), data.as_slice()),
        other => panic!("not stream data: {other:?}"),
    }
}

#[test]
fn bytes_delivered_one_at_a_time_complete_the_handshake_and_open() {
    let device = keys();
    let host = keys();
    let (mut initiator, message_1) = Initiator::start(&device, &host.public()).unwrap();

    let mut responder = Responder::new(&host).unwrap();
    let mut pending = None;
    for (i, byte) in message_1.iter().enumerate() {
        match responder.push(std::slice::from_ref(byte)).unwrap() {
            ResponderStep::Pending(next) => responder = next,
            ResponderStep::Received { device, used } => {
                assert_eq!(i, message_1.len() - 1, "complete only on the last byte");
                assert_eq!(used, 1);
                pending = Some(device);
                break;
            }
        }
    }
    let (mut host_side, message_2) = pending.expect("received").accept().unwrap();

    let mut device_side = None;
    for (i, byte) in message_2.iter().enumerate() {
        match initiator.push(std::slice::from_ref(byte)).unwrap() {
            InitiatorStep::Pending(next) => initiator = next,
            InitiatorStep::Done { transport, used } => {
                assert_eq!(i, message_2.len() - 1);
                assert_eq!(used, 1);
                device_side = Some(transport);
                break;
            }
        }
    }
    let mut device_side = device_side.expect("done");

    let plaintext: Vec<u8> = (0..MAX_PLAINTEXT_LEN + 300)
        .map(|i| (i % 253) as u8)
        .collect();
    let sealed = device_side.seal(&plaintext).unwrap();
    let mut opened = Vec::new();
    for byte in &sealed {
        opened.extend(host_side.open(std::slice::from_ref(byte)).unwrap());
        assert!(host_side.buffered() <= 2 + MAX_MESSAGE_LEN);
    }
    assert_eq!(opened, plaintext);
    host_side.finish().unwrap();
}

#[test]
fn a_stream_split_anywhere_opens_to_the_same_plaintext() {
    let (mut device_side, host_side) = session(&keys(), &keys());
    let (_, mut opener): (Sealer, Opener) = host_side.split();

    let mut plaintext = Vec::new();
    let mut sealed = Vec::new();
    for size in [
        1,
        17,
        MAX_PLAINTEXT_LEN,
        5,
        2 * MAX_PLAINTEXT_LEN + 3,
        0,
        900,
    ] {
        let piece: Vec<u8> = (0..size).map(|i| (i * 7 % 256) as u8).collect();
        sealed.extend(device_side.seal(&piece).unwrap());
        plaintext.extend(piece);
    }
    let mut opened = Vec::new();
    for chunk in split_unevenly(&sealed) {
        opened.extend(opener.open(chunk).unwrap());
    }
    assert_eq!(opened, plaintext);
    opener.finish().unwrap();
}

#[test]
fn bytes_after_the_handshake_in_the_same_read_belong_to_the_transport() {
    let device = keys();
    let host = keys();
    let (initiator, message_1) = Initiator::start(&device, &host.public()).unwrap();
    let (mut host_side, mut from_host) = receive(&host, &message_1).unwrap().accept().unwrap();
    let message_2_len = from_host.len();
    from_host.extend(host_side.seal(b"right behind it").unwrap());

    let InitiatorStep::Done {
        mut transport,
        used,
    } = initiator.push(&from_host).unwrap()
    else {
        panic!("the answer was all there");
    };
    assert_eq!(used, message_2_len);
    assert_eq!(
        transport.open(&from_host[used..]).unwrap(),
        b"right behind it"
    );
}

#[test]
fn a_device_that_pinned_another_key_finds_the_host_unproven() {
    let device = keys();
    let pinned = keys();
    let actual_host = keys();

    // The host on the socket holds another key, so it cannot read the device's
    // first message at all.
    let (initiator, message_1) = Initiator::start(&device, &pinned.public()).unwrap();
    assert_eq!(
        receive(&actual_host, &message_1).unwrap_err(),
        NoiseError::FirstMessageUnreadable
    );

    // Whatever it answers instead, even a real answer made for another
    // session, does not prove the pinned key.
    let (_, other_message_1) = Initiator::start(&keys(), &actual_host.public()).unwrap();
    let (_, other_answer) = receive(&actual_host, &other_message_1)
        .unwrap()
        .accept()
        .unwrap();
    assert_eq!(
        initiator.push(&other_answer).unwrap_err(),
        NoiseError::HostNotProven
    );

    // An answer from the pinned key's holder, but to another device's
    // handshake, does not prove it to this one either.
    let (initiator, _) = Initiator::start(&device, &pinned.public()).unwrap();
    let (_, someone_else) = Initiator::start(&keys(), &pinned.public()).unwrap();
    let (_, their_answer) = receive(&pinned, &someone_else).unwrap().accept().unwrap();
    assert_eq!(
        initiator.push(&their_answer).unwrap_err(),
        NoiseError::HostNotProven
    );

    // Nor does an answer of the wrong length, as soon as its prefix arrives.
    let (initiator, _) = Initiator::start(&device, &pinned.public()).unwrap();
    assert_eq!(
        initiator.push(&[0x00, 0x05]).unwrap_err(),
        NoiseError::HostNotProven
    );
}

#[test]
fn a_host_can_refuse_a_device_before_it_writes_message_2() {
    let registered = keys();
    let stranger = keys();
    let host = keys();
    let registry = [registered.public()];

    let (mut initiator, message_1) = Initiator::start(&stranger, &host.public()).unwrap();
    let pending = receive(&host, &message_1).unwrap();
    assert_eq!(pending.device_key(), stranger.public());
    assert!(!registry.contains(&pending.device_key()));
    // Refusing is dropping it: no answer exists to send.
    drop(pending);

    // The device, given nothing, is still waiting for an answer.
    initiator = match initiator.push(&[]).unwrap() {
        InitiatorStep::Pending(next) => next,
        InitiatorStep::Done { .. } => panic!("done with no answer"),
    };
    drop(initiator);

    let (_, message_1) = Initiator::start(&registered, &host.public()).unwrap();
    let pending = receive(&host, &message_1).unwrap();
    assert!(registry.contains(&pending.device_key()));
}

#[test]
fn a_first_message_that_is_not_a_handshake_fails_at_once() {
    let host = keys();

    // A plain hello frame, as clients sent before: its 4-byte prefix reads as
    // a message of the wrong length.
    let hello = hello_frame();
    assert!(matches!(
        Responder::new(&host).unwrap().push(&hello),
        Err(NoiseError::FirstMessageUnreadable)
    ));

    // Random bytes behind the right length do not decrypt.
    let mut noise = vec![0x00, 96];
    noise.extend((0..96u32).map(|i| (i.wrapping_mul(2_654_435_761) >> 24) as u8));
    assert!(matches!(
        Responder::new(&host).unwrap().push(&noise),
        Err(NoiseError::FirstMessageUnreadable)
    ));

    // A real first message with one byte changed does not either.
    let (_, mut message_1) = Initiator::start(&keys(), &host.public()).unwrap();
    message_1[40] ^= 0x01;
    assert_eq!(
        receive(&host, &message_1).unwrap_err(),
        NoiseError::FirstMessageUnreadable
    );
}

#[test]
fn tampered_ciphertext_fails_and_the_session_stays_failed() {
    let (mut device_side, mut host_side) = session(&keys(), &keys());

    let mut sealed = device_side.seal(b"rm -rf nothing").unwrap();
    let last = sealed.len() - 1;
    sealed[last] ^= 0x80;
    assert_eq!(
        host_side.open(&sealed).unwrap_err(),
        NoiseError::Unauthenticated
    );

    let good = device_side.seal(b"an honest message").unwrap();
    assert_eq!(
        host_side.open(&good).unwrap_err(),
        NoiseError::Unauthenticated
    );
    assert_eq!(host_side.finish().unwrap_err(), NoiseError::Unauthenticated);
    assert_eq!(host_side.buffered(), 0);
}

#[test]
fn a_replayed_or_reordered_message_does_not_authenticate() {
    let (mut device_side, mut host_side) = session(&keys(), &keys());
    let first = device_side.seal(b"one").unwrap();
    assert_eq!(host_side.open(&first).unwrap(), b"one");
    assert_eq!(
        host_side.open(&first).unwrap_err(),
        NoiseError::Unauthenticated
    );

    let (mut device_side, mut host_side) = session(&keys(), &keys());
    let first = device_side.seal(b"one").unwrap();
    let second = device_side.seal(b"two").unwrap();
    assert_eq!(
        host_side.open(&second).unwrap_err(),
        NoiseError::Unauthenticated
    );
    assert_eq!(
        host_side.open(&first).unwrap_err(),
        NoiseError::Unauthenticated
    );
}

#[test]
fn a_stream_that_ends_inside_a_message_is_truncated() {
    let (mut device_side, mut host_side) = session(&keys(), &keys());
    let sealed = device_side.seal(b"cut short").unwrap();
    assert!(
        host_side
            .open(&sealed[..sealed.len() - 3])
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        host_side.finish().unwrap_err(),
        NoiseError::Truncated {
            partial: sealed.len() - 3
        }
    );
}

#[test]
fn two_sessions_between_the_same_keys_seal_differently() {
    let device = keys();
    let host = keys();
    let (mut first, _) = session(&device, &host);
    let (mut second, _) = session(&device, &host);
    let plaintext = hello_frame();
    assert_ne!(
        first.seal(&plaintext).unwrap(),
        second.seal(&plaintext).unwrap()
    );

    let (_, message_1) = Initiator::start(&device, &host.public()).unwrap();
    let (_, again) = Initiator::start(&device, &host.public()).unwrap();
    assert_ne!(message_1, again, "each handshake has a fresh ephemeral key");
}

#[test]
fn a_session_opens_only_what_its_own_keys_sealed() {
    let device = keys();
    let host = keys();
    let (mut first, _) = session(&device, &host);
    let (_, mut second_host) = session(&device, &host);
    let sealed = first.seal(b"for the first session").unwrap();
    assert_eq!(
        second_host.open(&sealed).unwrap_err(),
        NoiseError::Unauthenticated
    );
}

#[test]
fn a_private_key_never_prints_itself() {
    let pair = keys();
    let secret_hex: String = pair
        .private()
        .expose_secret()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    for printed in [
        format!("{:?}", pair.private()),
        format!("{pair:?}"),
        format!("{:#?}", pair),
    ] {
        assert!(printed.contains("redacted"), "{printed}");
        assert!(!printed.contains(&secret_hex), "{printed}");
        assert!(!printed.contains(&secret_hex[..16]), "{printed}");
    }
}

#[test]
fn a_public_key_has_a_short_fingerprint_and_a_hex_form() {
    let pair = keys();
    let public = pair.public();
    let hex = public.to_hex();
    assert_eq!(hex.len(), 64);
    assert_eq!(public.to_string(), hex);
    assert_eq!(public.fingerprint().len(), 16);
    assert!(hex.starts_with(&public.fingerprint()));
    assert_eq!(
        format!("{public:?}"),
        format!("PublicKey({})", public.fingerprint())
    );

    assert_eq!(hex.parse::<PublicKey>().unwrap(), public);
    assert_eq!(hex.to_uppercase().parse::<PublicKey>().unwrap(), public);
    for bad in [
        "",
        "abc",
        &hex[..62],
        &format!("{}zz", &hex[..62]),
        &format!("{hex}00"),
    ] {
        assert_eq!(
            bad.parse::<PublicKey>().unwrap_err(),
            NoiseError::InvalidKey
        );
    }

    let json = serde_json::to_string(&public).unwrap();
    assert_eq!(json, format!("\"{hex}\""));
    assert_eq!(serde_json::from_str::<PublicKey>(&json).unwrap(), public);
}

#[test]
fn a_stored_private_key_gives_back_its_pair() {
    let pair = keys();
    let stored = PrivateKey::from_bytes(*pair.private().expose_secret());
    let again = KeyPair::from_private(stored).unwrap();
    assert_eq!(again.public(), pair.public());
    assert_ne!(keys().public(), pair.public());

    // The loaded pair completes a handshake as the original.
    let host = keys();
    let (device_side, host_side) = session(&again, &host);
    assert_eq!(host_side.peer(), pair.public());
    assert_eq!(device_side.peer(), host.public());
}

#[test]
fn the_halves_of_a_session_can_move_to_other_threads() {
    fn sendable<T: Send + 'static>() {}
    sendable::<Sealer>();
    sendable::<Opener>();
    sendable::<Transport>();
    sendable::<Initiator>();
    sendable::<Responder>();
    sendable::<PendingDevice>();
}
