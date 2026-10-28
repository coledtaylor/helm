//! A plugin's settings: whether a value fits its spec, as today's
//! `settingProblem` says it, and the values a page shows.

use std::collections::BTreeMap;

use floti_protocol::channels::plugins::{PluginSettingSpec, PluginSettingValue};

/// The longest text setting, in UTF-16 code units as a page counts them.
const TEXT_MAX: usize = 2000;

/// Integers up to here are kept as JSON integers, as today's store keeps a
/// page's numbers.
const SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// The setting's key.
pub fn key(spec: &PluginSettingSpec) -> &str {
    match spec {
        PluginSettingSpec::Text { key, .. }
        | PluginSettingSpec::Number { key, .. }
        | PluginSettingSpec::Toggle { key, .. }
        | PluginSettingSpec::Select { key, .. }
        | PluginSettingSpec::Secret { key, .. } => key,
    }
}

fn label(spec: &PluginSettingSpec) -> &str {
    match spec {
        PluginSettingSpec::Text { label, .. }
        | PluginSettingSpec::Number { label, .. }
        | PluginSettingSpec::Toggle { label, .. }
        | PluginSettingSpec::Select { label, .. }
        | PluginSettingSpec::Secret { label, .. } => label,
    }
}

/// Why `value` does not fit `spec`, or `None` when it does.
pub fn problem(spec: &PluginSettingSpec, value: &PluginSettingValue) -> Option<String> {
    let label = label(spec);
    match (spec, value) {
        (PluginSettingSpec::Text { .. }, PluginSettingValue::Text(text))
            if text.encode_utf16().count() <= TEXT_MAX =>
        {
            None
        }
        (PluginSettingSpec::Text { .. }, _) => Some(format!("{label} is text")),
        (PluginSettingSpec::Number { min, max, .. }, PluginSettingValue::Number(number))
            if number.is_finite() =>
        {
            if let Some(min) = min.filter(|min| number < min) {
                Some(format!("{label} is at least {}", js_number(min)))
            } else {
                max.filter(|max| number > max)
                    .map(|max| format!("{label} is at most {}", js_number(max)))
            }
        }
        (PluginSettingSpec::Number { .. }, _) => Some(format!("{label} is a number")),
        (PluginSettingSpec::Toggle { .. }, PluginSettingValue::Toggle(_)) => None,
        (PluginSettingSpec::Toggle { .. }, _) => Some(format!("{label} is on or off")),
        (PluginSettingSpec::Select { options, .. }, PluginSettingValue::Text(text))
            if options.iter().any(|option| &option.value == text) =>
        {
            None
        }
        (PluginSettingSpec::Select { .. }, _) => Some(format!("{label} is one of its options")),
        (PluginSettingSpec::Secret { .. }, _) => {
            Some(format!("{label} is a secret, stored in Settings > Secrets"))
        }
    }
}

/// A number as JavaScript's `String()` writes it, for the sentences above.
fn js_number(number: f64) -> String {
    if number.fract() == 0.0 && number.abs() <= SAFE_INTEGER {
        format!("{number:.0}")
    } else {
        number.to_string()
    }
}

/// The manifest's default for `spec`, or unset.
fn default_of(spec: &PluginSettingSpec) -> PluginSettingValue {
    let value = match spec {
        PluginSettingSpec::Text { default, .. } | PluginSettingSpec::Select { default, .. } => {
            default.clone().map(PluginSettingValue::Text)
        }
        PluginSettingSpec::Number { default, .. } => default.map(PluginSettingValue::Number),
        PluginSettingSpec::Toggle { default, .. } => default.map(PluginSettingValue::Toggle),
        PluginSettingSpec::Secret { .. } => None,
    };
    value.unwrap_or(PluginSettingValue::Unset)
}

/// A value as `plugin_settings` keeps it.
pub fn to_json(value: &PluginSettingValue) -> Option<serde_json::Value> {
    match value {
        PluginSettingValue::Unset => None,
        PluginSettingValue::Toggle(on) => Some((*on).into()),
        PluginSettingValue::Text(text) => Some(text.clone().into()),
        PluginSettingValue::Number(number)
            if number.fract() == 0.0 && number.abs() <= SAFE_INTEGER =>
        {
            // Exact: the value is a whole number within i64's range.
            #[allow(clippy::cast_possible_truncation)]
            Some((*number as i64).into())
        }
        PluginSettingValue::Number(number) => serde_json::Number::from_f64(*number).map(Into::into),
    }
}

/// A value `plugin_settings` holds, when it is one a setting can have.
fn from_json(value: &serde_json::Value) -> Option<PluginSettingValue> {
    match value {
        serde_json::Value::Bool(on) => Some(PluginSettingValue::Toggle(*on)),
        serde_json::Value::Number(number) => number.as_f64().map(PluginSettingValue::Number),
        serde_json::Value::String(text) => Some(PluginSettingValue::Text(text.clone())),
        _ => None,
    }
}

/// The values a page shows, for every setting but a secret: what the user
/// set when it still fits, else the manifest's default, else unset.
pub fn values(
    specs: &[PluginSettingSpec],
    stored: &BTreeMap<String, serde_json::Value>,
) -> BTreeMap<String, PluginSettingValue> {
    specs
        .iter()
        .filter(|spec| !matches!(spec, PluginSettingSpec::Secret { .. }))
        .map(|spec| {
            let set = stored
                .get(key(spec))
                .and_then(from_json)
                .filter(|value| problem(spec, value).is_none());
            (
                key(spec).to_owned(),
                set.unwrap_or_else(|| default_of(spec)),
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use floti_protocol::channels::plugins::PluginSelectOption;

    use super::*;

    fn number(min: Option<f64>, max: Option<f64>) -> PluginSettingSpec {
        PluginSettingSpec::Number {
            key: "interval".into(),
            label: "Interval".into(),
            description: None,
            default: Some(30.0),
            min,
            max,
        }
    }

    #[test]
    fn a_value_that_does_not_fit_is_said_as_today() {
        let text = PluginSettingSpec::Text {
            key: "url".into(),
            label: "Base URL".into(),
            description: None,
            default: None,
            placeholder: None,
        };
        assert_eq!(
            problem(&text, &PluginSettingValue::Number(1.0)).unwrap(),
            "Base URL is text"
        );
        assert_eq!(
            problem(&text, &PluginSettingValue::Text("x".repeat(2001))).unwrap(),
            "Base URL is text"
        );
        assert!(problem(&text, &PluginSettingValue::Text("x".repeat(2000))).is_none());
        let bounded = number(Some(5.0), Some(0.5e3));
        assert_eq!(
            problem(&bounded, &PluginSettingValue::Number(4.0)).unwrap(),
            "Interval is at least 5"
        );
        assert_eq!(
            problem(&bounded, &PluginSettingValue::Number(501.0)).unwrap(),
            "Interval is at most 500"
        );
        assert_eq!(
            problem(&number(Some(0.5), None), &PluginSettingValue::Number(0.25)).unwrap(),
            "Interval is at least 0.5"
        );
        assert_eq!(
            problem(&bounded, &PluginSettingValue::Text("6".into())).unwrap(),
            "Interval is a number"
        );
        let select = PluginSettingSpec::Select {
            key: "mode".into(),
            label: "Mode".into(),
            description: None,
            options: vec![PluginSelectOption {
                value: "fast".into(),
                label: "Fast".into(),
            }],
            default: None,
        };
        assert_eq!(
            problem(&select, &PluginSettingValue::Text("slow".into())).unwrap(),
            "Mode is one of its options"
        );
    }

    #[test]
    fn a_whole_number_is_kept_as_a_json_integer() {
        assert_eq!(
            to_json(&PluginSettingValue::Number(60.0))
                .unwrap()
                .to_string(),
            "60"
        );
        assert_eq!(
            to_json(&PluginSettingValue::Number(0.5))
                .unwrap()
                .to_string(),
            "0.5"
        );
        assert!(to_json(&PluginSettingValue::Unset).is_none());
    }

    #[test]
    fn a_stored_value_that_no_longer_fits_shows_the_default() {
        let specs = [number(Some(10.0), None)];
        let stored = BTreeMap::from([("interval".to_owned(), serde_json::json!(5))]);
        assert_eq!(
            values(&specs, &stored),
            BTreeMap::from([("interval".to_owned(), PluginSettingValue::Number(30.0))])
        );
    }
}
