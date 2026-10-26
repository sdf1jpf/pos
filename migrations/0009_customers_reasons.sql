-- Reason codes kept in the back office, and gift card adjustments.

CREATE TABLE reason_codes (
	kind        TEXT    NOT NULL CHECK (kind IN ('ADJUST', 'OVERRIDE', 'CARD')),
	code        TEXT    NOT NULL,
	description TEXT    NOT NULL,
	status      TEXT    NOT NULL DEFAULT 'A' CHECK (status IN ('A', 'I')),
	updated_at  TEXT    NOT NULL,
	updated_by  TEXT    NOT NULL,
	PRIMARY KEY (kind, code)
);

-- The codes the screens had built in.
INSERT INTO reason_codes (kind, code, description, updated_at, updated_by) VALUES
	('ADJUST', 'DM', 'DAMAGED', '2026-10-26T00:00:00Z', 'MIGRATION'),
	('ADJUST', 'SH', 'SHRINK', '2026-10-26T00:00:00Z', 'MIGRATION'),
	('ADJUST', 'FD', 'FOUND', '2026-10-26T00:00:00Z', 'MIGRATION'),
	('ADJUST', 'US', 'STORE USE', '2026-10-26T00:00:00Z', 'MIGRATION'),
	('ADJUST', 'OT', 'OTHER', '2026-10-26T00:00:00Z', 'MIGRATION'),
	('OVERRIDE', 'PM', 'PRICE MATCH', '2026-10-26T00:00:00Z', 'MIGRATION'),
	('OVERRIDE', 'AD', 'AD PRICE', '2026-10-26T00:00:00Z', 'MIGRATION'),
	('OVERRIDE', 'MK', 'MISMARKED', '2026-10-26T00:00:00Z', 'MIGRATION'),
	('OVERRIDE', 'DM', 'DAMAGED', '2026-10-26T00:00:00Z', 'MIGRATION'),
	('OVERRIDE', 'MG', 'MANAGER''S CALL', '2026-10-26T00:00:00Z', 'MIGRATION'),
	('CARD', 'CO', 'CORRECTION', '2026-10-26T00:00:00Z', 'MIGRATION'),
	('CARD', 'GW', 'GOODWILL', '2026-10-26T00:00:00Z', 'MIGRATION'),
	('CARD', 'OT', 'OTHER', '2026-10-26T00:00:00Z', 'MIGRATION');

-- A card's balance changed in the back office: who, and why.
ALTER TABLE card_moves ADD COLUMN userid TEXT;
ALTER TABLE card_moves ADD COLUMN reason TEXT NOT NULL DEFAULT '';

CREATE INDEX audit_action ON audit (action, at);
CREATE INDEX sales_customer ON sales (customer, at);
CREATE INDEX cards_customer ON cards (customer);
