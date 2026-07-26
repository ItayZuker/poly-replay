# Settings & wallet

## Profile

Display name, log out, or delete account.

## Trading credentials

Both are required to unlock Market and Schedule:

| Field | Meaning |
|-------|---------|
| **Funder address** | Polymarket proxy / profile wallet that holds USDC |
| **Private key** | EOA signer for CLOB orders (encrypted; not shown again after save) |

In-app info next to each field shows where to find values on Polymarket.

## Wallet gate

If either credential is missing, Market and Schedule stay locked until both are saved.

## Safety

- Never share your private key
- Start with **Allow trade** off (demo) after saving credentials
- Confirm the funder matches the wallet you fund with USDC

## Process roles (server env)

These are set on the **server**, not in this UI:

| Variable | Meaning |
|----------|---------|
| `TRADING_EXECUTOR` | This process may place real CLOB orders (and will not record) |
| `SCHEDULE_REPLAY_SERVICE_URL` | On a live process: URL of the recorder’s replay worker |
| `SCHEDULE_REPLAY_WORKER_SECRET` | Optional shared secret between live and recorder |

Per-series **Recording** is a Market → Trade toggle (not an env var). See [Market](doc:market) and [Information flow](doc:data-flow).
