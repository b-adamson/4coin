// utils.js (ESM)
import crypto from "crypto";

const TRIPCODE_SALT = process.env.TRIPCODE_SALT || "fallbackSalt";

function hashToTrip(wallet) {
  return crypto
    .createHash("sha256")
    .update(String(wallet || "") + TRIPCODE_SALT)
    .digest("base64")
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, 6);
}

// Raw 6-char trip (no prefix) — good for storage
export function generateTripcodeRaw(wallet) {
  return hashToTrip(wallet);
}

// Display trip with "!!" prefix — good for API/UI
export function generateTripcode(wallet) {
  return "!!" + hashToTrip(wallet);
}
