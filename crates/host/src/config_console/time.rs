//! Timestamps the console's answers carry, in the ISO form today's app sends
//! (`new Date().toISOString()`).

use std::time::{SystemTime, UNIX_EPOCH};

/// Now, as `2026-10-27T14:30:05.123Z`.
pub fn now_iso() -> String {
    iso(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |at| at.as_millis() as u64))
}

/// Epoch ms as an ISO timestamp in UTC.
pub fn iso(epoch_ms: u64) -> String {
    let days = (epoch_ms / 86_400_000) as i64;
    let in_day = epoch_ms % 86_400_000;
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        in_day / 3_600_000,
        in_day / 60_000 % 60,
        in_day / 1_000 % 60,
        in_day % 1_000
    )
}

/// The proleptic Gregorian date `days` after 1970-01-01 (Howard Hinnant's
/// `civil_from_days`).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn epoch_ms_read_as_javascript_writes_them() {
        assert_eq!(iso(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso(1_793_133_053_462), "2026-10-27T20:30:53.462Z");
        assert_eq!(iso(951_782_400_000), "2000-02-29T00:00:00.000Z");
    }
}
