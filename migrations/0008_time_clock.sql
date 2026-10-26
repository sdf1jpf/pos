-- The time clock and the schedule.

-- A punch: clocked in at a store, and out again. An open punch (no out
-- yet) is someone on the clock; there is at most one per employee.
CREATE TABLE punches (
	id        INTEGER PRIMARY KEY AUTOINCREMENT,
	emp       INTEGER NOT NULL REFERENCES employees (emp),
	store     INTEGER NOT NULL REFERENCES stores (store),
	reg       INTEGER,          -- the register it was punched at; none if keyed in the back office
	in_at     TEXT    NOT NULL,
	out_at    TEXT,
	edited_by TEXT,             -- who last changed it in the back office
	note      TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX punches_store ON punches (store, in_at);
CREATE INDEX punches_emp ON punches (emp, in_at);
CREATE UNIQUE INDEX punches_open ON punches (emp) WHERE out_at IS NULL;

-- The schedule: one shift per employee, store and day, as local times.
-- A shift that ends at or before it starts ends the next day.
CREATE TABLE shifts (
	store      INTEGER NOT NULL REFERENCES stores (store),
	emp        INTEGER NOT NULL REFERENCES employees (emp),
	day        TEXT    NOT NULL,  -- YYYY-MM-DD
	starts     TEXT    NOT NULL,  -- HH:MM
	ends       TEXT    NOT NULL,
	updated_at TEXT    NOT NULL,
	updated_by TEXT    NOT NULL,
	PRIMARY KEY (store, emp, day)
);
