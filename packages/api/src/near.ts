import Big from "big.js";
import { WalletAdapter } from "@fastnear/wallet-adapter";
import * as cryptoUtils from "./cryptoUtils.js";
import {
  canSignWithLAK,
  fromBase58,
  fromBase64,
  lsGet,
  lsSet,
  toBase58,
  toBase64,
  tryParseJson,
} from "./utils";
import {
  serializeSignedTransaction,
  serializeTransaction,
} from "./transaction";

Big.DP = 27;

// Constants
const MaxBlockDelayMs = 1000 * 60 * 60 * 6; // 6 hours

const WIDGET_URL = "https://wallet-adapter.fastnear.com";

const DEFAULT_NETWORK_ID = "mainnet";
const NETWORKS = {
  testnet: {
    networkId: "testnet",
    nodeUrl: "https://rpc.testnet.fastnear.com/",
  },
  mainnet: {
    networkId: "mainnet",
    nodeUrl: "https://rpc.mainnet.fastnear.com/",
  },
};

// State
let _config = lsGet("config") || { ...NETWORKS[DEFAULT_NETWORK_ID] };

let _state = lsGet("state") || {};
try {
  _state.publicKey = _state.privateKey
    ? cryptoUtils.publicKeyFromPrivate(_state.privateKey)
    : null;
} catch (e) {
  console.error("Error parsing private key:", e);
  _state.privateKey = null;
  lsSet("nonce", null);
}

// TODO: Store tx history in local storage more efficiently
let _txHistory = lsGet("txHistory") || {};
const _eventListeners = {
  account: new Set(),
  tx: new Set(),
};
const _unbroadcastedEvents = {
  account: [],
  tx: [],
};

function getWalletAdapterState() {
  return {
    publicKey: _state.publicKey,
    accountId: _state.accountId,
    lastWalletId: _state.lastWalletId,
    networkId: DEFAULT_NETWORK_ID,
  };
}
let _adapter;

function updateState(newState: Record<string, any>) {
  const oldState = _state;
  _state = { ..._state, ...newState };
  lsSet("state", {
    accountId: _state.accountId,
    privateKey: _state.privateKey,
    lastWalletId: _state.lastWalletId,
    accessKeyContractId: _state.accessKeyContractId,
  });
  if (
    newState.hasOwnProperty("privateKey") &&
    newState.privateKey !== oldState.privateKey
  ) {
    _state.publicKey = newState.privateKey
      ? cryptoUtils.publicKeyFromPrivate(newState.privateKey)
      : null;
    lsSet("nonce", null);
  }
  if (newState.accountId !== oldState.accountId) {
    notifyAccountListeners(newState.accountId);
  }
  if (
    (newState.hasOwnProperty("lastWalletId") &&
      newState.lastWalletId !== oldState.lastWalletId) ||
    (newState.hasOwnProperty("accountId") &&
      newState.accountId !== oldState.accountId) ||
    (newState.hasOwnProperty("privateKey") &&
      newState.privateKey !== oldState.privateKey)
  ) {
    _adapter.setState(getWalletAdapterState());
  }
}

function updateTxHistory(txStatus: Record<string, any>) {
  const txId = txStatus.txId;
  _txHistory[txId] = {
    ...(_txHistory[txId] ?? {}),
    ...txStatus,
    updateTimestamp: Date.now(),
  };
  lsSet("txHistory", _txHistory);
  notifyTxListeners(_txHistory[txId]);
}

function onAdapterStateUpdate(state: Record<string, any>) {
  console.log("Adapter state update:", state);
  const { accountId, lastWalletId, privateKey } = state;
  updateState({
    accountId,
    lastWalletId,
    ...(privateKey && { privateKey }),
  });
}

// Create adapter instance
_adapter = new WalletAdapter({
  onStateUpdate: onAdapterStateUpdate,
  lastState: getWalletAdapterState(),
  widgetUrl: WIDGET_URL,
});

// Utils
export function parseJsonFromBytes(bytes: Uint8Array) {
  try {
    const decoder = new TextDecoder();
    return JSON.parse(decoder.decode(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)));
  } catch (e) {
    try {
      return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    } catch (e) {
      return bytes;
    }
  }
}

function withBlockId(params: Record<string, any>, blockId?: string) {
  return blockId === "final" || blockId === "optimistic"
    ? { ...params, finality: blockId }
    : blockId
      ? { ...params, block_id: blockId }
      : { ...params, finality: "optimistic" };
}

async function queryRpc(method: string, params: Record<string, any> | any[]) {
  const response = await fetch(_config.nodeUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `fastnear-${Date.now()}`,
      method,
      params,
    }),
  });

  const result = await response.json();
  if (result.error) {
    throw new Error(JSON.stringify(result.error));
  }
  return result.result;
}

function afterTxSent(txId: string) {
  queryRpc("tx", {
    tx_hash: _txHistory[txId].txHash,
    sender_account_id: _txHistory[txId].tx.signerId,
    wait_until: "EXECUTED_OPTIMISTIC",
  })
    .then((result) => {
      const successValue = result?.status?.SuccessValue;
      updateTxHistory({
        txId,
        status: "Executed",
        result,
        successValue: successValue
          ? tryParseJson(fromBase64(successValue))
          : undefined,
        finalState: true,
      });
    })
    .catch((error) => {
      updateTxHistory({
        txId,
        status: "ErrorAfterIncluded",
        error: tryParseJson(error.message),
        finalState: true,
      });
    });
}

function sendTxToRpc(
  signedTxBase64: string,
  waitUntil: string | undefined,
  txId: string,
) {
  queryRpc("send_tx", {
    signed_tx_base64: signedTxBase64,
    wait_until: waitUntil ?? "INCLUDED",
  })
    .then((result) => {
      console.log("Transaction included:", result);
      updateTxHistory({
        txId,
        status: "Included",
        finalState: false,
      });
      afterTxSent(txId);
    })
    .catch((error) => {
      updateTxHistory({
        txId,
        status: "Error",
        error: tryParseJson(error.message),
        finalState: false,
      });
    });
}

// Event Notifiers
function notifyAccountListeners(accountId: string) {
  if (_eventListeners.account.size === 0) {
    _unbroadcastedEvents.account.push(accountId);
    return;
  }
  _eventListeners.account.forEach((callback: any) => {
    try {
      callback(accountId);
    } catch (e) {
      console.error(e);
    }
  });
}

function notifyTxListeners(tx: Record<string, any>) {
  if (_eventListeners.tx.size === 0) {
    _unbroadcastedEvents.tx.push(tx);
    return;
  }
  _eventListeners.tx.forEach((callback: any) => {
    try {
      callback(tx);
    } catch (e) {
      console.error(e);
    }
  });
}

function convertUnit(s: string | TemplateStringsArray, ...args: any[]): string {
  // Reconstruct raw string from template literal
  if (Array.isArray(s)) {
    s = s.reduce((acc, part, i) => {
      return acc + (args[i - 1] ?? "") + part;
    });
  }
  // Convert from `100 NEAR` into yoctoNear
  if (typeof s == "string") {
    const match = s.match(/([0-9.,_]+)\s*([a-zA-Z]+)?/);
    if (match) {
      const amount = match[1].replace(/[_,]/g, "");
      const unitPart = match[2];
      if (unitPart) {
        switch (unitPart.toLowerCase()) {
          case "near":
            return Big(amount).mul(Big(10).pow(24)).toFixed(0);
          case "tgas":
            return Big(amount).mul(Big(10).pow(12)).toFixed(0);
          case "ggas":
            return Big(amount).mul(Big(10).pow(9)).toFixed(0);
          case "gas":
          case "yoctonear":
            return Big(amount).toFixed(0);
          default:
            throw new Error(`Unknown unit: ${unitPart}`);
        }
      } else {
        return Big(amount).toFixed(0);
      }
    }
  }
  return Big(s).toFixed(0);
}

interface AccessKeyView {
  nonce: number;
  permission: any;
}

// Core API Implementation
const api = {
  // Context
  get accountId() {
    return _state.accountId;
  },

  get publicKey() {
    return _state.publicKey;
  },

  config(newConfig?: Record<string, any>) {
    if (newConfig) {
      if (newConfig.networkId && _config.networkId !== newConfig.networkId) {
        _config = { ...NETWORKS[newConfig.networkId] };
        updateState({
          accountId: null,
          privateKey: null,
          lastWalletId: null,
        });
        lsSet("block", null);
        _txHistory = {};
        lsSet("txHistory", _txHistory);
      }

      _config = { ..._config, ...newConfig };
      lsSet("config", _config);
    }
    return _config;
  },

  get authStatus(): string | Record<string, any> {
    if (!_state.accountId) {
      return "SignedOut";
    }

    // Check for limited access key
    const accessKey = _state.publicKey;
    const contractId = _state.accessKeyContractId;
    if (accessKey && contractId && _state.privateKey) {
      return {
        type: "SignedInWithLimitedAccessKey",
        accessKey,
        contractId,
      };
    }
    return "SignedIn";
  },

  // Query Methods
  async view({
               contractId,
               methodName,
               args,
               argsBase64,
               blockId,
             }: {
    contractId: string;
    methodName: string;
    args?: any;
    argsBase64?: string;
    blockId?: string;
  }) {
    const encodedArgs =
      argsBase64 || (args ? toBase64(JSON.stringify(args)) : "");

    const result = await queryRpc(
      "query",
      withBlockId(
        {
          request_type: "call_function",
          account_id: contractId,
          method_name: methodName,
          args_base64: encodedArgs,
        },
        blockId,
      ),
    );

    return parseJsonFromBytes(result.result);
  },

  async account({
                  accountId,
                  blockId,
                }: {
    accountId: string;
    blockId?: string;
  }) {
    return queryRpc(
      "query",
      withBlockId(
        {
          request_type: "view_account",
          account_id: accountId,
        },
        blockId,
      ),
    );
  },

  async block({ blockId }: { blockId?: string }) {
    return queryRpc("block", withBlockId({}, blockId));
  },

  async accessKey({
                    accountId,
                    publicKey,
                    blockId,
                  }: {
    accountId: string;
    publicKey: string;
    blockId?: string;
  }): Promise<AccessKeyView> {
    return queryRpc(
      "query",
      withBlockId(
        {
          request_type: "view_access_key",
          account_id: accountId,
          public_key: publicKey,
        },
        blockId,
      ),
    );
  },

  async tx({ txHash, accountId }: { txHash: string; accountId: string }) {
    return queryRpc("tx", [txHash, accountId]);
  },

  localTxHistory() {
    return [..._txHistory];
  },

  // Transaction Methods
  async sendTx({
                 receiverId,
                 actions,
                 waitUntil,
               }: {
    receiverId: string;
    actions: any[];
    waitUntil?: string;
  }) {
    const signerId = _state.accountId;
    if (!signerId) {
      throw new Error("Not signed in");
    }

    const publicKey = _state.publicKey;
    const privateKey = _state.privateKey;
    const txId = `tx-${Date.now()}-${Math.random()}`;

    if (
      !privateKey ||
      receiverId !== _state.accessKeyContractId ||
      !canSignWithLAK(actions)
    ) {
      const jsonTransaction = {
        signerId,
        receiverId,
        actions,
      };

      updateTxHistory({
        status: "Pending",
        txId,
        tx: jsonTransaction,
        finalState: false,
      });

      const url = new URL(typeof window !== "undefined" ? window.location.href : "");
      url.searchParams.set("txIds", txId);

      _adapter
        .sendTransactions({
          transactions: [jsonTransaction],
          callbackUrl: url.toString(),
        })
        .then((result: any) => {
          console.log("Transaction result:", result);
          if (result.url) {
            console.log("Redirecting to wallet:", result.url);
            if (typeof window !== "undefined") {
              setTimeout(() => {
                window.location.href = result.url;
              }, 100);
            }
          } else if (result.outcomes) {
            result.outcomes.forEach((r: any) => {
              updateTxHistory({
                txId,
                status: "Executed",
                result: r,
                txHash: r.transaction.hash,
                finalState: true,
              });
            });
          } else if (result.rejected) {
            updateTxHistory({
              txId,
              status: "RejectedByUser",
              finalState: true,
            });
          } else if (result.error) {
            updateTxHistory({
              txId,
              status: "Error",
              error: tryParseJson(result.error),
              finalState: true,
            });
          }
        })
        .catch((error: any) => {
          updateTxHistory({
            txId,
            status: "Error",
            error: tryParseJson(error.message),
            finalState: true,
          });
        });
      return txId;
    }

    let nonce: number | null = lsGet("nonce") as any;
    let block: any = lsGet("block") as any;
    const toDoPromises: Record<string, Promise<any>> = {};

    if (nonce === null || nonce === undefined) {
      toDoPromises.nonce = api.accessKey({
        accountId: signerId,
        publicKey,
      }).then((accessKey) => {
        if ((accessKey as any).error) {
          throw new Error(`Access key error: ${(accessKey as any).error}`);
        }
        lsSet("nonce", accessKey.nonce);
        return accessKey.nonce;
      });
    }

    if (
      !block ||
      !block.header ||
      parseFloat(block.header.timestamp_nanosec) / 1e6 + MaxBlockDelayMs <
      Date.now()
    ) {
      toDoPromises.block = api.block({ blockId: "final" }).then((b: any) => {
        const newBlock = {
          header: {
            prev_hash: b.header.prev_hash,
            timestamp_nanosec: b.header.timestamp_nanosec,
          },
        };
        lsSet("block", newBlock);
        return newBlock;
      });
    }

    if (Object.keys(toDoPromises).length > 0) {
      const results = await Promise.all(Object.values(toDoPromises));
      const keys = Object.keys(toDoPromises);
      results.forEach((res, i) => {
        if (keys[i] === "nonce") {
          nonce = res;
        } else if (keys[i] === "block") {
          block = res;
        }
      });
    }

    const newNonce = (nonce ?? 0) + 1;
    lsSet("nonce", newNonce);
    const blockHash = block.header.prev_hash;

    const jsonTransaction = {
      signerId,
      publicKey,
      nonce: newNonce,
      receiverId,
      blockHash,
      actions,
    };

    console.log("Transaction:", jsonTransaction);
    const transaction = serializeTransaction(jsonTransaction);
    const txHash = toBase58(cryptoUtils.sha256(transaction));
    const signature = cryptoUtils.signHash(txHash, privateKey);
    const signedTransaction = serializeSignedTransaction(jsonTransaction, signature);
    const signedTxBase64 = toBase64(signedTransaction);

    updateTxHistory({
      status: "Pending",
      txId,
      tx: jsonTransaction,
      signature,
      signedTxBase64,
      txHash,
      finalState: false,
    });

    sendTxToRpc(signedTxBase64, waitUntil, txId);

    return txId;
  },

  // Authentication Methods
  async requestSignIn({ contractId }: { contractId: string }) {
    const privateKey = cryptoUtils.privateKeyFromRandom();
    updateState({
      accessKeyContractId: contractId,
      accountId: null,
      privateKey,
    });
    const publicKey = cryptoUtils.publicKeyFromPrivate(privateKey);
    const result = await _adapter.signIn({
      networkId: _config.networkId,
      contractId,
      publicKey,
    });
    console.log("Sign in result:", result);
    if (result.error) {
      throw new Error(`Wallet error: ${result.error}`);
    }
    if (result.url) {
      console.log("Redirecting to wallet:", result.url);
      if (typeof window !== "undefined") {
        setTimeout(() => {
          window.location.href = result.url;
        }, 100);
      }
    } else if (result.accountId) {
      updateState({
        accountId: result.accountId,
      });
    }
  },

  signOut() {
    updateState({
      accountId: null,
      privateKey: null,
      contractId: null,
    });
    // TODO: Implement actual wallet integration
  },

  // Event Handlers
  onAccount(callback: (accountId: string) => void) {
    _eventListeners.account.add(callback);
    if (_unbroadcastedEvents.account.length > 0) {
      const events = _unbroadcastedEvents.account;
      _unbroadcastedEvents.account = [];
      events.forEach(notifyAccountListeners);
    }
  },

  onTx(callback: (tx: Record<string, any>) => void) {
    _eventListeners.tx.add(callback);
    if (_unbroadcastedEvents.tx.length > 0) {
      const events = _unbroadcastedEvents.tx;
      _unbroadcastedEvents.tx = [];
      events.forEach(notifyTxListeners);
    }
  },

  // Action Helpers
  actions: {
    functionCall: ({
                     methodName,
                     gas,
                     deposit,
                     args,
                     argsBase64,
                   }: {
      methodName: string;
      gas?: string;
      deposit?: string;
      args?: Record<string, any>;
      argsBase64?: string;
    }) => ({
      type: "FunctionCall",
      methodName,
      args,
      argsBase64,
      gas,
      deposit,
    }),

    transfer: (yoctoAmount: string) => ({
      type: "Transfer",
      deposit: yoctoAmount,
    }),

    stakeNEAR: ({ amount, publicKey }: { amount: string; publicKey: string }) => ({
      type: "Stake",
      stake: amount,
      publicKey,
    }),

    addFullAccessKey: ({ publicKey }: { publicKey: string }) => ({
      type: "AddKey",
      publicKey: publicKey,
      accessKey: { permission: "FullAccess" },
    }),

    addLimitedAccessKey: ({
                            publicKey,
                            allowance,
                            accountId,
                            methodNames,
                          }: {
      publicKey: string;
      allowance: string;
      accountId: string;
      methodNames: string[];
    }) => ({
      type: "AddKey",
      publicKey: publicKey,
      accessKey: {
        permission: "FunctionCall",
        allowance,
        receiverId: accountId,
        methodNames,
      },
    }),

    deleteKey: ({ publicKey }: { publicKey: string }) => ({
      type: "DeleteKey",
      publicKey,
    }),

    deleteAccount: ({ beneficiaryId }: { beneficiaryId: string }) => ({
      type: "DeleteAccount",
      beneficiaryId,
    }),

    createAccount: () => ({
      type: "CreateAccount",
    }),

    deployContract: ({ codeBase64 }: { codeBase64: string }) => ({
      type: "DeployContract",
      codeBase64,
    }),
  },

  utils: {
    toBase64,
    fromBase64,
    toBase58,
    fromBase58,
  },
};

// Handle wallet redirect if applicable
try {
  if (typeof window !== "undefined") {
    const url = new URL(window.location.href);
    const accountId = url.searchParams.get("account_id");
    const publicKey = url.searchParams.get("public_key");
    const errorCode = url.searchParams.get("errorCode");
    const errorMessage = url.searchParams.get("errorMessage");
    const transactionHashes = url.searchParams.get("transactionHashes");
    const txIds = url.searchParams.get("txIds");

    if (errorCode || errorMessage) {
      console.warn(new Error(`Wallet error: ${errorCode} ${errorMessage}`));
    }

    if (accountId && publicKey) {
      if (publicKey === _state.publicKey) {
        updateState({
          accountId,
        });
      } else {
        console.error(
          new Error("Public key mismatch from wallet redirect"),
          publicKey,
          _state.publicKey,
        );
      }
    }

    if (transactionHashes || txIds) {
      const txHashes = transactionHashes ? transactionHashes.split(",") : [];
      const txIdsArray = txIds ? txIds.split(",") : [];
      if (txIdsArray.length > txHashes.length) {
        txIdsArray.forEach((txId, i) => {
          updateTxHistory({
            txId,
            status: "RejectedByUser",
            finalState: true,
          });
        });
      } else if (txIdsArray.length === txHashes.length) {
        txIdsArray.forEach((txId, i) => {
          updateTxHistory({
            txId,
            status: "PendingGotTxHash",
            txHash: txHashes[i],
            finalState: false,
          });
          afterTxSent(txId);
        });
      } else {
        console.error(
          new Error("Transaction hash mismatch from wallet redirect"),
          txIdsArray,
          txHashes,
        );
      }
    }

    // Remove wallet parameters from the URL
    url.searchParams.delete("account_id");
    url.searchParams.delete("public_key");
    url.searchParams.delete("errorCode");
    url.searchParams.delete("errorMessage");
    url.searchParams.delete("all_keys");
    url.searchParams.delete("transactionHashes");
    url.searchParams.delete("txIds");
    window.history.replaceState({}, "", url.toString());
  }
} catch (e) {
  console.error("Error handling wallet redirect:", e);
}

export { api, convertUnit };

// import Big from "big.js";
// import { WalletAdapter } from "@fastnear/wallet-adapter";
// import * as cryptoUtils from "./cryptoUtils.js";
// import {
//   canSignWithLAK,
//   fromBase58,
//   fromBase64,
//   lsGet,
//   lsSet,
//   toBase58,
//   toBase64,
//   tryParseJson,
// } from "./utils";
// import {
//   serializeSignedTransaction,
//   serializeTransaction,
// } from "./transaction";
//
// Big.DP = 27;
//
// // Constants
// const MaxBlockDelayMs = 1000 * 60 * 60 * 6; // 6 hours
//
// // const WIDGET_URL = "https://wallet-adapter.fastnear.com";
// const WIDGET_URL = "http://localhost:3000/";
//
// const DEFAULT_NETWORK_ID = "mainnet";
// const NETWORKS = {
//   testnet: {
//     networkId: "testnet",
//     nodeUrl: "https://rpc.testnet.fastnear.com/",
//   },
//   mainnet: {
//     networkId: "mainnet",
//     nodeUrl: "https://rpc.mainnet.fastnear.com/",
//   },
// };
//
// // State
// let _config = lsGet("config") || { ...NETWORKS[DEFAULT_NETWORK_ID] };
//
// let _state = lsGet("state") || {};
// try {
//   _state.publicKey = _state.privateKey
//     ? cryptoUtils.publicKeyFromPrivate(_state.privateKey)
//     : null;
// } catch (e) {
//   console.error("Error parsing private key:", e);
//   _state.privateKey = null;
//   lsSet("nonce", null);
// }
//
// // TODO: Store tx history in local storage more efficiently
// let _txHistory = lsGet("txHistory") || {};
// const _eventListeners = {
//   account: new Set(),
//   tx: new Set(),
// };
// const _unbroadcastedEvents = {
//   account: [],
//   tx: [],
// };
//
// function getWalletAdapterState() {
//   return {
//     publicKey: _state.publicKey,
//     accountId: _state.accountId,
//     lastWalletId: _state.lastWalletId,
//     networkId: DEFAULT_NETWORK_ID,
//   };
// }
// let _adapter;
//
// function updateState(newState) {
//   const oldState = _state;
//   _state = { ..._state, ...newState };
//   lsSet("state", {
//     accountId: _state.accountId,
//     privateKey: _state.privateKey,
//     lastWalletId: _state.lastWalletId,
//     accessKeyContractId: _state.accessKeyContractId,
//   });
//   if (
//     newState.hasOwnProperty("privateKey") &&
//     newState.privateKey !== oldState.privateKey
//   ) {
//     _state.publicKey = newState.privateKey
//       ? cryptoUtils.publicKeyFromPrivate(newState.privateKey)
//       : null;
//     lsSet("nonce", null);
//   }
//   if (newState.accountId !== oldState.accountId) {
//     notifyAccountListeners(newState.accountId);
//   }
//   if (
//     (newState.hasOwnProperty("lastWalletId") &&
//       newState.lastWalletId !== oldState.lastWalletId) ||
//     (newState.hasOwnProperty("accountId") &&
//       newState.accountId !== oldState.accountId) ||
//     (newState.hasOwnProperty("privateKey") &&
//       newState.privateKey !== oldState.privateKey)
//   ) {
//     _adapter.setState(getWalletAdapterState());
//   }
// }
//
// function updateTxHistory(txStatus) {
//   const txId = txStatus.txId;
//   _txHistory[txId] = {
//     ...(_txHistory[txId] ?? {}),
//     ...txStatus,
//     updateTimestamp: Date.now(),
//   };
//   lsSet("txHistory", _txHistory);
//   notifyTxListeners(_txHistory[txId]);
// }
//
// function onAdapterStateUpdate(state) {
//   console.log("Adapter state update:", state);
//   const { accountId, lastWalletId, privateKey } = state;
//   updateState({
//     accountId,
//     lastWalletId,
//     ...(privateKey && { privateKey }),
//   });
// }
//
// // Create adapter instance
// _adapter = new WalletAdapter({
//   onStateUpdate: onAdapterStateUpdate,
//   lastState: getWalletAdapterState(),
//   widgetUrl: WIDGET_URL,
// });
//
// // Utils
// export function parseJsonFromBytes(bytes: Uint8Array) {
//   try {
//     const decoder = new TextDecoder();
//     return JSON.parse(decoder.decode(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)));
//   } catch (e) {
//     try {
//       return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
//     } catch (e) {
//       return bytes;
//     }
//   }
// }
//
// function withBlockId(params, blockId) {
//   return blockId === "final" || blockId === "optimistic"
//     ? { ...params, finality: blockId }
//     : !!blockId
//       ? { ...params, block_id: blockId }
//       : { ...params, finality: "optimistic" };
// }
//
// async function queryRpc(method, params) {
//   const response = await fetch(_config.nodeUrl, {
//     method: "POST",
//     headers: { "Content-Type": "application/json" },
//     body: JSON.stringify({
//       jsonrpc: "2.0",
//       id: `fastnear-${Date.now()}`,
//       method,
//       params,
//     }),
//   });
//
//   const result = await response.json();
//   if (result.error) {
//     throw new Error(JSON.stringify(result.error));
//   }
//   return result.result;
// }
//
// function afterTxSent(txId) {
//   queryRpc("tx", {
//     tx_hash: _txHistory[txId].txHash,
//     sender_account_id: _txHistory[txId].tx.signerId,
//     wait_until: "EXECUTED_OPTIMISTIC",
//   })
//     .then((result) => {
//       const successValue = result?.status?.SuccessValue;
//       updateTxHistory({
//         txId,
//         status: "Executed",
//         result,
//         successValue: successValue
//           ? tryParseJson(fromBase64(successValue))
//           : undefined,
//         finalState: true,
//       });
//     })
//     .catch((error) => {
//       updateTxHistory({
//         txId,
//         status: "ErrorAfterIncluded",
//         error: tryParseJson(error.message),
//         finalState: true,
//       });
//     });
// }
//
// function sendTxToRpc(signedTxBase64, waitUntil, txId) {
//   queryRpc("send_tx", {
//     signed_tx_base64: signedTxBase64,
//     wait_until: waitUntil ?? "INCLUDED",
//   })
//     .then((result) => {
//       console.log("Transaction included:", result);
//       updateTxHistory({
//         txId,
//         status: "Included",
//         finalState: false,
//       });
//       afterTxSent(txId);
//     })
//     .catch((error) => {
//       // TODO: Catch nonce errors and update nonce
//       // TODO: Handle timeouts (non-final status)
//       // TODO: Handle shard congestions
//       updateTxHistory({
//         txId,
//         status: "Error",
//         error: tryParseJson(error.message),
//         finalState: false,
//       });
//     });
// }
//
// // Event Notifiers
// function notifyAccountListeners(accountId) {
//   if (_eventListeners.account.size === 0) {
//     _unbroadcastedEvents.account.push(accountId);
//     return;
//   }
//   _eventListeners.account.forEach((callback) => {
//     try {
//       callback(accountId);
//     } catch (e) {
//       console.error(e);
//     }
//   });
// }
//
// function notifyTxListeners(tx) {
//   if (_eventListeners.tx.size === 0) {
//     _unbroadcastedEvents.tx.push(tx);
//     return;
//   }
//   _eventListeners.tx.forEach((callback) => {
//     try {
//       callback(tx);
//     } catch (e) {
//       console.error(e);
//     }
//   });
// }
//
// function convertUnit(s, ...args) {
//   // Reconstruct raw string from template literal
//   if (Array.isArray(s)) {
//     s = s.reduce((acc, part, i) => {
//       return acc + (args[i - 1] ?? "") + part;
//     });
//   }
//   // Convert from `100 NEAR` into yoctoNear
//   if (typeof s == "string") {
//     let match = s.match(/([0-9.,_]+)\s*([a-zA-Z]+)?/);
//     if (match) {
//       let amount = match[1].replace(/[_,]/g, "");
//       let unitPart = match[2];
//       if (unitPart) {
//         switch (unitPart.toLowerCase()) {
//           case "near":
//             return Big(amount).mul(Big(10).pow(24)).toFixed(0);
//           case "tgas":
//             return Big(amount).mul(Big(10).pow(12)).toFixed(0);
//           case "ggas":
//             return Big(amount).mul(Big(10).pow(9)).toFixed(0);
//           case "gas" || "yoctonear":
//             return Big(amount).toFixed(0);
//           default:
//             throw new Error(`Unknown unit: ${unit}`);
//         }
//       } else {
//         return Big(amount).toFixed(0);
//       }
//     }
//   }
//   return Big(s).toFixed(0);
// }
//
// // Core API Implementation
// const api = {
//   // Context
//   get accountId() {
//     return _state.accountId;
//   },
//
//   get publicKey() {
//     return _state.publicKey;
//   },
//
//   config(newConfig) {
//     if (newConfig) {
//       if (newConfig.networkId && _config.networkId !== newConfig.networkId) {
//         _config = { ...NETWORKS[newConfig.networkId] };
//         updateState({
//           accountId: null,
//           privateKey: null,
//           lastWalletId: null,
//         });
//         lsSet("block", null);
//         _txHistory = {};
//         lsSet("txHistory", _txHistory);
//       }
//
//       _config = { ..._config, ...newConfig };
//       lsSet("config", _config);
//     }
//     return _config;
//   },
//
//   get authStatus() {
//     if (!_state.accountId) {
//       return "SignedOut";
//     }
//
//     // Check for limited access key
//     const accessKey = _state.publicKey;
//     const contractId = _state.accessKeyContractId;
//     if (accessKey && contractId && _state.privateKey) {
//       return {
//         type: "SignedInWithLimitedAccessKey",
//         accessKey,
//         contractId,
//       };
//     }
//     return "SignedIn";
//   },
//
//   // Query Methods
//   async view({ contractId, methodName, args, argsBase64, blockId }) {
//     const encodedArgs =
//       argsBase64 || (args ? toBase64(JSON.stringify(args)) : "");
//
//     const result = await queryRpc(
//       "query",
//       withBlockId(
//         {
//           request_type: "call_function",
//           account_id: contractId,
//           method_name: methodName,
//           args_base64: encodedArgs,
//         },
//         blockId,
//       ),
//     );
//
//     return parseJsonFromBytes(result.result);
//   },
//
//   async account({ accountId, blockId }) {
//     return queryRpc(
//       "query",
//       withBlockId(
//         {
//           request_type: "view_account",
//           account_id: accountId,
//         },
//         blockId,
//       ),
//     );
//   },
//
//   async block({ blockId }) {
//     return queryRpc("block", withBlockId({}, blockId));
//   },
//
//   async accessKey({ accountId, publicKey, blockId }) {
//     return queryRpc(
//       "query",
//       withBlockId(
//         {
//           request_type: "view_access_key",
//           account_id: accountId,
//           public_key: publicKey,
//         },
//         blockId,
//       ),
//     );
//   },
//
//   async tx({ txHash, accountId }) {
//     return queryRpc("tx", [txHash, accountId]);
//   },
//
//   localTxHistory() {
//     return [..._txHistory];
//   },
//
//   // Transaction Methods
//   async sendTx({ receiverId, actions, waitUntil }) {
//     const signerId = _state.accountId;
//     if (!signerId) {
//       throw new Error("Not signed in");
//     }
//
//     const publicKey = _state.publicKey;
//     const privateKey = _state.privateKey;
//     const txId = `tx-${Date.now()}-${Math.random()}`;
//
//     if (
//       !privateKey ||
//       receiverId !== _state.accessKeyContractId ||
//       !canSignWithLAK(actions)
//     ) {
//       const jsonTransaction = {
//         signerId,
//         receiverId,
//         actions,
//       };
//
//       updateTxHistory({
//         status: "Pending",
//         txId,
//         tx: jsonTransaction,
//         finalState: false,
//       });
//
//       const url = new URL(window.location.href);
//       url.searchParams.set("txIds", txId);
//
//       _adapter
//         .sendTransactions({
//           transactions: [jsonTransaction],
//           callbackUrl: url.toString(),
//         })
//         .then((result) => {
//           console.log("Transaction result:", result);
//           if (result.url) {
//             console.log("Redirecting to wallet:", result.url);
//             setTimeout(() => {
//               window.location.href = result.url;
//             }, 100);
//           } else if (result.outcomes) {
//             result.outcomes.forEach((result) => {
//               updateTxHistory({
//                 txId,
//                 status: "Executed",
//                 result,
//                 txHash: result.transaction.hash,
//                 finalState: true,
//               });
//             });
//           } else if (result.rejected) {
//             updateTxHistory({
//               txId,
//               status: "RejectedByUser",
//               finalState: true,
//             });
//           } else if (result.error) {
//             updateTxHistory({
//               txId,
//               status: "Error",
//               error: tryParseJson(result.error),
//               finalState: true,
//             });
//           }
//         })
//         .catch((error) => {
//           updateTxHistory({
//             txId,
//             status: "Error",
//             error: tryParseJson(error.message),
//             finalState: true,
//           });
//         });
//       return txId;
//     }
//
//     const toDoPromises = {};
//     let nonce = lsGet("nonce");
//     if (nonce === null || nonce === undefined) {
//       toDoPromises.nonce = this.accessKey({
//         accountId: signerId,
//         publicKey,
//       }).then((accessKey) => {
//         if (accessKey.error) {
//           throw new Error(`Access key error: ${accessKey.error}`);
//         }
//         lsSet("nonce", accessKey.nonce);
//         return accessKey.nonce;
//       });
//     }
//     let block = lsGet("block");
//     if (
//       !block ||
//       parseFloat(block.header.timestamp_nanosec) / 1e6 + MaxBlockDelayMs <
//         Date.now()
//     ) {
//       toDoPromises.block = this.block({ blockId: "final" }).then((block) => {
//         block = {
//           header: {
//             prev_hash: block.header.prev_hash,
//             timestamp_nanosec: block.header.timestamp_nanosec,
//           },
//         };
//         lsSet("block", block);
//         return block;
//       });
//     }
//
//     if (Object.keys(toDoPromises).length > 0) {
//       let results = await Promise.all(Object.values(toDoPromises));
//       for (let i = 0; i < results.length; i++) {
//         if (Object.keys(toDoPromises)[i] === "nonce") {
//           nonce = results[i];
//         } else if (Object.keys(toDoPromises)[i] === "block") {
//           block = results[i];
//         }
//       }
//     }
//
//     const newNonce = nonce + 1;
//     lsSet("nonce", newNonce);
//     const blockHash = block.header.prev_hash;
//
//     const jsonTransaction = {
//       signerId,
//       publicKey,
//       nonce: newNonce,
//       receiverId,
//       blockHash,
//       actions,
//     };
//
//     console.log("Transaction:", jsonTransaction);
//     const transaction = serializeTransaction(jsonTransaction);
//     const txHash = toBase58(cryptoUtils.sha256(transaction));
//     const signature = cryptoUtils.signHash(txHash, privateKey);
//     const singedTransaction = serializeSignedTransaction(
//       jsonTransaction,
//       signature,
//     );
//     const signedTxBase64 = toBase64(singedTransaction);
//
//     updateTxHistory({
//       status: "Pending",
//       txId,
//       tx: jsonTransaction,
//       signature,
//       signedTxBase64,
//       txHash,
//       finalState: false,
//     });
//
//     sendTxToRpc(signedTxBase64, waitUntil, txId);
//
//     return txId;
//   },
//
//   // Authentication Methods
//   async requestSignIn({ contractId }) {
//     const privateKey = cryptoUtils.privateKeyFromRandom();
//     updateState({
//       accessKeyContractId: contractId,
//       accountId: null,
//       privateKey,
//     });
//     const publicKey = cryptoUtils.publicKeyFromPrivate(privateKey);
//     const result = await _adapter.signIn({
//       networkId: _config.networkId,
//       contractId,
//       publicKey,
//     });
//     console.log("Sign in result:", result);
//     if (result.error) {
//       throw new Error(`Wallet error: ${result.error}`);
//     }
//     if (result.url) {
//       console.log("Redirecting to wallet:", result.url);
//       setTimeout(() => {
//         window.location.href = result.url;
//       }, 100);
//     } else if (result.accountId) {
//       updateState({
//         accountId: result.accountId,
//       });
//     }
//   },
//
//   signOut() {
//     updateState({
//       accountId: null,
//       privateKey: null,
//       contractId: null,
//     });
//
//     // TODO: Implement actual wallet integration
//   },
//
//   // Event Handlers
//   onAccount(callback) {
//     _eventListeners.account.add(callback);
//     if (_unbroadcastedEvents.account.length > 0) {
//       const events = _unbroadcastedEvents.account;
//       _unbroadcastedEvents.account = [];
//       events.forEach(notifyAccountListeners);
//     }
//   },
//
//   onTx(callback) {
//     _eventListeners.tx.add(callback);
//     if (_unbroadcastedEvents.tx.length > 0) {
//       const events = _unbroadcastedEvents.tx;
//       _unbroadcastedEvents.tx = [];
//       events.forEach(notifyTxListeners);
//     }
//   },
//
//   // Action Helpers
//   actions: {
//     functionCall: ({ methodName, gas, deposit, args, argsBase64 }) => ({
//       type: "FunctionCall",
//       methodName,
//       args,
//       argsBase64,
//       gas,
//       deposit,
//     }),
//
//     transfer: (yoctoAmount) => ({
//       type: "Transfer",
//       deposit: yoctoAmount,
//     }),
//
//     stakeNEAR: ({ amount, publicKey }) => ({
//       type: "Stake",
//       stake: amount,
//       publicKey,
//     }),
//
//     addFullAccessKey: ({ publicKey }) => ({
//       type: "AddKey",
//       publicKey: publicKey,
//       accessKey: { permission: "FullAccess" },
//     }),
//
//     addLimitedAccessKey: ({
//       publicKey,
//       allowance,
//       accountId,
//       methodNames,
//     }) => ({
//       type: "AddKey",
//       publicKey: publicKey,
//       accessKey: {
//         permission: "FunctionCall",
//         allowance,
//         receiverId: accountId,
//         methodNames,
//       },
//     }),
//
//     deleteKey: ({ publicKey }) => ({
//       type: "DeleteKey",
//       publicKey,
//     }),
//
//     deleteAccount: ({ beneficiaryId }) => ({
//       type: "DeleteAccount",
//       beneficiaryId,
//     }),
//
//     createAccount: () => ({
//       type: "CreateAccount",
//     }),
//
//     deployContract: ({ codeBase64 }) => ({
//       type: "DeployContract",
//       codeBase64,
//     }),
//   },
//
//   utils: {
//     toBase64,
//     fromBase64,
//     toBase58,
//     fromBase58,
//   },
// };
//
// // _adapter.handleWalletRedirect();
//
// // Handle wallet redirect if applicable
// // TODO: Implement actual wallet integration
// try {
//   const url = new URL(window.location.href);
//   const accountId = url.searchParams.get("account_id");
//   const publicKey = url.searchParams.get("public_key");
//   const errorCode = url.searchParams.get("errorCode");
//   const errorMessage = url.searchParams.get("errorMessage");
//   const transactionHashes = url.searchParams.get("transactionHashes");
//   const txIds = url.searchParams.get("txIds");
//
//   if (errorCode || errorMessage) {
//     console.warn(new Error(`Wallet error: ${errorCode} ${errorMessage}`));
//   }
//
//   if (accountId && publicKey) {
//     if (publicKey === _state.publicKey) {
//       updateState({
//         accountId,
//       });
//     } else {
//       console.error(
//         new Error("Public key mismatch from wallet redirect"),
//         publicKey,
//         _state.publicKey,
//       );
//     }
//   }
//
//   if (transactionHashes || txIds) {
//     const txHashes = transactionHashes ? transactionHashes.split(",") : [];
//     const txIdsArray = txIds ? txIds.split(",") : [];
//     if (txIdsArray.length > txHashes.length) {
//       txIdsArray.forEach((txId, i) => {
//         updateTxHistory({
//           txId,
//           status: "RejectedByUser",
//           finalState: true,
//         });
//       });
//     } else if (txIdsArray.length === txHashes.length) {
//       txIdsArray.forEach((txId, i) => {
//         updateTxHistory({
//           txId,
//           status: "PendingGotTxHash",
//           txHash: txHashes[i],
//           finalState: false,
//         });
//         afterTxSent(txId);
//       });
//     } else {
//       console.error(
//         new Error("Transaction hash mismatch from wallet redirect"),
//         txIdsArray,
//         txHashes,
//       );
//     }
//   }
//
//   // Remove wallet parameters from the URL
//   url.searchParams.delete("account_id");
//   url.searchParams.delete("public_key");
//   url.searchParams.delete("errorCode");
//   url.searchParams.delete("errorMessage");
//   url.searchParams.delete("all_keys");
//   url.searchParams.delete("transactionHashes");
//   url.searchParams.delete("txIds");
//   window.history.replaceState({}, "", url.toString());
// } catch (e) {
//   console.error("Error handling wallet redirect:", e);
// }
//
// export { api, convertUnit };
