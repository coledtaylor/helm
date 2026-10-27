//! ISO 8601 instants, as Claude Code writes them, to epoch milliseconds.
//!
//! Transcripts write `2026-08-10T08:10:00.721Z`; the cached usage figures
//! write `2026-08-10T08:10:00.721285+00:00`. Anything that does not parse is
//! `None` rather than a guess.

/// `text` as epoch milliseconds, or `None` when it is not an instant.
pub fn parse_instant(text: &str) -> Option<u64> {
    let bytes = text.as_bytes();
    let digits = |from: usize, len: usize| -> Option<i64> {
        let part = text.get(from..from + len)?;
        part.bytes()
            .all(|b| b.is_ascii_digit())
            .then(|| part.parse().ok())
            .flatten()
    };
    if bytes.len() < 19 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    if !matches!(bytes[10], b'T' | b't' | b' ') || bytes[13] != b':' || bytes[16] != b':' {
        return None;
    }
    let (year, month, day) = (digits(0, 4)?, digits(5, 2)?, digits(8, 2)?);
    let (hour, minute, second) = (digits(11, 2)?, digits(14, 2)?, digits(17, 2)?);
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || minute > 59 {
        return None;
    }
    if second > 60 {
        return None;
    }

    let mut at = 19;
    let mut millis = 0i64;
    if bytes.get(at) == Some(&b'.') {
        at += 1;
        let start = at;
        while bytes.get(at).is_some_and(u8::is_ascii_digit) {
            at += 1;
        }
        if at == start {
            return None;
        }
        let fraction = &text[start..at.min(start + 3)];
        millis = fraction.parse::<i64>().ok()? * 10i64.pow(3 - fraction.len() as u32);
    }

    let offset_minutes = match bytes.get(at) {
        Some(b'Z' | b'z') if at + 1 == bytes.len() => 0,
        Some(sign @ (b'+' | b'-')) if bytes.len() == at + 6 && bytes[at + 3] == b':' => {
            let minutes = digits(at + 1, 2)? * 60 + digits(at + 4, 2)?;
            if *sign == b'+' { minutes } else { -minutes }
        }
        _ => return None,
    };

    let days = days_from_civil(year, month, day);
    let seconds = days * 86_400 + hour * 3_600 + minute * 60 + second - offset_minutes * 60;
    u64::try_from(seconds * 1_000 + millis).ok()
}

/// Days since 1970-01-01 of a proleptic Gregorian date.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let month_index = (month + 9) % 12;
    let day_of_year = (153 * month_index + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_forms_claude_code_writes() {
        assert_eq!(parse_instant("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(
            parse_instant("2026-08-10T08:10:00.721Z"),
            Some(1_786_349_400_721)
        );
        assert_eq!(
            parse_instant("2026-08-10T08:10:00.721285+00:00"),
            Some(1_786_349_400_721)
        );
        assert_eq!(
            parse_instant("2026-08-10T10:10:00+02:00"),
            Some(1_786_349_400_000)
        );
    }

    #[test]
    fn anything_else_is_none() {
        for text in [
            "",
            "yesterday",
            "2026-13-01T00:00:00Z",
            "2026-08-10",
            "2026-08-10T08:10:00",
        ] {
            assert_eq!(parse_instant(text), None, "{text}");
        }
    }
}
