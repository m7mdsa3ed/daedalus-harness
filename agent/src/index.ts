import { Readable, Writable } from "node:stream";
import { ndJsonStream } from "@agentclientprotocol/sdk";
import { buildAgentApp } from "./app.js";
import { readEnv } from "./env.js";

/* stdout belongs to the protocol — everything human goes to stderr, which the
   harness tails and splices into errors. */
console.log = console.error;
console.info = console.error;

const app = buildAgentApp({ env: readEnv() });
const connection = app.connect(
  ndJsonStream(Writable.toWeb(process.stdout) as WritableStream<Uint8Array>, Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>),
);

void connection.closed.then(() => process.exit(0));

process.on("uncaughtException", (err) => {
  process.stderr.write(`uncaught: ${err.stack ?? String(err)}\n`);
  process.exit(1);
});
process.on("unhandledRejection", (err) => {
  process.stderr.write(`unhandled rejection: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
});
