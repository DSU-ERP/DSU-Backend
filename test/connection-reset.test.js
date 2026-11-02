import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { withActor } from "../src/integrations/supabase/db.js";
import { workerTransaction } from "../src/modules/intelligence/sync.js";

// A checked-out pg client whose connection is reset mid-transaction, the way
// Supabase or the network can drop it (read ECONNRESET). pg-pool removes its
// own error listener while a client is checked out, so without one of ours the
// 'error' event is unhandled and Node stops the whole server.
function resettingPool() {
  const client = new EventEmitter();
  const reset = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
  let dead = false;
  client.released = [];
  client.query = async (sql) => {
    if (dead) throw Object.assign(new Error("Client has encountered a connection error and is not queryable"), { code: "CONNECTION_ERROR" });
    if (/^SELECT 'boom'/.test(sql)) {
      dead = true;
      // pg emits 'error' on the client and fails the in-flight query.
      client.emit("error", reset);
      throw reset;
    }
    return { rows: [] };
  };
  client.release = (error) => client.released.push(error ?? null);
  return { pool: { connect: async () => client }, client, reset };
}

for (const [name, run] of [
  ["withActor", (pool, fn) => withActor(pool, "00000000-0000-4000-8000-000000000001", fn)],
  ["workerTransaction", (pool, fn) => workerTransaction(pool, fn)],
]) {
  test(`${name}: a connection reset fails only that transaction and discards the connection`, async () => {
    const { pool, client, reset } = resettingPool();
    await assert.rejects(run(pool, (c) => c.query("SELECT 'boom'")), (error) => error === reset, "the original error, not the rollback failure");
    assert.equal(client.listenerCount("error"), 0, "our listener is removed after release");
    assert.equal(client.released.length, 1);
    assert.equal(client.released[0], reset, "the broken connection is released with its error so the pool discards it");
  });

  test(`${name}: a healthy transaction releases the connection for reuse`, async () => {
    const { pool, client } = resettingPool();
    await run(pool, (c) => c.query("SELECT 1"));
    assert.deepEqual(client.released, [null]);
    assert.equal(client.listenerCount("error"), 0);
  });
}
