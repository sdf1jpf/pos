-- Inventory: what each store has of each item, and every move that
-- changed it. Quantities are in thousandths, as on sale lines: two mugs
-- are 2000, a pound and a half of apples 1500.

-- On hand per store and item. A row appears when anything first moves it;
-- no row is nothing on hand.
CREATE TABLE stock (
	store      INTEGER NOT NULL REFERENCES stores (store),
	sku        TEXT    NOT NULL REFERENCES items (sku),
	on_hand    INTEGER NOT NULL DEFAULT 0,
	updated_at TEXT    NOT NULL,
	PRIMARY KEY (store, sku)
);

-- The stock ledger: every change to on hand, and what made it. ref is the
-- sale, adjustment, count or transfer; with kind, line and store it names
-- the move once, so posting the same thing twice is refused.
CREATE TABLE stock_moves (
	id     INTEGER PRIMARY KEY AUTOINCREMENT,
	store  INTEGER NOT NULL REFERENCES stores (store),
	sku    TEXT    NOT NULL REFERENCES items (sku),
	at     TEXT    NOT NULL,
	kind   TEXT    NOT NULL CHECK (kind IN ('SALE', 'VOID', 'ADJUST', 'COUNT', 'XFEROUT', 'XFERIN', 'RECEIVE', 'VRETURN')),
	qty    INTEGER NOT NULL, -- + into the store, - out of it
	ref    TEXT    NOT NULL,
	line   INTEGER NOT NULL DEFAULT 0,
	reason TEXT    NOT NULL DEFAULT '',
	userid TEXT    NOT NULL,
	UNIQUE (kind, ref, line, store)
);
CREATE INDEX stock_moves_item ON stock_moves (store, sku, id);

-- A sale reaches the ledger after it is written, through a queue:
-- 0 not yet, 1 posted, 2 posted and then reversed by a post-void.
ALTER TABLE sales ADD COLUMN posted INTEGER NOT NULL DEFAULT 0;
CREATE INDEX sales_posting ON sales (posted, status, id);

-- Counts: a cycle count of a department, or a full count of every item.
-- Posting sets on hand to what was counted.
CREATE TABLE counts (
	id         INTEGER PRIMARY KEY AUTOINCREMENT,
	store      INTEGER NOT NULL REFERENCES stores (store),
	kind       TEXT    NOT NULL CHECK (kind IN ('CYCLE', 'FULL')),
	dept       INTEGER REFERENCES departments (dept),
	status     TEXT    NOT NULL DEFAULT 'O' CHECK (status IN ('O', 'P', 'X')), -- open, posted, cancelled
	created_at TEXT    NOT NULL,
	created_by TEXT    NOT NULL,
	done_at    TEXT,
	done_by    TEXT
);
CREATE TABLE count_lines (
	count   INTEGER NOT NULL REFERENCES counts (id),
	sku     TEXT    NOT NULL REFERENCES items (sku),
	counted INTEGER, -- NULL until counted
	PRIMARY KEY (count, sku)
);

-- Transfers between stores: sent from one, received at the other.
CREATE TABLE transfers (
	id          INTEGER PRIMARY KEY AUTOINCREMENT,
	from_store  INTEGER NOT NULL REFERENCES stores (store),
	to_store    INTEGER NOT NULL REFERENCES stores (store),
	status      TEXT    NOT NULL DEFAULT 'O' CHECK (status IN ('O', 'S', 'R', 'X')), -- open, sent, received, cancelled
	created_at  TEXT    NOT NULL,
	created_by  TEXT    NOT NULL,
	sent_at     TEXT,
	sent_by     TEXT,
	received_at TEXT,
	received_by TEXT,
	CHECK (from_store <> to_store)
);
CREATE TABLE transfer_lines (
	transfer INTEGER NOT NULL REFERENCES transfers (id),
	sku      TEXT    NOT NULL REFERENCES items (sku),
	qty      INTEGER NOT NULL CHECK (qty > 0),
	received INTEGER CHECK (received >= 0), -- NULL until received
	PRIMARY KEY (transfer, sku)
);
