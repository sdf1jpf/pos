-- Returns, customers, suspended sales, gift cards and store credit.

-- Customers, found at the register by phone. A tax-exempt customer's
-- sales carry no tax; exempt_id is their certificate number.
CREATE TABLE customers (
	id         INTEGER PRIMARY KEY AUTOINCREMENT,
	name       TEXT    NOT NULL,
	phone      TEXT    NOT NULL UNIQUE, -- digits only
	email      TEXT    NOT NULL DEFAULT '',
	tax_exempt INTEGER NOT NULL DEFAULT 0 CHECK (tax_exempt IN (0, 1)),
	exempt_id  TEXT    NOT NULL DEFAULT '',
	status     TEXT    NOT NULL DEFAULT 'A' CHECK (status IN ('A', 'I')),
	version    INTEGER NOT NULL DEFAULT 1,
	updated_at TEXT    NOT NULL,
	updated_by TEXT    NOT NULL
);

ALTER TABLE sales ADD COLUMN customer INTEGER REFERENCES customers (id);

-- A returned line is rung with a negative quantity. With a receipt it
-- names the sale and line it came back from, and that line counts what
-- has come back so far, never more than was sold.
ALTER TABLE sale_lines ADD COLUMN ret_sale INTEGER REFERENCES sales (id);
ALTER TABLE sale_lines ADD COLUMN ret_line INTEGER;
ALTER TABLE sale_lines ADD COLUMN returned INTEGER NOT NULL DEFAULT 0 CHECK (returned >= 0 AND (qty < 0 OR returned <= qty));
-- A gift card sold or loaded on the line: its number.
ALTER TABLE sale_lines ADD COLUMN card TEXT;

-- Gift cards and store credit: a number and what is left on it.
CREATE TABLE cards (
	number     TEXT    PRIMARY KEY,
	kind       TEXT    NOT NULL CHECK (kind IN ('GIFT', 'CREDIT')),
	balance    INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
	customer   INTEGER REFERENCES customers (id),
	status     TEXT    NOT NULL DEFAULT 'A' CHECK (status IN ('A', 'I')),
	issued_at  TEXT    NOT NULL,
	updated_at TEXT    NOT NULL
);

-- Every change to a card's balance, and the sale it was part of.
CREATE TABLE card_moves (
	id     INTEGER PRIMARY KEY AUTOINCREMENT,
	card   TEXT    NOT NULL REFERENCES cards (number),
	at     TEXT    NOT NULL,
	sale   INTEGER REFERENCES sales (id),
	amount INTEGER NOT NULL -- + loaded or issued, - spent
);
CREATE INDEX card_moves_card ON card_moves (card, at);

-- The tender kinds a sale takes now include gift cards and store credit.
-- SQLite can't change a CHECK, so the table is made again.
CREATE TABLE sale_tenders_new (
	sale     INTEGER NOT NULL REFERENCES sales (id),
	seq      INTEGER NOT NULL,
	kind     TEXT    NOT NULL CHECK (kind IN ('CASH', 'CARD', 'CHECK', 'GIFT', 'CREDIT')),
	amount   INTEGER NOT NULL,
	tendered INTEGER NOT NULL,
	ref      TEXT    NOT NULL DEFAULT '',
	auth     TEXT    NOT NULL DEFAULT '',
	PRIMARY KEY (sale, seq)
);
INSERT INTO sale_tenders_new SELECT sale, seq, kind, amount, tendered, ref, auth FROM sale_tenders;
DROP TABLE sale_tenders;
ALTER TABLE sale_tenders_new RENAME TO sale_tenders;

-- A sale put aside to finish later at any register in the store, that
-- day only. state is the sale as rung, as JSON.
CREATE TABLE suspended (
	id      INTEGER PRIMARY KEY AUTOINCREMENT,
	store   INTEGER NOT NULL REFERENCES stores (store),
	reg     INTEGER NOT NULL,
	emp     INTEGER NOT NULL REFERENCES employees (emp),
	at      TEXT    NOT NULL,
	day     TEXT    NOT NULL, -- the store's date, YYYY-MM-DD
	items   INTEGER NOT NULL,
	total   INTEGER NOT NULL,
	state   TEXT    NOT NULL,
	status  TEXT    NOT NULL DEFAULT 'S' CHECK (status IN ('S', 'R')), -- suspended, resumed
	resumed_at  TEXT,
	resumed_reg INTEGER
);
CREATE INDEX suspended_store ON suspended (store, day, status);
