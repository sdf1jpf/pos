-- Purchasing: vendors, reorder points, purchase orders, receiving and
-- returns to vendors. Quantities are in thousandths, costs in cents per
-- unit (per pound for a weighed item), as on items.

-- The vendor file. items.vendor holds a vendor's code; the codes already
-- in use become vendors, named for their code until someone names them.
CREATE TABLE vendors (
	code       TEXT    PRIMARY KEY,
	name       TEXT    NOT NULL,
	contact    TEXT    NOT NULL DEFAULT '',
	phone      TEXT    NOT NULL DEFAULT '',
	email      TEXT    NOT NULL DEFAULT '',
	terms      TEXT    NOT NULL DEFAULT '',
	lead_days  INTEGER NOT NULL DEFAULT 7 CHECK (lead_days BETWEEN 0 AND 365),
	status     TEXT    NOT NULL DEFAULT 'A' CHECK (status IN ('A', 'I')),
	version    INTEGER NOT NULL DEFAULT 1,
	updated_at TEXT    NOT NULL,
	updated_by TEXT    NOT NULL
);
INSERT INTO vendors (code, name, updated_at, updated_by)
	SELECT DISTINCT vendor, vendor, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'MIGRATION' FROM items WHERE vendor <> '';

-- Reorder points per store and item: order when on hand and on order fall
-- to min, back up to max. NULL: none set.
ALTER TABLE stock ADD COLUMN min_qty INTEGER CHECK (min_qty >= 0);
ALTER TABLE stock ADD COLUMN max_qty INTEGER CHECK (max_qty >= 0);

-- Purchase orders, one vendor and one store each.
CREATE TABLE purchase_orders (
	id         INTEGER PRIMARY KEY AUTOINCREMENT,
	vendor     TEXT    NOT NULL REFERENCES vendors (code),
	store      INTEGER NOT NULL REFERENCES stores (store),
	-- draft, ordered, partly received, received, cancelled
	status     TEXT    NOT NULL DEFAULT 'D' CHECK (status IN ('D', 'O', 'P', 'R', 'X')),
	expected   TEXT    NOT NULL DEFAULT '', -- YYYY-MM-DD
	created_at TEXT    NOT NULL,
	created_by TEXT    NOT NULL,
	ordered_at TEXT,
	ordered_by TEXT,
	closed_at  TEXT
);
CREATE INDEX purchase_orders_store ON purchase_orders (store, status);
CREATE TABLE po_lines (
	po       INTEGER NOT NULL REFERENCES purchase_orders (id),
	sku      TEXT    NOT NULL REFERENCES items (sku),
	qty      INTEGER NOT NULL CHECK (qty > 0),
	cost     INTEGER NOT NULL CHECK (cost >= 0),
	received INTEGER NOT NULL DEFAULT 0 CHECK (received >= 0),
	PRIMARY KEY (po, sku)
);

-- Each delivery received against a PO. token names it, so Enter pressed
-- twice receives once.
CREATE TABLE po_receipts (
	id     INTEGER PRIMARY KEY AUTOINCREMENT,
	po     INTEGER NOT NULL REFERENCES purchase_orders (id),
	token  TEXT    NOT NULL UNIQUE,
	at     TEXT    NOT NULL,
	userid TEXT    NOT NULL
);

-- Stock sent back to a vendor.
CREATE TABLE vendor_returns (
	id     INTEGER PRIMARY KEY AUTOINCREMENT,
	vendor TEXT    NOT NULL REFERENCES vendors (code),
	store  INTEGER NOT NULL REFERENCES stores (store),
	token  TEXT    NOT NULL UNIQUE,
	reason TEXT    NOT NULL DEFAULT '',
	at     TEXT    NOT NULL,
	userid TEXT    NOT NULL
);
CREATE TABLE vendor_return_lines (
	ret  INTEGER NOT NULL REFERENCES vendor_returns (id),
	sku  TEXT    NOT NULL REFERENCES items (sku),
	qty  INTEGER NOT NULL CHECK (qty > 0),
	cost INTEGER NOT NULL CHECK (cost >= 0),
	PRIMARY KEY (ret, sku)
);
