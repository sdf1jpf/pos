# A day at the store

How the people in a store use Greenscreen POS: the cashier at the
register, the manager in the back office and the admin who sets it all
up. The [README](../README.md) lists every panel; this is the order you
meet them in.

Every screen works the same way: Tab moves between fields, Enter does what
the screen is for, and the PF keys along the bottom do the rest (F1 to F12
on a PC keyboard, F3 to go back). PF1 in a field lists what it takes. On
the menu, `=1.3` jumps straight to option 1.3 from anywhere.

In the browser the bar of clickable keys under the screen can be put away:
press HIDE (or Alt+K) and it folds to a small KEYS button that brings it
back. Each browser remembers the choice; add `?keys=hide` to the URL to
start a register without it.

## The cashier

**Clocking in.** On the register's sign-on screen (POS210), key your
operator ID and PIN and press PF9. PF9 again at the end of the shift
clocks you out.

**Signing on.** Key your operator ID and PIN and press Enter. If you sign
on to the back office with your own login instead, you land on Start your
register (POS201): pick the lane and you're on, with no PIN to key. Three
wrong PINs lock you out until an admin sets a new one.

**Opening the drawer.** The first person on a register each day counts the
float in by denomination and presses PF10. Everyone after shares the same
drawer.

**Ringing a sale** (POS220).

- Scan or key a SKU or UPC. Key a quantity first for more than one, or a
  weight in pounds for something weighed.
- PF2 checks a price without ringing it. PF6 voids a line, PF10 changes
  the last line's quantity.
- A coupon is scanned or keyed in the item field like an item.
- PF9 gives a discount or a price override. Over the store's limit, and
  for any override, a supervisor approves it with their own ID and PIN.
- PF4 has the rest: the customer (for tax exempt sales), a return, a gift
  card, or suspending the sale for later.
- PF12 twice voids the whole sale.

**Taking payment.** PF5 goes to tender (POS230). Key the method and the
amount: cash shows the change, card goes to the card terminal, and a gift
card or store credit takes its number. Split it any way the customer
likes. The receipt (POS240) shows the receipt number, which is what a
return needs.

**Returns.** PF4, then return: key the receipt number and how many of each
line are coming back. They're refunded at what was paid. Without a
receipt, PF5 returns an item at today's price as store credit, with a
supervisor's approval.

**Between sales.** PF4 has receipts (reprint, or post-void a paid sale
with approval), paid in, paid out, no sale, sign off and resume.

**The customer display.** A screen facing the customer shows each item
as you ring it, the savings, tax and total, "insert, tap or swipe" while
the card terminal waits, and the change at the end. To pair one, open
`/display` on it (a register Mac with two monitors does this itself): it
shows a 6-digit code. Press PF4, option 12, key the code and press Enter.
It stays paired; PF6 on the same screen unpairs it.

**Closing the drawer.** At the end of the day, PF4 then close drawer.
Count the cash by denomination first; only then does the register show
what it expected and the over or short.

## The manager

Managers sign on to the back office through Cloudflare Access with their
own login and see only their stores.

**Through the day.**

- 2.1 ON HAND shows stock by item. L shows an item's ledger, A adjusts it
  with a reason.
- 2.3 COUNTS runs a cycle count of a department or a full count: key what
  is on the shelf, then PF10 posts it.
- 2.4 TRANSFERS sends stock to another store, which receives it with PF10.
- 3.3 SUGGESTED says what to order from a vendor; PF10 turns it into a
  draft purchase order. Receive a delivery on the order itself (3.2).
- 4.3 SCHEDULE plans the week; PF6 copies last week. 4.2 TIME CARDS shows
  hours worked, and punches are fixed there with a reason.
- 7.1 CUSTOMERS and 7.2 GIFT CARDS look up and fix customers and balances.

**Closing the day.** Once every drawer is closed, 5.1 CLOSE and PF10
close the store's business day. That posts its sales, makes the Z report
and moves the store to the next day. 5.2 DAYS has the Z reports: sales,
returns, tenders, paid in and out, each drawer's over or short and the
deposit slip. A store with its own server can only close once the server
has caught up with the cloud, so the Z report has every sale.

**Reports.** 6 REPORTS has sales by day, hour, department, item and
cashier, tenders, exceptions (voids, overrides, returns), inventory value
and low stock. PF10 prints one as a PDF.

## The admin

**People.** 4.1 EMPLOYEES adds everyone. A person who uses the back office
needs a userid, which is the part of their Access email before the @. A
person who uses a register needs an operator ID and a PIN. Their role
(cashier, supervisor, manager, buyer, admin) says what they can do, and
their stores limit where.

**Stores and registers.** 8.1 STORES holds each store's address, tax rate,
discount limit and receipt header and footer. R lists its registers. To
enroll a register, create a service token in Cloudflare Zero Trust, add it
to the Access application's Service Auth policy, and key its client ID
beside the register on 8.2 REGISTERS. On a Mac,
`scripts/make-mac-app.sh --register` makes that register an app for the
Dock (see the README). With a second monitor it opens the customer
display there too, full screen, beside the register.

**Products.** 1.1 ITEMS is the item master. 1.3 PRICES is each store's
price book, 1.4 PROMOTIONS and 1.5 COUPONS what the registers take off.
8.4 REASON CODES lists the reasons for adjustments, overrides and gift
card changes.

**A store server.** A store that must keep selling when its internet is
down runs its registers on a machine in the store. Setting one up is in
[store/README.md](../store/README.md). 8.1 STORES shows when each server
was last heard from.

**Keeping an eye on it.** 8.3 AUDIT LOG has every change: who, when,
what and where. An admin can reopen a store's last closed day from 5.1
until a drawer opens on the next one.

## Trying it out

Load the sample and demo data (see "Run it locally" in the README), then:

- At a register, sign on as cashier 3001 with PIN 3001 and ring a sale.
- In the back office as `MPATEL`, store 1's manager, run 6 REPORTS for the
  last two weeks, or look at an item's ledger in 2.1.
- As `AADMIN`, look at the audit log, or a customer's last sales in 7.1.
