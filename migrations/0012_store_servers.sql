-- A store's server signs on to the cloud with its own Access service
-- token; server_token is that token's client ID, lower case, as
-- registers.token_id is a register's.
ALTER TABLE stores ADD COLUMN server_token TEXT;
CREATE UNIQUE INDEX stores_server_token ON stores (server_token) WHERE server_token IS NOT NULL;

-- Why the last sync failed, if it did: on a store server, its own; in
-- the cloud, nothing (a store that can't reach it isn't heard from).
ALTER TABLE sync_state ADD COLUMN error TEXT;
