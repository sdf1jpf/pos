-- The register: drawers, sales and what moves cash in and out of a drawer.
-- Money is in cents; quantities are in thousandths (a pound of apples is
-- 1000, two mugs are 2000), so that weighed and counted items are rung the
-- same way.

-- A register enrolled as a device signs on with its own Cloudflare Access
-- service token; token_id is that token's client ID, lower case.
ALTER TABLE registers ADD COLUMN token_id TEXT;
CREATE UNIQUE INDEX registers_token ON registers (token_id) WHERE token_id IS NOT NULL;

-- Bad PINs keyed in a row at the register. Three lock the operator out
-- until an administrator sets a new PIN.
ALTER TABLE employees ADD COLUMN pin_tries INTEGER NOT NULL DEFAULT 0;

-- A cash drawer, opened at a register with a counted float and closed
-- with a count. expected is what the drawer should hold at close:
-- the float, plus cash taken, plus paid in, less paid out.
CREATE TABLE drawers (
	id         INTEGER PRIMARY KEY AUTOINCREMENT,
	store      INTEGER NOT NULL,
	reg        INTEGER NOT NULL,
	opened_at  TEXT    NOT NULL,
	opened_by  INTEGER NOT NULL REFERENCES employees (emp),
	opening    INTEGER NOT NULL CHECK (opening >= 0),
	closed_at  TEXT,
	closed_by  INTEGER REFERENCES employees (emp),
	counted    INTEGER,
	expected   INTEGER,
	over_short INTEGER,  -- counted less expected: negative is short
	counts     TEXT,     -- the denomination count at close, as JSON
	FOREIGN KEY (store, reg) REFERENCES registers (store, reg)
);
-- One open drawer per register.
CREATE UNIQUE INDEX drawers_open ON drawers (store, reg) WHERE closed_at IS NULL;

-- A sale. token is made when the sale starts, so a sale sent twice (a
-- key pressed twice, a screen replayed) is written once. status: C
-- completed, X cancelled before tender, V voided after tender.
CREATE TABLE sales (
	id            INTEGER PRIMARY KEY AUTOINCREMENT,
	token         TEXT    NOT NULL UNIQUE,
	store         INTEGER NOT NULL,
	reg           INTEGER NOT NULL,
	drawer        INTEGER NOT NULL REFERENCES drawers (id),
	emp           INTEGER NOT NULL REFERENCES employees (emp),
	at            TEXT    NOT NULL,
	subtotal      INTEGER NOT NULL,
	tax           INTEGER NOT NULL,
	total         INTEGER NOT NULL,
	change        INTEGER NOT NULL DEFAULT 0,
	status        TEXT    NOT NULL CHECK (status IN ('C', 'X', 'V')),
	voided_at     TEXT,
	voided_by     INTEGER REFERENCES employees (emp),
	void_approver INTEGER REFERENCES employees (emp)
);
CREATE INDEX sales_reg ON sales (store, reg, at);
CREATE INDEX sales_drawer ON sales (drawer);

-- The lines of a sale as rung, voided lines included.
CREATE TABLE sale_lines (
	sale    INTEGER NOT NULL REFERENCES sales (id),
	line    INTEGER NOT NULL,
	sku     TEXT    NOT NULL,
	descr   TEXT    NOT NULL,
	dept    INTEGER NOT NULL,
	qty     INTEGER NOT NULL, -- thousandths
	price   INTEGER NOT NULL, -- each, or per pound
	amount  INTEGER NOT NULL,
	taxable INTEGER NOT NULL CHECK (taxable IN (0, 1)),
	voided  INTEGER NOT NULL DEFAULT 0 CHECK (voided IN (0, 1)),
	PRIMARY KEY (sale, line)
);

-- How a sale was paid. amount is what the tender paid toward the sale;
-- tendered is what was handed over (more than amount for cash given
-- change). A card is recorded, not charged: ref is its last four digits
-- and auth the approval code from the card terminal. ref is the check
-- number for a check.
CREATE TABLE sale_tenders (
	sale     INTEGER NOT NULL REFERENCES sales (id),
	seq      INTEGER NOT NULL,
	kind     TEXT    NOT NULL CHECK (kind IN ('CASH', 'CARD', 'CHECK')),
	amount   INTEGER NOT NULL,
	tendered INTEGER NOT NULL,
	ref      TEXT    NOT NULL DEFAULT '',
	auth     TEXT    NOT NULL DEFAULT '',
	PRIMARY KEY (sale, seq)
);

-- Cash in or out of a drawer other than a sale, and no-sale openings.
CREATE TABLE drawer_moves (
	id     INTEGER PRIMARY KEY AUTOINCREMENT,
	token  TEXT    NOT NULL UNIQUE,
	drawer INTEGER NOT NULL REFERENCES drawers (id),
	at     TEXT    NOT NULL,
	emp    INTEGER NOT NULL REFERENCES employees (emp),
	kind   TEXT    NOT NULL CHECK (kind IN ('PAIDIN', 'PAIDOUT', 'NOSALE')),
	amount INTEGER NOT NULL DEFAULT 0 CHECK (amount >= 0),
	reason TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX drawer_moves_drawer ON drawer_moves (drawer);
