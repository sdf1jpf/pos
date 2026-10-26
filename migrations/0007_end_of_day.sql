-- End of day. Each store has a business day: drawers opened belong to it,
-- and their sales with them. Closing the day (every drawer closed) writes
-- its Z report and moves the store on to the next day.

ALTER TABLE stores ADD COLUMN business_day TEXT NOT NULL DEFAULT ''; -- YYYY-MM-DD; '' until first set
UPDATE stores SET business_day = date('now');

ALTER TABLE drawers ADD COLUMN day TEXT;
UPDATE drawers SET day = substr(opened_at, 1, 10);
CREATE INDEX drawers_day ON drawers (store, day);

-- A store's closed (or closing) days and their Z reports, as JSON.
CREATE TABLE store_days (
	store     INTEGER NOT NULL REFERENCES stores (store),
	day       TEXT    NOT NULL,
	status    TEXT    NOT NULL CHECK (status IN ('R', 'C', 'O')), -- running the close, closed, reopened
	workflow  TEXT    NOT NULL DEFAULT '', -- the close's Workflow instance
	z         TEXT,
	closed_at TEXT,
	closed_by TEXT,
	PRIMARY KEY (store, day)
);
