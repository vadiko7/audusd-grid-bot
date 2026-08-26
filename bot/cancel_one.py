#!/usr/bin/env python3
"""Cancel one Lighter order by 64-bit order_index (ARM .so uses c_longlong)."""
from __future__ import annotations

import asyncio
import os
import sys


async def main() -> None:
    if len(sys.argv) < 3:
        print("usage: cancel_one.py MARKET_ID ORDER_INDEX", file=sys.stderr)
        sys.exit(2)
    market = int(sys.argv[1])
    order = int(sys.argv[2])
    from lighter.signer_client import SignerClient

    key = os.environ["LIGHTER_API_PRIVATE_KEY"].replace("0x", "").strip()
    api_idx = int(os.environ.get("LIGHTER_API_KEY_INDEX", "4"))
    client = SignerClient(
        url=os.environ.get("LIGHTER_REST", "https://mainnet.zklighter.elliot.ai"),
        account_index=int(os.environ["LIGHTER_ACCOUNT_INDEX"]),
        api_private_keys={api_idx: key},
    )
    _tx, resp, err = await client.cancel_order(market_index=market, order_index=order)
    if err:
        print("err", err, file=sys.stderr)
        sys.exit(1)
    h = getattr(resp, "tx_hash", None) or getattr(resp, "hash", None) or resp
    print("ok", h)


if __name__ == "__main__":
    asyncio.run(main())
