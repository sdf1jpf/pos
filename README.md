# Greenscreen POS

A multi-store retail point of sale with a full back office, built on
[Greenscreen](https://github.com/sdf1jpf/greenscreen): 3270-style screens
served by a Cloudflare Worker, with D1 as the database. The registers and
the back office are both green-screen panels, used from the Go terminal or
the browser terminal.

The plan, in five phases, is the "Greenscreen POS: scope and design" doc.
Phase 1 laid the foundation: the master-data schema, sign-on through
Cloudflare Access with roles, and the back-office panels for stores,
registers, items, departments, price books and employees. Phase 2 is the
register: sign-on, drawers, sales, tenders, receipts and post-voids, then
discounts, price overrides, coupons and promotions, with returns and the
rest to follow.

## The back office

| Map | Panel | Who |
| --- | --- | --- |
| POSM00 | Primary option menu, showing only what the person's role allows | everyone on file |
| POSM01 | 1 PRODUCTS | buyers, managers, admins |
| POS110 | 1.1 ITEMS: the item master, searched by SKU, UPC, description or department | buyers, admins |
| POS111 | Item: add or update; PF1 in DEPARTMENT lists them | buyers, admins |
| POS120 | 1.2 DEPTS: departments, changed in place | buyers, admins |
| POS130 | 1.3 PRICES: a store's price book; a store's own price overrides the base price | buyers, admins, managers (their stores) |
| POS140 | 1.4 PROMOTIONS: sale prices, buy-X-get-Y and mix and match, by store and time, applied by the registers themselves | buyers, admins |
| POS150 | 1.5 COUPONS: codes the registers take, off an item, a department or the sale | buyers, admins |
| POS410 | 4 EMPLOYEES: people, roles, userids, operator IDs, stores | admins |
| POS411 | Employee: add or update | admins |
| POSM08 | 8 ADMIN | admins |
| POS810 | 8.1 STORES: S shows a store, R its registers | admins |
| POS811 | Store: address, tax rate, discount limit, receipt header and footer | admins |
| POS820 | 8.2 REGISTERS: a store's registers, changed in place, and the service token each enrolled register signs on with | admins |
| POS200 | R REGISTER: run a register on this terminal | supervisors, managers, admins |

Menu numbers follow the plan (2 INVENTORY, 3 PURCHASING, 5 END OF DAY,
6 REPORTS and 7 CUSTOMERS come later), so fast paths like `=1.3` won't
move.

Rules worth knowing:

- **Roles.** Cloudflare Access says who someone is; the employee file
  (`employees.userid`) gives their role and the stores they're limited to.
  Cashiers and people not on file can't sign on to the back office. Every
  panel checks the role on every key, so a change takes effect at once.
  The userids in `ADMIN_USERS` are administrators of every store even when
  not on file, so the first person can sign on and add everyone else.
- **Lost updates.** Stores, items and employees carry a version. An update
  made from a screen that's out of date is refused with a "changed by"
  message and the record is shown as it is now.
- **Audit.** Every change writes an `audit` row (who, when, what, store) in
  the same transaction as the change.
- **Money** is in cents; tax rates are in thousandths of a percent (8.25% is
  8250).

## The register

A register is either a terminal enrolled as one (it signs on through
Access with its own service token, and goes straight to its sign-on
screen) or any terminal a supervisor or manager turns into one with
option R. Either way, one terminal at a time runs a register: the
others are told it is in use (greenscreen's record locks, in the Sessions
Durable Object).

| Map | Panel |
| --- | --- |
| POS210 | Sign on: operator ID and 4-digit PIN. Three wrong PINs lock the operator out until an admin sets a new PIN (POS411) |
| POS211 | Open the drawer: the float, counted by denomination; PF10 opens it |
| POS220 | Sale: scan or key a SKU or UPC, a quantity or a weight in pounds. PF2 checks a price, PF6 voids a line, PF12 (twice) voids the sale |
| POS227 | Discount (PF9): a percent or amount off a line, a percent off the sale, or a line's price overridden with a reason |
| POS230 | Tender: cash (with change), card (last 4 and approval code; recorded, not charged) or check, split as the customer likes |
| POS240 | Receipt, with the receipt number store-register-sale and its barcode text |
| POS225 | Functions between sales: receipts, paid in, paid out, no sale, close drawer, sign off |
| POS241 | The register's receipts: S reprints, V voids a paid sale |
| POS290 | Manager approval: a supervisor's, manager's or admin's operator ID and PIN, for a post-void, a discount over the store's limit or any price override |
| POS250 | Close the drawer: counted blind, then expected, over/short, card and check totals |

Rules worth knowing:

- **A sale is written once, whole,** when it is paid for or voided, with
  its lines, tenders and audit rows in one transaction. Each sale carries
  a token made when it started, so a key pressed twice can't write it
  twice.
- **Drawers.** One open drawer per register, shared by the operators who
  sign on to it. It should hold its float, plus cash taken, plus paid in,
  less paid out; a post-voided sale no longer counts.
- **Pricing** (`src/data/pricing.ts`) works in a fixed order on each
  line: a price override replaces the price; then one promotion (not on
  an overridden or discounted line); the line's own discount; item and
  department coupons; the sale discount; sale coupons, spread over the
  lines. A coupon is scanned or keyed in the item field.
- **Tax** is the store's rate on what the taxable lines come to after
  discounts, rounded once per sale.
- **Quantities** are kept in thousandths, so a pound and a half of apples
  is 1500 and two mugs are 2000.
- **Enrolling a register:** create a service token in Cloudflare Zero
  Trust, add it to the Access application's Service Auth policy, and key
  its client ID beside the register on POS820. The terminal on that lane
  then signs on with the token.

## Layout

```
src/index.ts         the app: panels, logon check, field help
src/access.ts        who is signed on, their role and stores
src/worker.ts        the Worker's entry: the app and the Sessions Durable Object
src/data/*.ts        stores, items, employees, PINs, the register: SQL, validation, audit
src/screens/*.ts     the back-office panels, one module per group
src/register/*.ts    the register panels
migrations/          the D1 schema
seed.sql             the small fixture the tests use
seed/sample.sql      fuller sample data: 3 stores, ~50 items, every role
test/                tests against a real (local) D1, through POST /v1/screen
```

## Run it locally

```sh
npm ci
cp .dev.vars.example .dev.vars          # signs on as ADMIN, an administrator
npm run db:migrate:local && npm run db:seed:local
npm run dev                             # http://localhost:8787
```

Open http://localhost:8787 for the browser terminal, or run the Go terminal:
`go run github.com/sdf1jpf/greenscreen/cmd/greenscreen@latest -api http://localhost:8787`.
The seed has users `BUYER`, `MANAGER` (store 2 only), `SUPER` (a
supervisor at store 1) and `CASHIER`; set `DEV_USER` in `.dev.vars` to try
each role. At the register, operators 3001 and 3002 (cashiers at store 1),
4001 (the supervisor) and 2001 (the store 2 manager) all have PIN 1234.

For something closer to a real chain, load `seed/sample.sql` into an empty
database instead of `seed.sql`: three stores with ten registers, nine
departments, 48 items (some weighed, one discontinued) with price books for
stores 2 and 3, and fourteen people in every role. Its back-office userids
are `AADMIN`, `PORTIZ` and `DLEE` (buyers), `MPATEL`, `RCOLE`, `GWARD`
(managers of stores 1, 2, 3), `SNGUYEN` and `TKIM` (supervisors); cashiers
have operator IDs 3001 to 3006. It's safe to run again, and never changes
a row that already exists.

```sh
npm run db:migrate:local && npm run db:sample:local
npm run db:sample:remote                # the deployed database
```

```sh
npm test            # vitest in workerd, with migrations and seed applied
npm run typecheck
```

`.npmrc` sets `legacy-peer-deps`, which npm 10 (the one Node 22 ships) needs
to install vitest's peers.

## Deploy

CI tests every PR. A push to main also applies the D1 migrations, deploys
the Worker and smoke-tests it. One-time setup:

1. **D1.** The `greenscreen-pos` database already exists in the account and
   is in `wrangler.jsonc`.
2. **Secrets for the Worker:** `npx wrangler secret put STATE_KEY` (any long
   random string; it signs the commarea).
3. **Cloudflare Access.** Create a self-hosted Access application for the
   Worker's hostname (`greenscreen-pos.justin-frank.workers.dev`), with an Allow policy for the people who use the back
   office and a Service Auth policy for a service token (for the smoke
   test). Add a Bypass policy on `/v1/health` and `/v1/screen/info`, so
   the terminals can title their logon screen. Its audience tag is
   `ACCESS_AUD` in `wrangler.jsonc`; without one, the Worker refuses every
   request.
4. **GitHub secrets** (in the `production` environment):
   `CLOUDFLARE_API_TOKEN` (Workers Scripts edit, D1 edit),
   `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` (the service token).
5. Set `ADMIN_USERS` in `wrangler.jsonc` to your userid (the part of your
   Access email before the @, letters and digits, at most 8 characters).
