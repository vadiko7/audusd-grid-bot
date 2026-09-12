# audusd-grid-bot

NATGAS long geometric grid, plus **SPCX**, **TSLA**, **ETH**, **GEV**, **XAU**, and **BTC** long accumulate (3× equity buy cap, harvest rips). Headless on the Oracle VM.
Keys live in `.env` on disk — fill once, systemd reads them after reboot.

`MARKETS=NATGAS,SPCX,TSLA,ETH,GEV,XAU,BTC` (default; AUDUSD off). Entry is 1 step; TP is 1.1 steps and **reduce-only limit**. NATGAS 2.00% / 2.20% · 10x. SPCX 1.00% / 1.10%. TSLA 0.75% / 0.825%. ETH 0.80% / 0.88% · 50x. GEV 0.80% / 0.88% · 10x. XAU 0.50% / 0.55% · 25x. BTC 0.60% / 0.66% · 50x. Accumulate books: $25 tickets, no shorts, harvest 25% of $/lvl floored at $13. Impulse-cool catch-up is a **limit at mid** (never a market). After it is placed, mid becomes lastFill and ±1 continues around it. Cap 8 levels from mid; leave 8 levels of position/capacity (no flip) — if not enough, skip bunch and continue as is. Only the pre-impulse ±1 is cancelled; every other leftover limit is held until fill and ignored when later ±1 fill.

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
