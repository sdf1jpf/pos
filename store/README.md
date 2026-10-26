# The store server

A store server runs the POS on a machine in the store, so the store's
registers keep selling when its internet is down. It is the same Worker as
the cloud's, run by wrangler's local runtime (workerd, the runtime
Cloudflare runs Workers on) with its own SQLite database. Every 10 seconds
it sends the cloud what its registers wrote and takes what changed in the
cloud. Without the internet it carries on, and catches up when it's back.

What it does and doesn't do is under "In-store mode" in the main README.

## What it needs

- A machine on the store's network that stays on: Linux, macOS or
  Windows, with Node 22 or later. A small one will do.
- The cloud app deployed, and an admin to set the store up in it.

## Setting one up

1. **A service token for the server.** In Cloudflare Zero Trust, create a
   service token for the store's server. Add it to the POS Access
   application's Service Auth policy, as for a register. In the back
   office, 8.1, `S` beside the store, key its client ID in SERVER TOKEN.

2. **The code.** On the machine:

   ```sh
   git clone https://github.com/sdf1jpf/pos.git && cd pos
   npm ci
   ```

3. **Settings.** Copy `store/.dev.vars.example` to `store/.dev.vars` and
   fill it in: the store number, the cloud's URL, the server's token, and a
   `STATE_KEY` (any long random string). For each register, print its line
   for `REGISTER_TOKENS` from its service token, and put the lines
   together in one JSON object:

   ```sh
   npm run store:token -- <the register's client ID> <its secret>
   ```

   The registers keep the service tokens they have: the store server
   checks them itself, since Access isn't in front of it.

4. **Run it.**

   ```sh
   npm run store
   ```

   It applies the migrations, serves on port 8080 and starts syncing. The
   first sync takes the store's master data from the cloud. Keep it
   running as a service (systemd, launchd, or NSSM on Windows) so it comes
   back after a restart. Its data is in `store/data`: back it up.

5. **Point the registers at it.** On each register, run the terminal
   against the server instead of the cloud, with the same token:

   ```sh
   CF_ACCESS_CLIENT_ID=... CF_ACCESS_CLIENT_SECRET=... greenscreen -api http://<the server>:8080
   ```

   Or open `http://<the server>:8080` in a browser on the store's network
   for the browser terminal.

6. **Customer displays.** A display on the store's network opens
   `http://<the server>:8080/display` and is paired at its register (PF4,
   option 12). A register Mac with two monitors does this itself: make its
   app with the server's URL (`scripts/make-mac-app.sh --register LANE1
   http://<the server>:8080`).

## Keeping an eye on it

- In the back office, the store's screen (8.1, `S`) says when its server
  last sent and fetched. If that's long ago, the store is cut off, or the
  server is down.
- The server's own log shows each sync that failed, and why.
- Sales rung on the server have L receipts (`1-01-L000123`). Once they're
  in the cloud, they post to the stock ledger and count toward the day's Z
  report like any other.

The store's day closes in the cloud, as before. The close is refused
unless the server has synced in the last two minutes, so its drawers and
sales are all there.

## Settings

| Setting | |
|---|---|
| `STORE` | The store it runs |
| `CLOUD_URL` | The cloud app |
| `CLOUD_TOKEN_ID`, `CLOUD_TOKEN_SECRET` | The service token it signs on to the cloud with |
| `REGISTER_TOKENS` | JSON: each register's client ID to the SHA-256 of its secret |
| `STATE_KEY` | Signs the screens' state |

`npm run store` also reads `PORT` (8080), `STORE_IP` (0.0.0.0, every
address), `SYNC_SECONDS` (10), `STORE_DATA` (store/data) and `STORE_VARS`
(store/.dev.vars) from its environment.

## Testing it

`npm run test:store` runs a cloud and a store server side by side on this
machine, takes the cloud away, rings a sale on the store server, brings
the cloud back and checks the sale arrives.
