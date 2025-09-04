import fs from "fs";
import { tokensFile, holdingsFile } from "../config/index.js";

export function loadTokens() {
  if (!fs.existsSync(tokensFile)) return [];
  try { return JSON.parse(fs.readFileSync(tokensFile, "utf8")); }
  catch { return []; }
}

export function loadHoldings() {
  if (!fs.existsSync(holdingsFile)) return {};
  try {
    const data = JSON.parse(fs.readFileSync(holdingsFile, "utf8"));
    return typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch { return {}; }
}

export function atomicWriteJSON(file, dataObj) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(dataObj, null, 2));
  fs.renameSync(tmp, file);
}
