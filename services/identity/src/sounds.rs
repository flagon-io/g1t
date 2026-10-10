//! Sound settings: what a person hears when chat moves, kept with their
//! account so a phone, a laptop and the desktop app all sound the same.
//!
//! One row per person (migration 0046); a person with no row has the
//! defaults. Only the person reads or changes their own. Which sound plays
//! when is the web app's rule (apps/web/app/lib/chat-sounds.ts); this only
//! keeps the choices, checking each against the sets and cues g1t has.
//! Do not disturb is the person's presence (services/notify), not a row here.

use std::collections::BTreeMap;

use g1t_contracts::identity::*;
use g1t_contracts::time::SQL_NOW;
use g1t_contracts::{FailureCode, Outcome};
use serde::Deserialize;
use worker::Result;

use crate::Identity;
use crate::security::is_person;

/// `current` with `change` over it, each field checked. Refused whole when
/// a set or a cue is not one g1t has, or the volume is out of range.
pub fn apply_change(current: &SoundSettings, change: &SoundSettingsChange) -> std::result::Result<SoundSettings, String> {
    let mut next = current.clone();
    if let Some(on) = change.sounds_enabled {
        next.sounds_enabled = on;
    }
    if let Some(set) = &change.sound_set {
        let set = set.trim();
        if !SOUND_SETS.contains(&set) {
            return Err("That is not a sound set g1t has.".to_owned());
        }
        next.sound_set = set.to_owned();
    }
    if let Some(volume) = change.sound_volume {
        if !(0..=100).contains(&volume) {
            return Err("Volume is from 0 to 100.".to_owned());
        }
        next.sound_volume = volume as u8;
    }
    if let Some(cues) = &change.sound_cues {
        for (cue, on) in cues {
            if !SOUND_CUES.contains(&cue.as_str()) {
                return Err("That is not a sound g1t plays.".to_owned());
            }
            next.sound_cues.insert(cue.clone(), *on);
        }
    }
    if let Some(on) = change.desktop_toasts {
        next.desktop_toasts = on;
    }
    Ok(next)
}

#[derive(Deserialize)]
struct Row {
    sounds_enabled: i64,
    sound_set: String,
    sound_volume: i64,
    sound_cues: String,
    desktop_toasts: i64,
}

/// A row as settings: a field that cannot be read falls back to its
/// default rather than failing the page, and a cue that no longer exists
/// is dropped.
fn settings_from(row: Row) -> SoundSettings {
    let defaults = SoundSettings::default();
    let mut cues = defaults.sound_cues.clone();
    let saved: BTreeMap<String, bool> = serde_json::from_str(&row.sound_cues).unwrap_or_default();
    for (cue, on) in saved {
        if SOUND_CUES.contains(&cue.as_str()) {
            cues.insert(cue, on);
        }
    }
    SoundSettings {
        sounds_enabled: row.sounds_enabled != 0,
        sound_set: if SOUND_SETS.contains(&row.sound_set.as_str()) { row.sound_set } else { defaults.sound_set },
        sound_volume: u8::try_from(row.sound_volume.clamp(0, 100)).unwrap_or(DEFAULT_SOUND_VOLUME),
        sound_cues: cues,
        desktop_toasts: row.desktop_toasts != 0,
    }
}

const COLUMNS: &str = "sounds_enabled, sound_set, sound_volume, sound_cues, desktop_toasts";

impl Identity {
    async fn read_sound_settings(&self, user_id: &str) -> Result<SoundSettings> {
        let row = self
            .db
            .prepare(format!("SELECT {COLUMNS} FROM sound_settings WHERE user_id = ?"))
            .bind(&[user_id.into()])?
            .first::<Row>(None)
            .await?;
        Ok(row.map(settings_from).unwrap_or_default())
    }

    pub async fn sound_settings(&self, a: SoundSettingsArgs) -> Result<SoundSettings> {
        if !is_person(&a.user) {
            return Ok(SoundSettings::default());
        }
        self.read_sound_settings(&a.user.id).await
    }

    pub async fn set_sound_settings(&self, a: SetSoundSettingsArgs) -> Result<Outcome<SoundSettings>> {
        if !is_person(&a.user) {
            return Ok(Outcome::fail(FailureCode::Forbidden, "Only a person has sound settings."));
        }
        let current = self.read_sound_settings(&a.user.id).await?;
        let next = match apply_change(&current, &a.change) {
            Ok(next) => next,
            Err(message) => return Ok(Outcome::fail(FailureCode::Invalid, message)),
        };
        // Only the cues that differ from their defaults are kept, so a new
        // default later applies to everyone who never chose.
        let defaults = SoundSettings::default();
        let chosen: BTreeMap<&String, &bool> = next.sound_cues.iter().filter(|(cue, on)| defaults.sound_cues.get(*cue) != Some(on)).collect();
        let cues = serde_json::to_string(&chosen)?;
        let row = self
            .db
            .prepare(format!(
                "INSERT INTO sound_settings (user_id, sounds_enabled, sound_set, sound_volume, sound_cues, desktop_toasts, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, {SQL_NOW})
                 ON CONFLICT (user_id) DO UPDATE SET sounds_enabled = excluded.sounds_enabled, sound_set = excluded.sound_set,
                   sound_volume = excluded.sound_volume, sound_cues = excluded.sound_cues, desktop_toasts = excluded.desktop_toasts,
                   updated_at = excluded.updated_at
                 RETURNING {COLUMNS}"
            ))
            .bind(&[
                a.user.id.as_str().into(),
                i32::from(next.sounds_enabled).into(),
                next.sound_set.as_str().into(),
                i32::from(next.sound_volume).into(),
                cues.as_str().into(),
                i32::from(next.desktop_toasts).into(),
            ])?
            .first::<Row>(None)
            .await?;
        Ok(match row {
            Some(row) => Outcome::Ok(settings_from(row)),
            None => Outcome::Ok(next),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cues(list: &[(&str, bool)]) -> BTreeMap<String, bool> {
        list.iter().map(|(cue, on)| ((*cue).to_owned(), *on)).collect()
    }

    #[test]
    fn the_defaults_play_everything_but_the_tick_as_you_send() {
        let d = SoundSettings::default();
        assert!(d.sounds_enabled);
        assert_eq!(d.sound_set, "soft");
        assert_eq!(d.sound_volume, 60);
        assert_eq!(d.sound_cues.get("message"), Some(&true));
        assert_eq!(d.sound_cues.get("mention"), Some(&true));
        assert_eq!(d.sound_cues.get("sent"), Some(&false));
        assert!(!d.desktop_toasts);
    }

    #[test]
    fn a_change_touches_only_what_it_names() {
        let d = SoundSettings::default();
        let next = apply_change(&d, &SoundSettingsChange { sound_volume: Some(30), sound_cues: Some(cues(&[("sent", true)])), ..Default::default() }).unwrap();
        assert_eq!(next.sound_volume, 30);
        assert_eq!(next.sound_set, "soft");
        assert_eq!(next.sound_cues.get("sent"), Some(&true));
        assert_eq!(next.sound_cues.get("message"), Some(&true));
        let bright = apply_change(&next, &SoundSettingsChange { sound_set: Some("bright".to_owned()), ..Default::default() }).unwrap();
        assert_eq!(bright.sound_set, "bright");
        assert_eq!(bright.sound_volume, 30);
    }

    #[test]
    fn an_unknown_set_cue_or_volume_is_refused() {
        let d = SoundSettings::default();
        assert!(apply_change(&d, &SoundSettingsChange { sound_set: Some("loud".to_owned()), ..Default::default() }).is_err());
        assert!(apply_change(&d, &SoundSettingsChange { sound_volume: Some(101), ..Default::default() }).is_err());
        assert!(apply_change(&d, &SoundSettingsChange { sound_volume: Some(-1), ..Default::default() }).is_err());
        assert!(apply_change(&d, &SoundSettingsChange { sound_cues: Some(cues(&[("call", false)])), ..Default::default() }).is_err());
        assert!(apply_change(&d, &SoundSettingsChange { sound_cues: Some(cues(&[("klaxon", true)])), ..Default::default() }).is_err());
    }

    #[test]
    fn a_row_reads_with_defaults_for_what_it_cannot_say() {
        let row = Row { sounds_enabled: 0, sound_set: "gone".to_owned(), sound_volume: 400, sound_cues: "not json".to_owned(), desktop_toasts: 1 };
        let s = settings_from(row);
        assert!(!s.sounds_enabled);
        assert_eq!(s.sound_set, "soft");
        assert_eq!(s.sound_volume, 100);
        assert_eq!(s.sound_cues, SoundSettings::default().sound_cues);
        assert!(s.desktop_toasts);
        let row = Row { sounds_enabled: 1, sound_set: "bright".to_owned(), sound_volume: 20, sound_cues: r#"{"sent":true,"old_cue":true}"#.to_owned(), desktop_toasts: 0 };
        let s = settings_from(row);
        assert_eq!(s.sound_cues.get("sent"), Some(&true));
        assert_eq!(s.sound_cues.get("old_cue"), None);
    }
}
