# audusd-grid-bot

AUDUSD short + NATGAS long geometric grids, plus **SPCX long accumulate** (3× equity buy cap, harvest rips). Headless on the Oracle VM.
Keys live in `.env` on disk — fill once, systemd reads them after reboot.

`MARKETS=AUDUSD,NATGAS,SPCX` (default). SPCX is m194, $25 tickets, no shorts. `highest_lvl` ratchets up on fills and is saved in `data/settings.json`.

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
