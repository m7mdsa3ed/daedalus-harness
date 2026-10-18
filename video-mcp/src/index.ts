#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

// stdout is the protocol; anything human goes to stderr.
await createServer().connect(new StdioServerTransport());
