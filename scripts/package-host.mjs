import fs from "node:fs/promises";
import path from "node:path";

const host = process.argv[2];
if (host !== "jatos" && host !== "pavlovia") {
  throw new Error("Usage: node scripts/package-host.mjs jatos|pavlovia");
}

const outDir = path.resolve(`dist-${host}`);
const nested = path.join(outDir, "platforms", host, "index.html");
const target = path.join(outDir, "index.html");
const html = await fs.readFile(nested, "utf8");
await fs.writeFile(target, html.replaceAll("../../assets/", "./assets/"));
await fs.rm(path.join(outDir, "platforms"), { recursive: true, force: true });
console.log(`Packaged ${host} study in ${outDir}`);
