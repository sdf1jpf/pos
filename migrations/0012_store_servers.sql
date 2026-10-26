-- A store's server signs on to the cloud with its own Access service
-- token; server_token is that token's client ID, lower case, as
-- registers.token_id is a register's.
ALTER TABLE stores ADD COLUMN server_token TEXT;
CREATE UNIQUE INDEX stores_server_token ON stores (server_token) WHERE server_token IS NOT NULL;

-- Why the last sync failed, if it did: on a store server, its own; in
-- the cloud, nothing (a store that can't reach it isn't heard from).
ALTER TABLE sync_state ADD COLUMN error TEXT;

-- On hand goes down to a store server too, for its registers' item
-- lookup (it is the cloud's: sales post to the stock ledger there).
CREATE TRIGGER stock_insert_log AFTER INSERT ON stock WHEN (SELECT base FROM site) = 0
	BEGIN INSERT INTO changes (tbl, key) VALUES ('stock', json_array(NEW.store, NEW.sku)); END;
CREATE TRIGGER stock_update_log AFTER UPDATE ON stock WHEN (SELECT base FROM site) = 0
	BEGIN INSERT INTO changes (tbl, key) VALUES ('stock', json_array(NEW.store, NEW.sku)); END;
CREATE TRIGGER stock_delete_log AFTER DELETE ON stock WHEN (SELECT base FROM site) = 0
	BEGIN INSERT INTO changes (tbl, key) VALUES ('stock', json_array(OLD.store, OLD.sku)); END;
INSERT INTO changes (tbl, key) SELECT 'stock', json_array(store, sku) FROM stock ORDER BY store, sku;
