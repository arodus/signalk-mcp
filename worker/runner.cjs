#!/usr/local/bin/node
"use strict";
const { Buffer } = require("node:buffer");
// This file runs ONLY inside the reviewed container image, never in Signal K.
const chunks = [];
let bytes = 0;
process.stdin.on("data", (chunk) => {
  bytes += chunk.length;
  if (bytes > 1024 * 1024) process.exit(2);
  chunks.push(chunk);
});
process.stdin.on("end", async () => {
  try {
    const envelope = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (envelope.version !== 1 || typeof envelope.code !== "string")
      process.exit(2);
    const AsyncFunction = Object.getPrototypeOf(
      async function () {},
    ).constructor;
    const value = await new AsyncFunction("data", envelope.code)(envelope.data);
    process.stdout.write(
      JSON.stringify({ version: 1, value: value ?? null }) + "\n",
    );
  } catch {
    process.stderr.write("WORKER_FAILED\n");
    process.exitCode = 1;
  }
});
