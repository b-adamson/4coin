"use client";

/** Safe JSON.parse that won’t throw */
function _safeJsonParse(maybe) {
  try { return typeof maybe === "string" ? JSON.parse(maybe) : maybe; } catch { return null; }
}

/* =========================
   Program IDs we care about
   ========================= */
const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
// (You can add more: token program, ATAs, etc., if you want program-specific decoding)

/* ==================================
   Custom program error configuration
   ================================== */

let ERROR_CONFIG = {
  // If your program uses Anchor (6000..), leave this 6000; if not, set null.
  anchorOffset: 6000,
  // Optional nudge if your program encodes code = index+1 etc.
  customCodeShift: 0,
};

export function setErrorConfig(cfg) {
  ERROR_CONFIG = { ...ERROR_CONFIG, ...(cfg || {}) };
}

// Default table for your enum. Keys are raw codes 1..N (not 6000+).
let CUSTOM_ERROR_MESSAGES = {
  1: "Duplicate tokens are not allowed",
  2: "Failed to allocate shares",
  3: "Failed to deallocate shares",
  4: "Insufficient shares",
  5: "Insufficient funds to swap",
  6: "Invalid amount to swap",
  7: "Invalid fee",
  8: "Failed to add liquidity",
  9: "Failed to remove liquidity",
  10: "Sold token is not enough to remove pool",
  11: "Not a pool creator",
  12: "Overflow or underflow occurred",
  13: "Token amount is too big to sell",
  14: "SOL is not enough in vault",
  15: "Token is not enough in vault",
  16: "Amount is negative",
  17: "Trading halted: cap reached.",
  18: "Cap not reached.",
  19: "Bad pool phase for this action.",
  20: "Unauthorized.",
  21: "Raydium program not allowlisted.",
};

export function setCustomErrorMessages(map) {
  CUSTOM_ERROR_MESSAGES = { ...CUSTOM_ERROR_MESSAGES, ...(map || {}) };
}

/* ==========================
   Log parsing & decode utils
   ========================== */

/** Return info about the last program failure found in logs */
function parseLogsForProgramFailure(logs = []) {
  // Match lines like:
  // "Program 11111111111111111111111111111111 failed: custom program error: 0x1"
  const re = /Program\s+([A-Za-z0-9]{32,44})\s+failed:\s+custom program error:\s+0x([0-9a-fA-F]+)/;

  for (const line of logs) {
    const m = line && re.exec(line);
    if (m) {
      const code = parseInt(m[2], 16);
      const transferLine = logs.find(l =>
        /Transfer:\s+insufficient lamports/i.test(String(l))
      );
      return { programId: m[1], codeHex: m[2], code, transferLine };
    }
  }

  return null;
}

/** Try to turn a custom code into a readable message using our table + config */
function decodeCustomMessage(code) {
  if (code == null) return null;
  const n = Number(code);
  if (!Number.isFinite(n)) return null;

  const { customCodeShift, anchorOffset } = ERROR_CONFIG;

  // 1) direct match
  if (CUSTOM_ERROR_MESSAGES[n]) return CUSTOM_ERROR_MESSAGES[n];

  // 2) try nudge (off-by-one safety)
  if (customCodeShift) {
    const shifted = n + customCodeShift;
    if (CUSTOM_ERROR_MESSAGES[shifted]) return CUSTOM_ERROR_MESSAGES[shifted];
  }

  // 3) anchor offset (e.g., 6000 + index)
  if (anchorOffset != null) {
    const idx = n - anchorOffset;
    if (CUSTOM_ERROR_MESSAGES[idx]) return CUSTOM_ERROR_MESSAGES[idx];
    if (customCodeShift) {
      const shifted = idx + customCodeShift;
      if (CUSTOM_ERROR_MESSAGES[shifted]) return CUSTOM_ERROR_MESSAGES[shifted];
    }
  }

  return null;
}

/* ==============================
   Error normalization (core API)
   ============================== */

export function normalizeSolanaErr(err, logs) {
  const out = { kind: null, data: null, ix: null, raw: err || null, logs: logs || null };
  if (!err) return out;

  // 1) InstructionError: [index, {...}]  <-- handle first!
  if (err && typeof err === "object" && Array.isArray(err.InstructionError)) {
    const [ix, inner] = err.InstructionError;
    out.kind = "InstructionError";
    out.ix = ix;
    out.data = inner; // inner is often { Custom: <code> } or { ... }
    return out;
  }

  // 2) Direct object like { InsufficientFundsForRent: { account_index: 5 } } OR InstructionError in weird shapes
  if (typeof err === "object" && !Array.isArray(err)) {
    const k = Object.keys(err)[0];
    if (k) {
      if (k === "InstructionError" && Array.isArray(err[k])) {
        const [ix, inner] = err[k];
        out.kind = "InstructionError";
        out.ix = ix;
        out.data = inner;
        return out;
      }
      out.kind = k;
      out.data = err[k];
      return out;
    }
  }

  // 3) Error message with JSON tail (e.g., "Simulation failed: {...}")
  const msg = String(err?.message || err || "");
  const m = msg.match(/\{.*\}$/s);
  if (m) {
    const parsed = _safeJsonParse(m[0]);
    if (parsed) return normalizeSolanaErr(parsed, logs);
  }

  // 4) Fallback: message as kind
  out.kind = String(err?.message || err || "UnknownError");
  return out;
}

/* ===========================
   Friendly message generation
   =========================== */

export function toFriendlyMessage(n) {
  const lower = String(n.kind || "").toLowerCase();
  const details = [];

  if (n.ix != null) details.push(`At instruction #${n.ix}`);

  // 1. Logs-first: if logs tell us which program failed, trust that over n.data
  const failure = parseLogsForProgramFailure(n.logs || []);
  if (failure) {
    if (failure.programId === SYSTEM_PROGRAM_ID) {
      if (failure.transferLine) {
        return {
          short: "Not enough SOL to complete the transfer.",
          tip: "Reduce the amount or add more SOL to your wallet.",
          details: [...details, `System Program error code 0x${failure.codeHex}`],
        };
      }
      return {
        short: "System Program rejected the transfer (insufficient SOL).",
        tip: "Reduce the amount or add more SOL to your wallet.",
        details: [...details, `System Program error code 0x${failure.codeHex}`],
      };
    }

    // If it's your program (non-system), decode via custom table
    const decodedFromLogs = decodeCustomMessage(failure.code);
    if (decodedFromLogs) {
      return {
        short: decodedFromLogs,
        tip: "",
        details: [...details, `Program ${failure.programId} code 0x${failure.codeHex}`],
      };
    }
  }

  // 2. Only if logs didn’t help, try to decode `n.data` (Custom: N)
  if (n.data && typeof n.data === "object") {
    const innerKey = Object.keys(n.data)[0];
    if (innerKey === "custom" || innerKey === "Custom") {
      const code = n.data[innerKey];
      const decoded = decodeCustomMessage(code);
      if (decoded) {
        return {
          short: decoded,
          tip: "",
          details: [...details, `Program error code ${code}`],
        };
      }
      details.push(`Program error code ${code}`);
      return {
        short: "Program error while executing the transaction.",
        tip: "Try a smaller amount or retry. If it persists, check the console logs.",
        details,
      };
    }
  }

  // 3. Common built-ins
  if (lower.includes("insufficientfundsforrent")) {
    return { short: "Not enough SOL to make an account rent-exempt.", tip: "Keep a small SOL buffer (e.g. 0.01–0.05 SOL).", details };
  }
  if (lower.includes("insufficientfundsforfee") || lower.includes("insufficientfundsfortransaction")) {
    return { short: "Not enough SOL to pay network fees.", tip: "Top up ~0.002–0.01 SOL and try again.", details };
  }
  if (lower.includes("accountnotrentexempt")) {
    return { short: "An account is not rent-exempt.", tip: "The transaction needs extra SOL for rent exemption.", details };
  }
  if (lower.includes("blockhashnotfound") || lower.includes("expiredblockhash")) {
    return { short: "The transaction blockhash expired.", tip: "Please try again.", details };
  }
  if (lower.includes("accountinuse")) {
    return { short: "One of the accounts is currently in use (locked).", tip: "Wait a few seconds and retry.", details };
  }
  if (lower.includes("instructionerror")) {
    return { short: "Program error while executing the transaction.", tip: "Try again or check logs.", details };
  }

  // 4. Fallback
  return { short: "Transaction simulation failed.", tip: "Try again with a smaller amount or more SOL.", details };
}

/** Render compact HTML status with <details> for raw/logs */
export function renderFriendlyStatus(prefixEmoji, friendly, rawErr, logs) {
  const parts = [];
  parts.push(`${prefixEmoji} ${friendly.short}`);
  if (friendly.tip) parts.push(`<div style="margin-top:4px;color:#777">${friendly.tip}</div>`);

  const rawPretty = (() => {
    try { return `<pre style="white-space:pre-wrap;margin:0">${JSON.stringify(rawErr, null, 2)}</pre>`; }
    catch { return `<pre style="white-space:pre-wrap;margin:0">${String(rawErr)}</pre>`; }
  })();
  const logsPretty = logs && logs.length
    ? `<pre style="white-space:pre-wrap;margin:6px 0 0 0;max-height:180px;overflow:auto">${logs.join("\n")}</pre>`
    : "";

  parts.push(`<details style="margin-top:6px"><summary>Details</summary>${rawPretty}${logsPretty}</details>`);
  return parts.join("");
}

/** Helper for simulation results. Returns true if handled (failed). */
export function handleSimFailure(sim, setStatus) {
  if (!sim || !sim.value || !sim.value.err) return false;
  const norm = normalizeSolanaErr(sim.value.err, sim.value.logs || []);
  const friendly = toFriendlyMessage({ ...norm, logs: sim.value.logs || [] });
  setStatus(renderFriendlyStatus("❌", friendly, sim.value.err, sim.value.logs || []));
  return true;
}

/** Friendly status from any thrown error (for catch blocks) */
export function statusFromError(err, logs = []) {
  const norm = normalizeSolanaErr(err, logs);
  const friendly = toFriendlyMessage({ ...norm, logs });
  return renderFriendlyStatus("❌", friendly, norm.raw, logs);
}
