PRAGMA foreign_keys = ON;

CREATE TABLE mcp_oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_name TEXT NOT NULL,
  redirect_uris_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE mcp_oauth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES mcp_oauth_clients(client_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  resource TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX mcp_oauth_codes_expiry_idx ON mcp_oauth_codes(expires_at, used_at);

CREATE TABLE mcp_oauth_tokens (
  id TEXT PRIMARY KEY,
  access_token_hash TEXT NOT NULL UNIQUE,
  refresh_token_hash TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL REFERENCES mcp_oauth_clients(client_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scopes_json TEXT NOT NULL,
  resource TEXT NOT NULL,
  access_expires_at TEXT NOT NULL,
  refresh_expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX mcp_oauth_tokens_access_idx
  ON mcp_oauth_tokens(access_token_hash, access_expires_at, revoked_at);
CREATE INDEX mcp_oauth_tokens_refresh_idx
  ON mcp_oauth_tokens(refresh_token_hash, refresh_expires_at, revoked_at);
CREATE INDEX mcp_oauth_tokens_user_idx ON mcp_oauth_tokens(user_id, created_at);

CREATE TABLE mcp_tool_calls (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  entity_id TEXT,
  succeeded INTEGER NOT NULL CHECK (succeeded IN (0, 1)),
  error_code TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX mcp_tool_calls_user_idx ON mcp_tool_calls(user_id, created_at DESC);
