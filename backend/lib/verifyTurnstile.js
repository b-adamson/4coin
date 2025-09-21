import fetch from "node-fetch";
const TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY;

export async function verifyTurnstile(req, res, next) {
  const token = req.body?.cfToken || req.body?.token || req.query?.cfToken;

  if (!token) return res.status(400).json({ error: "Missing captcha" });

  try {
    const params = new URLSearchParams({
      secret: TURNSTILE_SECRET_KEY || "",
      response: token,
      // remoteip: req.ip, // optional
    });

    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params
    });

    const data = await r.json();

    if (!data?.success) {
      return res.status(400).json({ error: "Captcha failed" });
    }
    next();
  } catch (e) {
    console.error("Turnstile verify error:", e);
    res.status(500).json({ error: "Captcha verify error" });
  }
}
