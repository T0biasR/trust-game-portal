import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtime = path.join(root, "functions", "runtime");
await rm(runtime, { recursive: true, force: true });
await mkdir(runtime, { recursive: true });
await cp(path.join(root, "server-dist"), path.join(runtime, "server-dist"), { recursive: true });
console.log("Packaged trusted API runtime for Firebase Functions.");
