-- What a person hears when chat moves, kept with their account so a phone,
-- a laptop and the desktop app all sound the same: whether sounds play, which
-- set, how loud, each cue on or off (`sound_cues` is a JSON object such as
-- {"message":true,"sent":false}), and whether an open tab shows a system
-- notification while its window is not in front. A person with no row has
-- the defaults. Do not disturb is not here: it is the person's presence
-- (services/notify). See src/sounds.rs.
CREATE TABLE sound_settings (
  user_id TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  sounds_enabled INTEGER NOT NULL DEFAULT 1,
  sound_set TEXT NOT NULL DEFAULT 'soft',
  sound_volume INTEGER NOT NULL DEFAULT 60,
  sound_cues TEXT NOT NULL DEFAULT '{}',
  desktop_toasts INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
