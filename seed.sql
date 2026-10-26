-- Sample master data for local development and the tests: two stores, a
-- few departments and items, and people in each role.

INSERT INTO stores (store, name, addr1, city, state, zip, phone, tax_rate, discount_limit, header1, footer1, updated_at, updated_by) VALUES
	(1, 'MAIN STREET', '100 MAIN ST', 'DAYTON', 'OH', '45402', '937-555-0100', 7250, 10, 'MAIN STREET MARKET', 'THANK YOU FOR SHOPPING', '2026-10-26T00:00:00Z', 'SEED'),
	(2, 'RIVERSIDE', '2200 RIVER RD', 'KETTERING', 'OH', '45429', '937-555-0200', 7500, 15, 'RIVERSIDE MARKET', 'THANK YOU FOR SHOPPING', '2026-10-26T00:00:00Z', 'SEED');

INSERT INTO registers (store, reg, name, updated_at, updated_by) VALUES
	(1, 1, 'FRONT LANE 1', '2026-10-26T00:00:00Z', 'SEED'),
	(1, 2, 'FRONT LANE 2', '2026-10-26T00:00:00Z', 'SEED'),
	(2, 1, 'LANE 1', '2026-10-26T00:00:00Z', 'SEED');

INSERT INTO departments (dept, name, taxable, updated_at, updated_by) VALUES
	(10, 'GROCERY', 0, '2026-10-26T00:00:00Z', 'SEED'),
	(20, 'PRODUCE', 0, '2026-10-26T00:00:00Z', 'SEED'),
	(30, 'HOUSEWARES', 1, '2026-10-26T00:00:00Z', 'SEED'),
	(40, 'HARDWARE', 1, '2026-10-26T00:00:00Z', 'SEED');

INSERT INTO items (sku, upc, descr, dept, class, vendor, cost, price, taxable, weighed, updated_at, updated_by) VALUES
	('100100', '012345678905', 'COFFEE, GROUND 12 OZ', 10, 'BEV', 'ACMEFOOD', 412, 799, 0, 0, '2026-10-26T00:00:00Z', 'SEED'),
	('100200', '012345678912', 'PASTA, SPAGHETTI 1 LB', 10, 'DRY', 'ACMEFOOD', 61, 149, 0, 0, '2026-10-26T00:00:00Z', 'SEED'),
	('200100', NULL, 'APPLES, GALA', 20, 'FRT', 'VALLEYFM', 89, 199, 0, 1, '2026-10-26T00:00:00Z', 'SEED'),
	('200200', NULL, 'BANANAS', 20, 'FRT', 'VALLEYFM', 25, 69, 0, 1, '2026-10-26T00:00:00Z', 'SEED'),
	('300100', '098765432109', 'MUG, STONEWARE 12 OZ', 30, 'KIT', 'HOMEGDS', 210, 599, 1, 0, '2026-10-26T00:00:00Z', 'SEED'),
	('400100', '076543210987', 'HAMMER, CLAW 16 OZ', 40, 'TLS', 'TOOLCO', 845, 1999, 1, 0, '2026-10-26T00:00:00Z', 'SEED');

INSERT INTO prices (store, sku, price, updated_at, updated_by) VALUES
	(2, '100100', 849, '2026-10-26T00:00:00Z', 'SEED');

-- Everyone with an operator ID has register PIN 1234.
INSERT INTO employees (emp, name, role, userid, operator, pin_hash, updated_at, updated_by) VALUES
	(1, 'PAT BUYER', 'BUYER', 'BUYER', NULL, NULL, '2026-10-26T00:00:00Z', 'SEED'),
	(2, 'MO MANAGER', 'MANAGER', 'MANAGER', '2001', 'pbkdf2$100000$Z3JlZW5zY3JlZW5zZWVkMQ==$gMeF2UizBDbVcgJmE6vDB34EFhByZU7Qu+uthx1b3Ug=', '2026-10-26T00:00:00Z', 'SEED'),
	(3, 'CASEY CASHIER', 'CASHIER', 'CASHIER', '3001', 'pbkdf2$100000$Z3JlZW5zY3JlZW5zZWVkMQ==$gMeF2UizBDbVcgJmE6vDB34EFhByZU7Qu+uthx1b3Ug=', '2026-10-26T00:00:00Z', 'SEED'),
	(4, 'SAM SUPERVISOR', 'SUPERVISOR', 'SUPER', '4001', 'pbkdf2$100000$Z3JlZW5zY3JlZW5zZWVkMQ==$gMeF2UizBDbVcgJmE6vDB34EFhByZU7Qu+uthx1b3Ug=', '2026-10-26T00:00:00Z', 'SEED'),
	(5, 'RILEY CASHIER', 'CASHIER', NULL, '3002', 'pbkdf2$100000$Z3JlZW5zY3JlZW5zZWVkMQ==$gMeF2UizBDbVcgJmE6vDB34EFhByZU7Qu+uthx1b3Ug=', '2026-10-26T00:00:00Z', 'SEED');

INSERT INTO employee_stores (emp, store) VALUES (2, 2), (3, 1), (4, 1), (5, 1);
