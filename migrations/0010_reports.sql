-- A sale line's cost when the sale was posted to the stock ledger (each,
-- or per pound), for margin reports. Lines from before have none; reports
-- use the item's cost now for those.
ALTER TABLE sale_lines ADD COLUMN cost INTEGER;
