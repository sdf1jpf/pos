-- Greenscreen POS: the master data the back office keeps and the registers
-- sell from. Money is in cents. Codes and names are stored upper case, as
-- the terminal shows them. Times are RFC 3339, UTC.
--
-- Master-data rows carry a version, bumped on every change, so that an
-- update made from a screen that is out of date is refused rather than lost.

-- A store, numbered 1 to 999. The tax rate is in thousandths of a percent,
-- so 8.25% is 8250. The discount limit is the largest discount, in percent,
-- a cashier may give without a manager.
CREATE TABLE stores (
	store          INTEGER PRIMARY KEY CHECK (store BETWEEN 1 AND 999),
	name           TEXT    NOT NULL,
	addr1          TEXT    NOT NULL DEFAULT '',
	addr2          TEXT    NOT NULL DEFAULT '',
	city           TEXT    NOT NULL DEFAULT '',
	state          TEXT    NOT NULL DEFAULT '',
	zip            TEXT    NOT NULL DEFAULT '',
	phone          TEXT    NOT NULL DEFAULT '',
	tax_rate       INTEGER NOT NULL DEFAULT 0 CHECK (tax_rate BETWEEN 0 AND 30000),
	discount_limit INTEGER NOT NULL DEFAULT 10 CHECK (discount_limit BETWEEN 0 AND 100),
	header1        TEXT    NOT NULL DEFAULT '', -- receipt header and footer lines
	header2        TEXT    NOT NULL DEFAULT '',
	footer1        TEXT    NOT NULL DEFAULT '',
	footer2        TEXT    NOT NULL DEFAULT '',
	status         TEXT    NOT NULL DEFAULT 'A' CHECK (status IN ('A', 'I')), -- active, inactive
	version        INTEGER NOT NULL DEFAULT 1,
	updated_at     TEXT    NOT NULL,
	updated_by     TEXT    NOT NULL
);

-- A register (lane) in a store: STORE 01 / REG 02.
CREATE TABLE registers (
	store      INTEGER NOT NULL REFERENCES stores (store),
	reg        INTEGER NOT NULL CHECK (reg BETWEEN 1 AND 99),
	name       TEXT    NOT NULL DEFAULT '',
	status     TEXT    NOT NULL DEFAULT 'A' CHECK (status IN ('A', 'I')),
	updated_at TEXT    NOT NULL,
	updated_by TEXT    NOT NULL,
	PRIMARY KEY (store, reg)
);

-- Departments group items for reports and set whether new items are
-- taxable by default.
CREATE TABLE departments (
	dept       INTEGER PRIMARY KEY CHECK (dept BETWEEN 1 AND 999),
	name       TEXT    NOT NULL,
	taxable    INTEGER NOT NULL DEFAULT 1 CHECK (taxable IN (0, 1)),
	status     TEXT    NOT NULL DEFAULT 'A' CHECK (status IN ('A', 'I')),
	updated_at TEXT    NOT NULL,
	updated_by TEXT    NOT NULL
);

-- The item master, chain wide. price is the base price, used at any store
-- whose price book has no price of its own for the item. A weighed item is
-- priced per pound and rung up by weight. vendor is the vendor's code;
-- purchasing adds the vendor file.
CREATE TABLE items (
	sku        TEXT    PRIMARY KEY,
	upc        TEXT    UNIQUE,
	descr      TEXT    NOT NULL,
	dept       INTEGER NOT NULL REFERENCES departments (dept),
	class      TEXT    NOT NULL DEFAULT '',
	vendor     TEXT    NOT NULL DEFAULT '',
	cost       INTEGER NOT NULL DEFAULT 0 CHECK (cost >= 0),
	price      INTEGER NOT NULL CHECK (price >= 0),
	taxable    INTEGER NOT NULL DEFAULT 1 CHECK (taxable IN (0, 1)),
	weighed    INTEGER NOT NULL DEFAULT 0 CHECK (weighed IN (0, 1)),
	status     TEXT    NOT NULL DEFAULT 'A' CHECK (status IN ('A', 'D')), -- active, discontinued
	version    INTEGER NOT NULL DEFAULT 1,
	updated_at TEXT    NOT NULL,
	updated_by TEXT    NOT NULL
);
CREATE INDEX items_descr ON items (descr);
CREATE INDEX items_dept ON items (dept);

-- The price book: a store's own price for an item, overriding its base price.
CREATE TABLE prices (
	store      INTEGER NOT NULL REFERENCES stores (store),
	sku        TEXT    NOT NULL REFERENCES items (sku),
	price      INTEGER NOT NULL CHECK (price >= 0),
	updated_at TEXT    NOT NULL,
	updated_by TEXT    NOT NULL,
	PRIMARY KEY (store, sku)
);

-- People. userid is the back-office sign-on from Cloudflare Access (the
-- email's local part, upper case); operator is the ID a cashier keys at
-- the register. Either may be unset. The role decides what a person may do.
CREATE TABLE employees (
	emp        INTEGER PRIMARY KEY AUTOINCREMENT,
	name       TEXT    NOT NULL,
	role       TEXT    NOT NULL CHECK (role IN ('CASHIER', 'SUPERVISOR', 'MANAGER', 'BUYER', 'ADMIN')),
	userid     TEXT    UNIQUE,
	operator   TEXT    UNIQUE,
	pin_hash   TEXT,   -- set at the register sign-on (phase 2)
	status     TEXT    NOT NULL DEFAULT 'A' CHECK (status IN ('A', 'I')),
	version    INTEGER NOT NULL DEFAULT 1,
	updated_at TEXT    NOT NULL,
	updated_by TEXT    NOT NULL
);

-- The stores a person is limited to. None means every store.
CREATE TABLE employee_stores (
	emp   INTEGER NOT NULL REFERENCES employees (emp) ON DELETE CASCADE,
	store INTEGER NOT NULL REFERENCES stores (store),
	PRIMARY KEY (emp, store)
);

-- The audit log: one row for every change, at the register or in the back
-- office. store and reg are set when the change belongs to one.
CREATE TABLE audit (
	id       INTEGER PRIMARY KEY AUTOINCREMENT,
	at       TEXT    NOT NULL,
	userid   TEXT    NOT NULL,
	store    INTEGER,
	reg      INTEGER,
	action   TEXT    NOT NULL, -- e.g. ITEM.ADD, STORE.UPDATE
	subject  TEXT    NOT NULL DEFAULT '', -- the key of what changed
	detail   TEXT    NOT NULL DEFAULT '',
	approver TEXT    -- the manager who approved it, for overrides
);
CREATE INDEX audit_at ON audit (at);
CREATE INDEX audit_store ON audit (store, at);
