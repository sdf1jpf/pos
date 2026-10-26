-- Discounts, price overrides, coupons and promotions.
--
-- Times a promotion or coupon runs are store-local, "YYYY-MM-DD HH:MM", so
-- that a promotion from 7 AM is 7 AM at every store. ends is exclusive;
-- blank means it doesn't end.

-- A promotion the register applies by itself to the items it names:
--   SALE  each unit (or pound) at price
--   BOGO  buy qty, get free more at pct percent off (100 is free)
--   MIX   any qty of the items for price
-- store is null for every store.
CREATE TABLE promotions (
	id         INTEGER PRIMARY KEY AUTOINCREMENT,
	name       TEXT    NOT NULL,
	kind       TEXT    NOT NULL CHECK (kind IN ('SALE', 'BOGO', 'MIX')),
	qty        INTEGER NOT NULL DEFAULT 1 CHECK (qty BETWEEN 1 AND 99),
	free       INTEGER NOT NULL DEFAULT 0 CHECK (free BETWEEN 0 AND 99),
	pct        INTEGER NOT NULL DEFAULT 100 CHECK (pct BETWEEN 0 AND 100),
	price      INTEGER NOT NULL DEFAULT 0 CHECK (price >= 0),
	store      INTEGER REFERENCES stores (store),
	starts     TEXT    NOT NULL,
	ends       TEXT    NOT NULL DEFAULT '',
	status     TEXT    NOT NULL DEFAULT 'A' CHECK (status IN ('A', 'I')),
	version    INTEGER NOT NULL DEFAULT 1,
	updated_at TEXT    NOT NULL,
	updated_by TEXT    NOT NULL
);

CREATE TABLE promotion_items (
	promo INTEGER NOT NULL REFERENCES promotions (id) ON DELETE CASCADE,
	sku   TEXT    NOT NULL REFERENCES items (sku),
	PRIMARY KEY (promo, sku)
);
CREATE INDEX promotion_items_sku ON promotion_items (sku);

-- A coupon, scanned or keyed at the register: value off as a PERCENT (in
-- hundredths, so 10% is 1000) or an AMOUNT in cents. With a sku or dept it
-- comes off those items; without, off the sale. min_total is the least the
-- sale must come to first.
CREATE TABLE coupons (
	code       TEXT    PRIMARY KEY,
	descr      TEXT    NOT NULL,
	kind       TEXT    NOT NULL CHECK (kind IN ('PERCENT', 'AMOUNT')),
	value      INTEGER NOT NULL CHECK (value > 0),
	sku        TEXT    REFERENCES items (sku),
	dept       INTEGER REFERENCES departments (dept),
	min_total  INTEGER NOT NULL DEFAULT 0 CHECK (min_total >= 0),
	starts     TEXT    NOT NULL,
	ends       TEXT    NOT NULL DEFAULT '',
	status     TEXT    NOT NULL DEFAULT 'A' CHECK (status IN ('A', 'I')),
	version    INTEGER NOT NULL DEFAULT 1,
	updated_at TEXT    NOT NULL,
	updated_by TEXT    NOT NULL
);

-- What a line was rung at before its price was overridden, why, and the
-- discounts taken off it: net is what the line came to.
ALTER TABLE sale_lines ADD COLUMN orig_price INTEGER;
ALTER TABLE sale_lines ADD COLUMN reason TEXT NOT NULL DEFAULT '';
ALTER TABLE sale_lines ADD COLUMN discount INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sale_lines ADD COLUMN net INTEGER;

-- A sale's total discount, and each discount, override, coupon and
-- promotion it took, line by line (line is null for one off the sale).
ALTER TABLE sales ADD COLUMN discount INTEGER NOT NULL DEFAULT 0;

CREATE TABLE sale_adjustments (
	sale     INTEGER NOT NULL REFERENCES sales (id),
	seq      INTEGER NOT NULL,
	kind     TEXT    NOT NULL CHECK (kind IN ('OVERRIDE', 'PROMO', 'LINEDISC', 'COUPON', 'SALEDISC')),
	line     INTEGER,
	code     TEXT    NOT NULL DEFAULT '', -- promotion id, coupon code, reason code
	descr    TEXT    NOT NULL DEFAULT '',
	amount   INTEGER NOT NULL, -- cents off
	approver TEXT,             -- the manager who approved it
	PRIMARY KEY (sale, seq)
);
