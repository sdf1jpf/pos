-- In-store mode: a store server runs the registers on the store's own
-- database, and the store and the cloud send each other what changed.

-- Where this database is. base is 0 in the cloud; a store server sets it
-- to its store number times 10^10. Rows rung at the till (sales, drawers,
-- punches and so on) take their ids from base + 1 up, so a store's ids and
-- the cloud's never meet and a row keeps its id when it is sent up.
-- applying is 1 while a store writes what it was sent, so that isn't
-- logged to be sent back.
CREATE TABLE site (
	base     INTEGER NOT NULL DEFAULT 0,
	applying INTEGER NOT NULL DEFAULT 0
);
INSERT INTO site (base, applying) VALUES (0, 0);

-- What changed, in order: a table and the key of the row, as a JSON array.
-- The row as it is now is what gets sent; a key with no row is a delete.
-- The cloud logs the master data the registers need (stores to reason
-- codes); a store logs what its registers write. Customers and cards go
-- both ways.
CREATE TABLE changes (
	rev INTEGER PRIMARY KEY AUTOINCREMENT,
	tbl TEXT    NOT NULL,
	key TEXT    NOT NULL
);

-- What a store has sent and been sent: the last rev of each side.
CREATE TABLE sync_state (
	store     INTEGER PRIMARY KEY,
	pushed    INTEGER NOT NULL DEFAULT 0, -- the store's own rev, sent up to here
	pulled    INTEGER NOT NULL DEFAULT 0, -- the cloud's rev, applied up to here
	pushed_at TEXT,
	pulled_at TEXT
);

-- Every insert, update and delete of a logged table, logged.
CREATE TRIGGER stores_insert_log AFTER INSERT ON stores WHEN (SELECT base FROM site) = 0
	BEGIN INSERT INTO changes (tbl, key) VALUES ('stores', json_array(NEW.store)); END;
CREATE TRIGGER stores_update_log AFTER UPDATE ON stores WHEN (SELECT base FROM site) = 0
	BEGIN INSERT INTO changes (tbl, key) VALUES ('stores', json_array(NEW.store)); END;
CREATE TRIGGER stores_delete_log AFTER DELETE ON stores WHEN (SELECT base FROM site) = 0
	BEGIN INSERT INTO changes (tbl, key) VALUES ('stores', json_array(OLD.store)); END;
CREATE TRIGGER registers_insert_log AFTER INSERT ON registers WHEN (SELECT base FROM site) = 0
	BEGIN INSERT INTO changes (tbl, key) VALUES ('registers', json_array(NEW.store, NEW.reg)); END;
CREATE TRIGGER registers_update_log AFTER UPDATE ON registers WHEN (SELECT base FROM site) = 0
	BEGIN INSERT INTO changes (tbl, key) VALUES ('registers', json_array(NEW.store, NEW.reg)); END;
CREATE TRIGGER registers_delete_log AFTER DELETE ON registers WHEN (SELECT base FROM site) = 0
	BEGIN INSERT INTO changes (tbl, key) VALUES ('registers', json_array(OLD.store, OLD.reg)); END;
CREATE TRIGGER departments_insert_log AFTER INSERT ON departments WHEN (SELECT base FROM site) = 0
	BEGIN INSERT INTO changes (tbl, key) VALUES ('departments', json_array(NEW.dept)); END;
CREATE TRIGGER departments_update_log AFTER UPDATE ON departments WHEN (SELECT base FROM site) = 0
	BEGIN INSERT INTO changes (tbl, key) VALUES ('departments', json_array(NEW.dept)); END;
CREATE TRIGGER departments_delete_log AFTER DELETE ON departments WHEN (SELECT base FROM site) = 0
	BEGIN INSERT INTO changes (tbl, key) VALUES ('departments', json_array(OLD.dept)); END;
CREATE TRIGGER items_insert_log AFTER INSERT ON items WHEN (SELECT base FROM site) = 0
	BEGIN INSERT INTO changes (tbl, key) VALUES ('items', json_array(NEW.sku)); END;
CREATE TRIGGER items_update_log AFTER UPDATE ON items WHEN (SELECT base FROM site) = 0
	BEGIN INSERT INTO changes (tbl, key) VALUES ('items', json_array(NEW.sku)); END;
CREATE TRIGGER items_delete_log AFTER DELETE ON items WHEN (SELECT base FROM site) = 0
	BEGIN INSERT INTO changes (tbl, key) VALUES ('items', json_array(OLD.sku)); END;
CREATE TRIGGER prices_insert_log AFTER INSERT ON prices WHEN (SELECT base FROM site) = 0
	BEGIN INSERT INTO changes (tbl, key) VALUES ('prices', json_array(NEW.store, NEW.sku)); END;
CREATE TRIGGER prices_update_log AFTER UPDATE ON prices WHEN (SELECT base FROM site) = 0
	BEGIN INSERT INTO changes (tbl, key) VALUES ('prices', json_array(NEW.store, NEW.sku)); END;
CREATE TRIGGER prices_delete_log AFTER DELETE ON prices WHEN (SELECT base FROM site) = 0
	BEGIN INSERT INTO changes (tbl, key) VALUES ('prices', json_array(OLD.store, OLD.sku)); END;
CREATE TRIGGER promotions_insert_log AFTER INSERT ON promotions WHEN (SELECT base FROM site) = 0
	BEGIN INSERT INTO changes (tbl, key) VALUES ('promotions', json_array(NEW.id)); END;
CREATE TRIGGER promotions_update_log AFTER UPDATE ON promotions WHEN (SELECT base FROM site) = 0
	BEGIN INSERT INTO changes (tbl, key) VALUES ('promotions', json_array(NEW.id)); END;
CREATE TRIGGER promotions_delete_log AFTER DELETE ON promotions WHEN (SELECT base FROM site) = 0
	BEGIN INSERT INTO changes (tbl, key) VALUES ('promotions', json_array(OLD.id)); END;
CREATE TRIGGER promotion_items_insert_log AFTER INSERT ON promotion_items WHEN (SELECT base FROM site) = 0
	BEGIN INSERT INTO changes (tbl, key) VALUES ('promotion_items', json_array(NEW.promo, NEW.sku)); END;
CREATE TRIGGER promotion_items_update_log AFTER UPDATE ON promotion_items WHEN (SELECT base FROM site) = 0
	BEGIN INSERT INTO changes (tbl, key) VALUES ('promotion_items', json_array(NEW.promo, NEW.sku)); END;
CREATE TRIGGER promotion_items_delete_log AFTER DELETE ON promotion_items WHEN (SELECT base FROM site) = 0
	BEGIN INSERT INTO changes (tbl, key) VALUES ('promotion_items', json_array(OLD.promo, OLD.sku)); END;
CREATE TRIGGER coupons_insert_log AFTER INSERT ON coupons WHEN (SELECT base FROM site) = 0
	BEGIN INSERT INTO changes (tbl, key) VALUES ('coupons', json_array(NEW.code)); END;
CREATE TRIGGER coupons_update_log AFTER UPDATE ON coupons WHEN (SELECT base FROM site) = 0
	BEGIN INSERT INTO changes (tbl, key) VALUES ('coupons', json_array(NEW.code)); END;
CREATE TRIGGER coupons_delete_log AFTER DELETE ON coupons WHEN (SELECT base FROM site) = 0
	BEGIN INSERT INTO changes (tbl, key) VALUES ('coupons', json_array(OLD.code)); END;
CREATE TRIGGER employees_insert_log AFTER INSERT ON employees WHEN (SELECT base FROM site) = 0
	BEGIN INSERT INTO changes (tbl, key) VALUES ('employees', json_array(NEW.emp)); END;
CREATE TRIGGER employees_update_log AFTER UPDATE ON employees WHEN (SELECT base FROM site) = 0
	BEGIN INSERT INTO changes (tbl, key) VALUES ('employees', json_array(NEW.emp)); END;
CREATE TRIGGER employees_delete_log AFTER DELETE ON employees WHEN (SELECT base FROM site) = 0
	BEGIN INSERT INTO changes (tbl, key) VALUES ('employees', json_array(OLD.emp)); END;
CREATE TRIGGER employee_stores_insert_log AFTER INSERT ON employee_stores WHEN (SELECT base FROM site) = 0
	BEGIN INSERT INTO changes (tbl, key) VALUES ('employee_stores', json_array(NEW.emp, NEW.store)); END;
CREATE TRIGGER employee_stores_update_log AFTER UPDATE ON employee_stores WHEN (SELECT base FROM site) = 0
	BEGIN INSERT INTO changes (tbl, key) VALUES ('employee_stores', json_array(NEW.emp, NEW.store)); END;
CREATE TRIGGER employee_stores_delete_log AFTER DELETE ON employee_stores WHEN (SELECT base FROM site) = 0
	BEGIN INSERT INTO changes (tbl, key) VALUES ('employee_stores', json_array(OLD.emp, OLD.store)); END;
CREATE TRIGGER reason_codes_insert_log AFTER INSERT ON reason_codes WHEN (SELECT base FROM site) = 0
	BEGIN INSERT INTO changes (tbl, key) VALUES ('reason_codes', json_array(NEW.kind, NEW.code)); END;
CREATE TRIGGER reason_codes_update_log AFTER UPDATE ON reason_codes WHEN (SELECT base FROM site) = 0
	BEGIN INSERT INTO changes (tbl, key) VALUES ('reason_codes', json_array(NEW.kind, NEW.code)); END;
CREATE TRIGGER reason_codes_delete_log AFTER DELETE ON reason_codes WHEN (SELECT base FROM site) = 0
	BEGIN INSERT INTO changes (tbl, key) VALUES ('reason_codes', json_array(OLD.kind, OLD.code)); END;
CREATE TRIGGER customers_insert_log AFTER INSERT ON customers WHEN (SELECT applying FROM site) = 0
	BEGIN INSERT INTO changes (tbl, key) VALUES ('customers', json_array(NEW.id)); END;
CREATE TRIGGER customers_update_log AFTER UPDATE ON customers WHEN (SELECT applying FROM site) = 0
	BEGIN INSERT INTO changes (tbl, key) VALUES ('customers', json_array(NEW.id)); END;
CREATE TRIGGER customers_delete_log AFTER DELETE ON customers WHEN (SELECT applying FROM site) = 0
	BEGIN INSERT INTO changes (tbl, key) VALUES ('customers', json_array(OLD.id)); END;
CREATE TRIGGER cards_insert_log AFTER INSERT ON cards WHEN (SELECT applying FROM site) = 0
	BEGIN INSERT INTO changes (tbl, key) VALUES ('cards', json_array(NEW.number)); END;
CREATE TRIGGER cards_update_log AFTER UPDATE ON cards WHEN (SELECT applying FROM site) = 0
	BEGIN INSERT INTO changes (tbl, key) VALUES ('cards', json_array(NEW.number)); END;
CREATE TRIGGER cards_delete_log AFTER DELETE ON cards WHEN (SELECT applying FROM site) = 0
	BEGIN INSERT INTO changes (tbl, key) VALUES ('cards', json_array(OLD.number)); END;
CREATE TRIGGER drawers_insert_log AFTER INSERT ON drawers WHEN (SELECT base FROM site) > 0
	BEGIN INSERT INTO changes (tbl, key) VALUES ('drawers', json_array(NEW.id)); END;
CREATE TRIGGER drawers_update_log AFTER UPDATE ON drawers WHEN (SELECT base FROM site) > 0
	BEGIN INSERT INTO changes (tbl, key) VALUES ('drawers', json_array(NEW.id)); END;
CREATE TRIGGER drawers_delete_log AFTER DELETE ON drawers WHEN (SELECT base FROM site) > 0
	BEGIN INSERT INTO changes (tbl, key) VALUES ('drawers', json_array(OLD.id)); END;
CREATE TRIGGER sales_insert_log AFTER INSERT ON sales WHEN (SELECT base FROM site) > 0
	BEGIN INSERT INTO changes (tbl, key) VALUES ('sales', json_array(NEW.id)); END;
CREATE TRIGGER sales_update_log AFTER UPDATE ON sales WHEN (SELECT base FROM site) > 0
	BEGIN INSERT INTO changes (tbl, key) VALUES ('sales', json_array(NEW.id)); END;
CREATE TRIGGER sales_delete_log AFTER DELETE ON sales WHEN (SELECT base FROM site) > 0
	BEGIN INSERT INTO changes (tbl, key) VALUES ('sales', json_array(OLD.id)); END;
CREATE TRIGGER sale_lines_insert_log AFTER INSERT ON sale_lines WHEN (SELECT base FROM site) > 0
	BEGIN INSERT INTO changes (tbl, key) VALUES ('sale_lines', json_array(NEW.sale, NEW.line)); END;
CREATE TRIGGER sale_lines_update_log AFTER UPDATE ON sale_lines WHEN (SELECT base FROM site) > 0
	BEGIN INSERT INTO changes (tbl, key) VALUES ('sale_lines', json_array(NEW.sale, NEW.line)); END;
CREATE TRIGGER sale_lines_delete_log AFTER DELETE ON sale_lines WHEN (SELECT base FROM site) > 0
	BEGIN INSERT INTO changes (tbl, key) VALUES ('sale_lines', json_array(OLD.sale, OLD.line)); END;
CREATE TRIGGER sale_tenders_insert_log AFTER INSERT ON sale_tenders WHEN (SELECT base FROM site) > 0
	BEGIN INSERT INTO changes (tbl, key) VALUES ('sale_tenders', json_array(NEW.sale, NEW.seq)); END;
CREATE TRIGGER sale_tenders_update_log AFTER UPDATE ON sale_tenders WHEN (SELECT base FROM site) > 0
	BEGIN INSERT INTO changes (tbl, key) VALUES ('sale_tenders', json_array(NEW.sale, NEW.seq)); END;
CREATE TRIGGER sale_tenders_delete_log AFTER DELETE ON sale_tenders WHEN (SELECT base FROM site) > 0
	BEGIN INSERT INTO changes (tbl, key) VALUES ('sale_tenders', json_array(OLD.sale, OLD.seq)); END;
CREATE TRIGGER sale_adjustments_insert_log AFTER INSERT ON sale_adjustments WHEN (SELECT base FROM site) > 0
	BEGIN INSERT INTO changes (tbl, key) VALUES ('sale_adjustments', json_array(NEW.sale, NEW.seq)); END;
CREATE TRIGGER sale_adjustments_update_log AFTER UPDATE ON sale_adjustments WHEN (SELECT base FROM site) > 0
	BEGIN INSERT INTO changes (tbl, key) VALUES ('sale_adjustments', json_array(NEW.sale, NEW.seq)); END;
CREATE TRIGGER sale_adjustments_delete_log AFTER DELETE ON sale_adjustments WHEN (SELECT base FROM site) > 0
	BEGIN INSERT INTO changes (tbl, key) VALUES ('sale_adjustments', json_array(OLD.sale, OLD.seq)); END;
CREATE TRIGGER drawer_moves_insert_log AFTER INSERT ON drawer_moves WHEN (SELECT base FROM site) > 0
	BEGIN INSERT INTO changes (tbl, key) VALUES ('drawer_moves', json_array(NEW.id)); END;
CREATE TRIGGER drawer_moves_update_log AFTER UPDATE ON drawer_moves WHEN (SELECT base FROM site) > 0
	BEGIN INSERT INTO changes (tbl, key) VALUES ('drawer_moves', json_array(NEW.id)); END;
CREATE TRIGGER drawer_moves_delete_log AFTER DELETE ON drawer_moves WHEN (SELECT base FROM site) > 0
	BEGIN INSERT INTO changes (tbl, key) VALUES ('drawer_moves', json_array(OLD.id)); END;
CREATE TRIGGER punches_insert_log AFTER INSERT ON punches WHEN (SELECT base FROM site) > 0
	BEGIN INSERT INTO changes (tbl, key) VALUES ('punches', json_array(NEW.id)); END;
CREATE TRIGGER punches_update_log AFTER UPDATE ON punches WHEN (SELECT base FROM site) > 0
	BEGIN INSERT INTO changes (tbl, key) VALUES ('punches', json_array(NEW.id)); END;
CREATE TRIGGER punches_delete_log AFTER DELETE ON punches WHEN (SELECT base FROM site) > 0
	BEGIN INSERT INTO changes (tbl, key) VALUES ('punches', json_array(OLD.id)); END;
CREATE TRIGGER card_moves_insert_log AFTER INSERT ON card_moves WHEN (SELECT base FROM site) > 0
	BEGIN INSERT INTO changes (tbl, key) VALUES ('card_moves', json_array(NEW.id)); END;
CREATE TRIGGER card_moves_update_log AFTER UPDATE ON card_moves WHEN (SELECT base FROM site) > 0
	BEGIN INSERT INTO changes (tbl, key) VALUES ('card_moves', json_array(NEW.id)); END;
CREATE TRIGGER card_moves_delete_log AFTER DELETE ON card_moves WHEN (SELECT base FROM site) > 0
	BEGIN INSERT INTO changes (tbl, key) VALUES ('card_moves', json_array(OLD.id)); END;
CREATE TRIGGER audit_insert_log AFTER INSERT ON audit WHEN (SELECT base FROM site) > 0
	BEGIN INSERT INTO changes (tbl, key) VALUES ('audit', json_array(NEW.id)); END;
CREATE TRIGGER audit_update_log AFTER UPDATE ON audit WHEN (SELECT base FROM site) > 0
	BEGIN INSERT INTO changes (tbl, key) VALUES ('audit', json_array(NEW.id)); END;
CREATE TRIGGER audit_delete_log AFTER DELETE ON audit WHEN (SELECT base FROM site) > 0
	BEGIN INSERT INTO changes (tbl, key) VALUES ('audit', json_array(OLD.id)); END;

-- The master data there already, logged once so a new store gets it all.
INSERT INTO changes (tbl, key) SELECT 'stores', json_array(store) FROM stores ORDER BY store;
INSERT INTO changes (tbl, key) SELECT 'registers', json_array(store, reg) FROM registers ORDER BY store, reg;
INSERT INTO changes (tbl, key) SELECT 'departments', json_array(dept) FROM departments ORDER BY dept;
INSERT INTO changes (tbl, key) SELECT 'items', json_array(sku) FROM items ORDER BY sku;
INSERT INTO changes (tbl, key) SELECT 'prices', json_array(store, sku) FROM prices ORDER BY store, sku;
INSERT INTO changes (tbl, key) SELECT 'promotions', json_array(id) FROM promotions ORDER BY id;
INSERT INTO changes (tbl, key) SELECT 'promotion_items', json_array(promo, sku) FROM promotion_items ORDER BY promo, sku;
INSERT INTO changes (tbl, key) SELECT 'coupons', json_array(code) FROM coupons ORDER BY code;
INSERT INTO changes (tbl, key) SELECT 'employees', json_array(emp) FROM employees ORDER BY emp;
INSERT INTO changes (tbl, key) SELECT 'employee_stores', json_array(emp, store) FROM employee_stores ORDER BY emp, store;
INSERT INTO changes (tbl, key) SELECT 'reason_codes', json_array(kind, code) FROM reason_codes ORDER BY kind, code;
INSERT INTO changes (tbl, key) SELECT 'customers', json_array(id) FROM customers ORDER BY id;
INSERT INTO changes (tbl, key) SELECT 'cards', json_array(number) FROM cards ORDER BY number;
