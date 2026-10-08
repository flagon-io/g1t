-- Who may create a workspace's teams (g1t_contracts::teams::TeamCreation):
-- NULL for any member, as before; 'owners' for its owners only. Set by an
-- owner in the workspace's settings (`set_team_creation`), and enforced by
-- `create_team`. Additive; every workspace starts as any member.
ALTER TABLE workspaces ADD COLUMN team_creation TEXT;
