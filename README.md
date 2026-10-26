# Greenscreen POS

A multi-store retail point of sale with a full back office, built on
[Greenscreen](https://github.com/sdf1jpf/greenscreen): 3270-style screens
served by a Cloudflare Worker, with D1 as the database. The registers and
the back office are both green-screen panels, used from the Go terminal or
the browser terminal.

The plan, in five phases, is the "Greenscreen POS: scope and design" doc.
This is phase 1, the foundation: the master-data schema, sign-on through
Cloudflare Access with roles, and the back-office panels for stores,
registers, items, departments, price books and employees. The register
comes next.

## The back office

| Map | Panel | Who |
| --- | --- | --- |
| POSM00 | Primary option menu, showing only what the person's role allows | everyone on file |
| POSM01 | 1 PRODUCTS | buyers, managers, admins |
| POS110 | 1.1 ITEMS: the item master, searched by SKU, UPC, description or department | buyers, admins |
| POS111 | Item: add or update; PF1 in DEPARTMENT lists them | buyers, admins |
| POS120 | 1.2 DEPTS: departments, changed in place | buyers, admins |
| POS130 | 1.3 PRICES: a store's price book; a store's own price overrides the base price | buyers, admins, managers (their stores) |
| POS410 | 4 EMPLOYEES: people, roles, userids, operator IDs, stores | admins |
| POS411 | Employee: add or update | admins |
| POSM08 | 8 ADMIN | admins |
| POS810 | 8.1 STORES: S shows a store, R its registers | admins |
| POS811 | Store: address, tax rate, discount limit, receipt header and footer | admins |
| POS820 | 8.2 REGISTERS: a store's registers, changed in place | admins |

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

## Layout

```
src/index.ts         the app: panels, logon check, field help
src/access.ts        who is signed on, their role and stores
src/data/*.ts        stores, items, employees: SQL, validation, audit
src/screens/*.ts     one module per panel group
migrations/          the D1 schema
seed.sql             sample data for local runs and the tests
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
The seed has users `BUYER`, `MANAGER` (store 2 only) and `CASHIER`; set
`DEV_USER` in `.dev.vars` to try each role.

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
