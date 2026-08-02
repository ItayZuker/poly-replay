# Overview

Poly Real is Trigger-driven Polymarket **up/down** trading: define Market Triggers, arm them for Trade, watch Live hour-slot results on the Schedule grid, and test strategies in Replay.

## What you can do

- Watch live windows (quotes, chart, PTB vs price)
- Create **Market Triggers** (detector rules + Demo/Trade)
- See every UTC hour on **Schedule** with Trigger Trade stats + P/L
- Use **Replay** to trial local triggers over recent history
- Run **demo**, then **live** with your wallet (**Allow trade**)
- Use the **Heatmap** for historical window activity
- Admins manage per-market **Available**, **Recording**, and **retention** in Admin CRM; deploy as recorder and/or live trader (`TRADING_EXECUTOR`)

## Pages

| Page | Purpose |
|------|---------|
| **Market** | Live window, Triggers, trades, positions — [Market](doc:market) |
| **Schedule / Heatmap** | Hour-slot Trigger stats, Replay, heatmap — [Schedule](doc:schedule) |
| **Settings** | Profile and wallet — [Settings & wallet](doc:settings) |

## Concepts

| Term | Meaning |
|------|---------|
| **Series** | Market type, e.g. `btc-5m` — schedule and trading are per series |
| **Window** | One timed up/down market until expiry |
| **Trigger** | Detector rule (Duration / Price / gaps / exits) — Market Triggers trade live; Replay Triggers are local to Schedule Replay |
| **Schedule** | 7×24 UTC hour cells showing Trigger Trade aggregates (**Live**). **Replay** is a separate board for historical what-if runs |
| **Demo vs live** | Demo simulates on the trigger card; live sends CLOB orders when **Allow trade** is on, the wallet is set, and the trigger is **Trade** + **Active** |
