//! Whether the bytes a client sent into a session are a person typing.
//!
//! A terminal answers its program's queries on the same stream a person's keys
//! come on: a cursor position, the device attributes, a colour, a focus change
//! or a mouse report. None of those leaves anything in the program's prompt
//! box, so none of them is a person having typed there. Nothing else is
//! looked at: any other byte counts, whatever it means to the program.

/// Whether `bytes` hold anything but a terminal's own replies.
pub(super) fn is_a_person_typing(bytes: &[u8]) -> bool {
    let mut rest = bytes;
    if rest.is_empty() {
        return false;
    }
    while !rest.is_empty() {
        match reply_len(rest) {
            Some(len) => rest = &rest[len..],
            None => return true,
        }
    }
    false
}

/// The length of the terminal reply `bytes` begin with, if they begin with one.
fn reply_len(bytes: &[u8]) -> Option<usize> {
    match bytes {
        [0x1b, b'[', body @ ..] => control_sequence_len(body).map(|len| len + 2),
        [0x1b, b']' | b'P', body @ ..] => string_len(body).map(|len| len + 2),
        _ => None,
    }
}

/// A control sequence's length after `ESC [`, when it is one a terminal
/// answers with: focus in and out, a report (cursor position, device
/// attributes, status, mode, window) or a mouse report.
fn control_sequence_len(body: &[u8]) -> Option<usize> {
    let end = body.iter().position(|byte| (0x40..=0x7e).contains(byte))?;
    let (parameters, last) = (&body[..end], body[end]);
    let plain = parameters
        .iter()
        .all(|byte| byte.is_ascii_digit() || matches!(byte, b';' | b'?' | b'>' | b'<' | b'$'));
    let reply = match last {
        b'I' | b'O' => parameters.is_empty(),
        b'c' | b'R' | b'n' | b't' | b'y' => plain,
        b'M' | b'm' => plain && parameters.first() == Some(&b'<'),
        _ => false,
    };
    reply.then_some(end + 1)
}

/// The length of an OSC or DCS string after `ESC ]` or `ESC P`, up to and
/// including its terminator (BEL or `ESC \`).
fn string_len(body: &[u8]) -> Option<usize> {
    body.iter().enumerate().find_map(|(at, byte)| match byte {
        0x07 => Some(at + 1),
        0x1b if body.get(at + 1) == Some(&b'\\') => Some(at + 2),
        _ => None,
    })
}

#[cfg(test)]
mod tests {
    use super::is_a_person_typing;

    #[test]
    fn keys_are_a_person_typing() {
        for keys in [
            &b"a"[..],
            b"hello\r",
            b"\x1b",
            b"\x1b[A",
            b"\x1b[200~pasted\x1b[201~",
            b"\r",
            b"\x7f",
            "é".as_bytes(),
        ] {
            assert!(is_a_person_typing(keys), "{keys:?}");
        }
    }

    #[test]
    fn a_terminals_own_replies_are_not() {
        for reply in [
            &b""[..],
            b"\x1b[I",
            b"\x1b[O",
            b"\x1b[12;40R",
            b"\x1b[?62;4c",
            b"\x1b[>0;276;0c",
            b"\x1b[0n",
            b"\x1b[?2004;2$y",
            b"\x1b[8;40;120t",
            b"\x1b[<0;12;3M",
            b"\x1b[<0;12;3m",
            b"\x1b]11;rgb:0000/0000/0000\x07",
            b"\x1b]10;rgb:ffff/ffff/ffff\x1b\\",
            b"\x1bP>|xterm.js(5)\x1b\\",
            b"\x1b[I\x1b[12;40R\x1b[?62;4c",
        ] {
            assert!(!is_a_person_typing(reply), "{reply:?}");
        }
    }

    #[test]
    fn a_reply_with_a_key_after_it_is_a_person_typing() {
        assert!(is_a_person_typing(b"\x1b[12;40Rx"));
        assert!(is_a_person_typing(b"x\x1b[I"));
        // An unfinished sequence is not a reply.
        assert!(is_a_person_typing(b"\x1b[12;4"));
    }
}
