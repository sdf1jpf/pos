-- Customer displays: a screen facing the customer (a tablet, or a second
-- monitor) that shows the sale being rung at the register it is paired
-- to. A display asks for a pairing code, and the clerk keys the code at
-- the register (functions, option 12). token is the SHA-256 of the
-- display's own secret, which it keeps; code is set until it is paired.
-- Displays stay where they were paired: they don't sync.
CREATE TABLE displays (
	token TEXT PRIMARY KEY,
	code TEXT,
	store INTEGER,
	reg INTEGER,
	created_at TEXT NOT NULL,
	paired_at TEXT,
	paired_by TEXT
);
CREATE UNIQUE INDEX displays_code ON displays (code) WHERE code IS NOT NULL;
CREATE INDEX displays_register ON displays (store, reg);
