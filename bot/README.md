# audusd-grid-bot

NATGAS + **SPCX**, **TSLA**, **ETH**, **GEV**, **XAU**, and **BTC** long accumulate. Headless on the Oracle VM.
Keys live in `.env` on disk — fill once, systemd reads them after reboot.

`MARKETS=NATGAS,SPCX,TSLA,ETH,GEV,XAU,BTC` (default; AUDUSD off). Sleeves from **90% of Lighter full equity** (off-exchange cash ignored). Buy cap is **sleeve × 3** only — no cash-floor halt. Weights / bands: SPCX 19.8% (18–28), GEV 18% (16–24), XAU 16.2% (14–23), TSLA 11.7% (10–17), BTC 9.9% (8–15), NATGAS 8.1% (6–12), ETH 6.3% (5–10). Underweight (`w ≤ band_low`): `highest_lvl := mark`, every reduce-only sell is 25%. In/above band: ATH ratchets up only; sell ≥ ATH 25%, below 90%. `band_high` is informational. Entry 1 step; TP 1.1 steps reduce-only. Proximity **1.25 × spacing**. NATGAS 2.00%. Ticket $25, harvest floor $13. Impulse-cool catch-up is a **limit at mid**. Cap 8 levels from mid; leave 8 levels (no flip).

## First setup (VM)

```bash
cd ~/audusd-grid-bot
cp -n .env.example .env
nano .env
```

Fill `LIGHTER_ACCOUNT_INDEX` and `LIGHTER_API_PRIVATE_KEY`. Leave `ARM=0`.
Save: Ctrl+O, Enter, Ctrl+X. `.env` is not committed. Do not type keys again unless you delete the file.

```bash
npm install
sudo bash deploy/install-systemd.sh
```

Watch logs:

```bash
journalctl -u audusd-grid -f
```

Status JSON on the VM:

```bash
curl -s http://127.0.0.1:8787/status
```

## Desk in Windows browser

Keep this SSH session open (local tunnel):

```powershell
ssh -i $env:USERPROFILE\Downloads\of.pem -L 8787:127.0.0.1:8787 ubuntu@158.179.182.249
```

Then open http://127.0.0.1:8787/ — numbers update in place, the page does not reload.

Arm (real $25 limits): button on that page, or:

```bash
curl -s -X POST http://127.0.0.1:8787/arm
```

Disarm / flatten: same with `/disarm` and `/flatten`.

USD per level (anytime, no restart). Desk field **$ / level** → **Set**, or:

```bash
curl -s -X POST 'http://127.0.0.1:8787/notional?usd=50'
```

Range 10–10000. Saved in `data/settings.json` so reboot keeps it. If armed, working limits are cancelled and re-placed at the new size.

## Update code (keys stay)

```bash
cd ~/audusd-grid-bot
git pull
sudo systemctl restart audusd-grid
```
