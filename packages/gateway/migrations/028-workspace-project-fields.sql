-- Up

-- Project metadata on workspaces, so a project name, an alias or a GitHub repo
-- resolves to one workspace (and its folder). Aliases is a JSON array.
ALTER TABLE workspaces ADD COLUMN description TEXT;
ALTER TABLE workspaces ADD COLUMN aliases TEXT NOT NULL DEFAULT '[]';
ALTER TABLE workspaces ADD COLUMN github_repo TEXT;

-- Down

ALTER TABLE workspaces DROP COLUMN github_repo;
ALTER TABLE workspaces DROP COLUMN aliases;
ALTER TABLE workspaces DROP COLUMN description;
