//! Eido-owned interface text. User content, protocol values and third-party output
//! must never be passed through the catalog as translation keys.
use std::{collections::BTreeMap, sync::LazyLock};
use gpui::{App, Global, SharedString};
use settings::{Settings, SettingsContent, SettingsStore};

/// Add one registry entry and its catalog to support another interface language.
pub struct Language { pub id: &'static str, pub name: &'static str, pub source: &'static str }
pub const LANGUAGE_REGISTRY: &[Language] = &[
    Language { id: "en", name: "English", source: include_str!("../locales/en.json") },
    Language { id: "zh-CN", name: "简体中文", source: include_str!("../locales/zh-CN.json") },
];
static CATALOGS: LazyLock<BTreeMap<&'static str, BTreeMap<String, String>>> = LazyLock::new(|| {
    LANGUAGE_REGISTRY.iter().map(|language| (language.id,
        serde_json::from_str(language.source).expect("validated Eido language catalog"))).collect()
});

#[derive(Clone, Debug, PartialEq)]
pub struct EidoLanguageSettings { pub choice: String }
impl Settings for EidoLanguageSettings {
    fn from_settings(content: &SettingsContent) -> Self {
        Self { choice: content.eido_ui_language.clone().unwrap_or_else(|| "system".into()) }
    }
}

#[derive(Clone, Debug)]
pub struct LocaleState {
    pub revision: u64,
    pub choice: String,
    pub locale: &'static str,
}
impl Global for LocaleState {}

/// Only the user-global setting is read; a project/profile cannot change the UI language.
fn configured_choice(cx: &App) -> String {
    cx.global::<SettingsStore>().raw_user_settings()
        .and_then(|settings| settings.content.eido_ui_language.clone())
        .unwrap_or_else(|| "system".into())
}

pub fn resolve_locale(choice: &str, system_locale: Option<&str>) -> &'static str {
    match choice {
        "system" => {
            let normalized = system_locale.unwrap_or("").trim().to_ascii_lowercase().replace('_', "-");
            let language = normalized.split(['-', '.', '@']).next().unwrap_or("");
            if language == "zh" { "zh-CN" } else { "en" }
        }
        _ => LANGUAGE_REGISTRY.iter().find(|language| language.id == choice).map_or("en", |language| language.id),
    }
}

pub fn init(cx: &mut App) {
    EidoLanguageSettings::register(cx);
    let choice = configured_choice(cx);
    let system = sys_locale::get_locale();
    cx.set_global(LocaleState { revision: 1, locale: resolve_locale(&choice, system.as_deref()), choice });
    cx.observe_global::<SettingsStore>(|cx| {
        let choice = configured_choice(cx);
        if cx.global::<LocaleState>().choice != choice {
            apply_choice(choice, cx);
        }
    }).detach();
}

fn apply_choice(choice: String, cx: &mut App) {
    let system = sys_locale::get_locale();
    let locale = resolve_locale(&choice, system.as_deref());
    let revision = cx.try_global::<LocaleState>().map_or(1, |state| state.revision + 1);
    cx.set_global(LocaleState { revision, choice, locale });
    cx.refresh_windows();
}

/// Re-selecting “system” re-reads the OS language without writing a different preference.
pub fn refresh_system_locale(cx: &mut App) {
    if locale_choice(cx) == "system" { apply_choice("system".into(), cx); }
}

pub fn locale_choice(cx: &App) -> &str {
    cx.try_global::<LocaleState>().map_or("system", |state| state.choice.as_str())
}
pub fn locale(cx: &App) -> &'static str {
    cx.try_global::<LocaleState>().map_or("en", |state| state.locale)
}

fn lookup<'a>(catalog: Option<&'a BTreeMap<String, String>>, english: &'a BTreeMap<String, String>, key: &str, fallback: &'a str) -> &'a str {
    catalog.and_then(|catalog| catalog.get(key)).or_else(|| english.get(key)).map_or(fallback, String::as_str)
}
fn translated<'a>(locale: &str, key: &str, fallback: &'a str) -> &'a str {
    lookup(CATALOGS.get(locale), &CATALOGS["en"], key, fallback)
}

pub fn tr(cx: &App, key: &str) -> SharedString {
    translated(locale(cx), key, key).to_owned().into()
}
pub fn tr_or(cx: &App, key: &str, fallback: &str) -> SharedString {
    translated(locale(cx), key, fallback).to_owned().into()
}
pub fn tr_args(cx: &App, key: &str, args: &[(&str, String)]) -> SharedString {
    interpolate(translated(locale(cx), key, key), args).into()
}

/// Scan the template once. Parameter values stay literal, including braces.
pub fn interpolate(template: &str, args: &[(&str, String)]) -> String {
    let mut result = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(open) = rest.find('{') {
        result.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        let Some(close) = after.find('}') else { result.push_str(&rest[open..]); return result; };
        let name = &after[..close];
        if let Some((_, value)) = args.iter().find(|(key, _)| *key == name) {
            result.push_str(value);
        } else { result.push_str(&rest[open..open + close + 2]); }
        rest = &after[close + 1..];
    }
    result.push_str(rest);
    result
}

/// Deferred UI notices can keep semantic text while preserving unknown/raw output.
#[derive(Clone, Debug)]
pub enum UiMessage {
    Key(&'static str, Vec<(&'static str, String)>),
    Raw(String),
}
impl UiMessage {
    pub fn render(&self, cx: &App) -> SharedString {
        match self {
            Self::Key(key, args) => tr_args(cx, key, args),
            Self::Raw(text) => text.clone().into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;
    fn parameters(text: &str) -> BTreeSet<&str> {
        let mut result = BTreeSet::new();
        let mut rest = text;
        while let Some(open) = rest.find('{') {
            let after = &rest[open + 1..];
            let Some(close) = after.find('}') else { break; };
            let parameter = &after[..close];
            if !parameter.is_empty() && parameter.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                result.insert(parameter);
            }
            rest = &after[close + 1..];
        }
        result
    }
    #[test]
    fn language_preference_is_optional_and_deserializes() {
        for (json, expected) in [(r#"{}"#, "system"), (r#"{"eido_ui_language":"zh-CN"}"#, "zh-CN"), (r#"{"eido_ui_language":"unknown"}"#, "unknown")] {
            let content: SettingsContent = serde_json::from_str(json).unwrap();
            assert_eq!(EidoLanguageSettings::from_settings(&content).choice, expected);
        }
    }
    #[test]
    fn catalogs_have_matching_keys_and_parameters() {
        let english_catalog = &CATALOGS["en"];
        assert!(!english_catalog.is_empty());
        assert_eq!(CATALOGS.len(), LANGUAGE_REGISTRY.len(), "duplicate language registry ID");
        for (locale, catalog) in CATALOGS.iter() {
            assert_eq!(english_catalog.keys().collect::<Vec<_>>(), catalog.keys().collect::<Vec<_>>(), "{locale}");
            for (key, english) in english_catalog {
                assert_eq!(parameters(english), parameters(&catalog[key]), "{locale}: {key}");
                assert!(!english.is_empty() && !catalog[key].is_empty(), "{locale}: {key}");
            }
        }
    }
    #[test]
    fn locale_policy_is_explicit_and_system_normalizes() {
        for value in ["zh_CN.UTF-8", "zh-Hans", "ZH-tw", "zh_SG", "zh-Hant@calendar"] {
            assert_eq!(resolve_locale("system", Some(value)), "zh-CN");
        }
        assert_eq!(resolve_locale("system", None), "en");
        assert_eq!(resolve_locale("system", Some("fr-FR")), "en");
        assert_eq!(resolve_locale("unknown", Some("zh-CN")), "en");
        assert_eq!(resolve_locale("en", Some("zh-CN")), "en");
        assert_eq!(resolve_locale("zh-CN", None), "zh-CN");
    }
    #[test]
    fn parameters_are_literal_and_missing_parameters_survive() {
        assert_eq!(interpolate("{name}: {count}; {missing}", &[("name", "{count} 用户".into()), ("count", "2".into())]), "{count} 用户: 2; {missing}");
        assert_eq!(interpolate("中文 {unfinished", &[]), "中文 {unfinished");
    }
    #[test]
    fn missing_translation_falls_back_to_english() {
        let english = BTreeMap::from([("message".into(), "Hello {name}".into())]);
        let incomplete = BTreeMap::new();
        assert_eq!(lookup(Some(&incomplete), &english, "message", "unused"), "Hello {name}");
        assert_eq!(lookup(Some(&incomplete), &english, "missing", "caller fallback"), "caller fallback");
    }
    #[test]
    fn unknown_keys_and_locales_preserve_fallback() {
        assert_eq!(translated("zh-CN", "unknown.key", "Original output {x}"), "Original output {x}");
        let (key, value) = CATALOGS["en"].first_key_value().unwrap();
        assert_eq!(translated("xx", key, "unused"), value);
        assert_eq!(translated("en", "unknown.key", "unknown.key"), "unknown.key");
    }
}
