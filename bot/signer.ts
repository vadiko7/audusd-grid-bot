import path from "node:path";
import { SignerClient } from "@specialjp/lighter-sdk";
import { LIGHTER_REST } from "../src/lib/grid/constants.ts";

export type LighterCreds = {
  accountIndex: number;
  apiKeyIndex: number;
  privateKey: string;
};

export type SignedTx = {
  txType: number;
  txInfo: string;
};

type TxApi = {
  sendTx: (...args: unknown[]) => Promise<unknown>;
  sendTxWithIndices: (...args: unknown[]) => Promise<unknown>;
};

const wasmDir = path.join(process.cwd(), "node_modules/@specialjp/lighter-sdk/wasm");

function wasmConfig() {
  return {
    wasmPath: path.join(wasmDir, "lighter-signer.wasm"),
    wasmExecPath: path.join(wasmDir, "wasm_exec.js"),
  };
}

const cache = new Map<string, SignerClient>();

async function getClient(creds: LighterCreds): Promise<SignerClient> {
  const key = `${creds.accountIndex}:${creds.apiKeyIndex}:${creds.privateKey.slice(0, 8)}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const client = new SignerClient({
    url: LIGHTER_REST,
    privateKey: creds.privateKey.replace(/^0x/, ""),
    accountIndex: creds.accountIndex,
    apiKeyIndex: creds.apiKeyIndex,
    wasmConfig: wasmConfig(),
  });
  await client.initialize();
  await client.ensureWasmClient();
  cache.set(key, client);
  return client;
}

async function captureSign(client: SignerClient, run: () => Promise<unknown>): Promise<SignedTx> {
  const api = (client as unknown as { transactionApi: TxApi }).transactionApi;
  let captured: SignedTx | null = null;
  const origIdx = api.sendTxWithIndices;
  const orig = api.sendTx;
  const stub = async (txType: unknown, txInfo: unknown) => {
    captured = { txType: Number(txType), txInfo: String(txInfo) };
    return { code: 200, hash: "signed-only" };
  };
  api.sendTxWithIndices = stub;
  api.sendTx = stub;
  try {
    const result = await run();
    if (!captured) {
      const err = Array.isArray(result) ? result[2] : null;
      throw new Error(typeof err === "string" && err ? err : "WASM sign produced no tx");
    }
    return captured;
  } finally {
    api.sendTxWithIndices = origIdx;
    api.sendTx = orig;
  }
}

export async function createAuthToken(creds: LighterCreds): Promise<string> {
  const client = await getClient(creds);
  const token = await client.createAuthTokenWithExpiry(60 * 60);
  if (!token) throw new Error("Failed to create Lighter auth token");
  return token;
}

export async function signCreateLimit(
  creds: LighterCreds,
  params: {
    marketIndex: number;
    clientOrderIndex: number;
    baseAmount: number;
    price: number;
    isAsk: boolean;
    reduceOnly?: boolean;
  },
): Promise<SignedTx> {
  const client = await getClient(creds);
  return captureSign(client, () =>
    client.createOrder({
      marketIndex: params.marketIndex,
      clientOrderIndex: params.clientOrderIndex,
      baseAmount: params.baseAmount,
      price: params.price,
      isAsk: params.isAsk,
      orderType: SignerClient.ORDER_TYPE_LIMIT,
      timeInForce: SignerClient.ORDER_TIME_IN_FORCE_GOOD_TILL_TIME,
      reduceOnly: Boolean(params.reduceOnly),
      triggerPrice: SignerClient.NIL_TRIGGER_PRICE,
      orderExpiry: SignerClient.DEFAULT_28_DAY_ORDER_EXPIRY,
    }),
  );
}

export async function signCancelOrder(
  creds: LighterCreds,
  params: { marketIndex: number; orderIndex: number },
): Promise<SignedTx> {
  const client = await getClient(creds);
  return captureSign(client, () => client.cancelOrder(params));
}

export async function signCancelAll(creds: LighterCreds): Promise<SignedTx> {
  const client = await getClient(creds);
  return captureSign(client, () => client.cancelAllOrders(SignerClient.CANCEL_ALL_TIF_IMMEDIATE, Date.now()));
}
