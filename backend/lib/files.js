// lib/files.js
import pool from "../lib/db.js";
import "dotenv/config";
import { broadcastBucketRolled, broadcastCandleFinalized } from "./sse.js";

export async function applyOptimisticLedgerDelta({ mint, type, tokenAmountBase, solLamports, wallet }) {
  if (!mint || !type || typeof tokenAmountBase !== "number" || typeof solLamports !== "number") {
    throw new Error("Missing mint/type/tokenAmountBase/solLamports");
  }

  const deltaTokens   = BigInt(tokenAmountBase);
  const deltaLamports = Number(solLamports);

  // token deltas (BigInt) — stay in BigInt space!
  const poolDelta   = (type === "buy"  ? -deltaTokens :  deltaTokens);
  const walletDelta = (type === "buy"  ?  deltaTokens : -deltaTokens);
  // reserve delta (Number)
  const reserveDelta = (type === "buy" ?  deltaLamports : -deltaLamports);

  const client = await pool.connect();
  try {
    await client.query("begin");

    // 1) Update reserve SOL (as delta)
    //    Use an UPSERT that adds reserveDelta and clamps at >= 0
    const { rows: msRows } = await client.query(
      `insert into mint_state (mint, reserve_sol_lamports)
         values ($1, $2)
       on conflict (mint) do update
         set reserve_sol_lamports = greatest(0, mint_state.reserve_sol_lamports + EXCLUDED.reserve_sol_lamports)
       returning reserve_sol_lamports`,
      [mint, reserveDelta]
    );
    const reserveSolLamports = Number(msRows[0].reserve_sol_lamports || 0);

    // 2) Update pool BONDING_CURVE balance (as delta of tokens)
    await client.query(
      `insert into holders (mint, owner, amount_base)
         values ($1, 'BONDING_CURVE', $2::numeric)
       on conflict (mint, owner) do update
         set amount_base = greatest(0, holders.amount_base + EXCLUDED.amount_base)`,
      [mint, poolDelta.toString()]
    );

    // Fetch the new pool balance
    const { rows: poolRows } = await client.query(
      `select amount_base::text as amount_base
         from holders
        where mint = $1 and owner = 'BONDING_CURVE'`,
      [mint]
    );
    const poolBase = poolRows[0]?.amount_base ?? "0";

    // 3) Update the trading wallet’s token balance (if provided)
    let walletBase = null;
    if (wallet && wallet.trim()) {
      await client.query(
        `insert into holders (mint, owner, amount_base)
           values ($1, $2, $3::numeric)
         on conflict (mint, owner) do update
           set amount_base = greatest(0, holders.amount_base + EXCLUDED.amount_base)`,
        [mint, wallet.trim(), walletDelta.toString()]
      );
      const { rows: wRows } = await client.query(
        `select amount_base::text as amount_base
           from holders
          where mint = $1 and owner = $2`,
        [mint, wallet.trim()]
      );
      walletBase = wRows[0]?.amount_base ?? null;
    }

    await client.query("commit");
    return { reserveSolLamports, poolBase, walletBase };
  } catch (e) {
    try { await client.query("rollback"); } catch {}
    throw e;
  } finally {
    client.release();
  }
}


/* ------------ TOKENS ------------ */

export async function loadTokens() {
  const { rows } = await pool.query(
  `select id, mint, pool, pool_token_account as "poolTokenAccount",
          name, symbol, metadata_uri as "metadataUri", tx,
          creator, trip_name as "tripName", trip_code as "tripCode",
          decimals, created_at as "createdAt",
          raydium_pool as "raydiumPool",
          raydium_base_vault as "raydiumBaseVault",
          raydium_vault_owner as "raydiumVaultOwner",
          curve_address as "curveAddress"
  from tokens
  order by created_at asc`
  );
  return rows.map(r => ({ ...r, createdAt: new Date(r.createdAt).toISOString() }));
}

export async function createToken({
  mint,
  pool: poolAddr,
  poolTokenAccount,
  name,
  symbol,
  metadataUri,
  sig,
  creator,
  tripName,
  tripCode,
  decimals
}) {
  const { rows } = await pool.query(
    `insert into tokens
       (mint, pool, pool_token_account, name, symbol, metadata_uri, tx,
        creator, trip_name, trip_code, decimals)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     on conflict (mint) do nothing
     returning id, created_at`,
    [mint, poolAddr, poolTokenAccount, name, symbol, metadataUri, sig,
     creator, tripName ?? "Anonymous", tripCode ?? null, decimals]
  );
  if (!rows.length) return null;
  return { id: rows[0].id, createdAt: rows[0].created_at };
}

export async function getTokenByMint(mint) {
  const { rows } = await pool.query(
    `select id, mint, pool, pool_token_account as "poolTokenAccount",
              name, symbol, metadata_uri as "metadataUri", tx,
              creator, trip_name as "tripName", trip_code as "tripCode",
              decimals, created_at as "createdAt",
              raydium_pool as "raydiumPool",
              raydium_base_vault as "raydiumBaseVault",
              raydium_vault_owner as "raydiumVaultOwner",
              curve_address as "curveAddress"
      from tokens
      where mint = $1`,
    [mint]
  );
  return rows[0]
    ? { ...rows[0], createdAt: new Date(rows[0].createdAt).toISOString() }
    : null;
}

export async function getTokensByCreator(creator) {
  const { rows } = await pool.query(
    `select id, mint, pool, pool_token_account as "poolTokenAccount",
            name, symbol, metadata_uri as "metadataUri", tx,
            creator, trip_name as "tripName", trip_code as "tripCode",
            decimals, created_at as "createdAt"
       from tokens
      where creator = $1
      order by created_at asc`,
    [creator]
  );
  return rows.map(r => ({ ...r, createdAt: new Date(r.createdAt).toISOString() }));
}

/* ------------ HOLDINGS / STATE ------------ */

export async function getReserveSolForMint(mint) {
  const { rows } = await pool.query(
    `select reserve_sol_lamports from mint_state where mint = $1`,
    [mint]
  );
  return rows[0]?.reserve_sol_lamports ?? 0;
}

/**
 * Return a JSON-compatible holdings map like the old file:
 * {
 *   [mint]: {
 *     dev: <creator or null>,
 *     bondingCurve: { reserveSol: number },
 *     holders: { [owner]: baseUnitsString }
 *   }
 * }
 */
export async function loadHoldings() {
  const out = {};

  const { rows: ms } = await pool.query(
    `select mint, reserve_sol_lamports from mint_state`
  );
  for (const r of ms) {
    out[r.mint] = {
      dev: null,
      bondingCurve: { reserveSol: Number(r.reserve_sol_lamports) },
      holders: {},
    };
  }

  const { rows: hs } = await pool.query(
    `select h.mint, h.owner, h.amount_base::text as amount_base, t.creator
       from holders h
       join tokens t on t.mint = h.mint`
  );
  for (const r of hs) {
    out[r.mint] ??= { dev: r.creator ?? null, bondingCurve: { reserveSol: 0 }, holders: {} };
    out[r.mint].dev = r.creator ?? null;
    out[r.mint].holders[r.owner] = r.amount_base;
  }

  return out;
}

/* ------------ COMMENTS ------------ */

/** Load newest-first (like old GET) optionally after a timestamp */
export async function loadCommentsForMint(mint, { afterTs = 0 } = {}) {
  const params = [mint];
  let where = `where mint = $1`;
  if (afterTs) { where += ` and ts > $2`; params.push(afterTs); }

  const { rows } = await pool.query(
    `select id, mint, parent_id as "parentId",
            author, trip, body, ts, no
       from comments
      ${where}
      order by ts desc
      limit 200`,
    params
  );

  // <-- normalize BIGINTs to JS numbers
  return rows.map(r => ({
    ...r,
    ts: Number(r.ts),  // IMPORTANT
    no: Number(r.no),  // keep UI happy when comparing .no
  }));
}

/** Insert a single comment row (with known no). Use inside a tx. */
export async function insertCommentRow(client, row) {
  const { rows } = await client.query(
    `insert into comments (id, mint, parent_id, author, trip, body, ts)
     values ($1,$2,$3,$4,$5,$6,$7)
     returning no`,
    [row.id, row.mint, row.parentId, row.author, row.trip, row.body, row.ts]
  );
  row.no = Number(rows[0].no);  // add the global no to the row object
}


/* ------------ DEV TRADES ------------ */

export async function recordDevTrade({ mint, tsSec, side, sol, wallet, isDev = null }) {
  // derive if caller didn’t pass it
  if (isDev === null) {
    const { rows } = await pool.query(`select creator from tokens where mint=$1`, [mint]);
    const creator = (rows[0]?.creator || "").trim();
    isDev = !!creator && !!wallet && wallet.trim() === creator;
  }
  await pool.query(
    `insert into dev_trades (mint, ts_sec, side, sol, wallet, is_dev)
     values ($1,$2,$3,$4,$5,$6)`,
    [mint, tsSec, side, sol, wallet, isDev]
  );
}

/** Load exact shape the frontend expects for overlays */
export async function loadDevTrades(mint, { sinceTsSec = null } = {}) {
  const params = [mint];
  let where = `where mint = $1`;
  if (sinceTsSec != null) {
    where += ` and ts_sec >= $2`;
    params.push(sinceTsSec);
  }
  const { rows } = await pool.query(
    `select ts_sec as "tsSec", side, sol, wallet, is_dev as "isDev"
       from dev_trades
      ${where}
      order by ts_sec asc`,
    params
  );
  return rows;
}

/* ------------ STATE UPSERT (resync) ------------ */

export async function upsertMintStateAndHolders({
  mint,
  poolPDA,
  poolTokenAccount,
  treasuryPDA,
  reserveSolLamports,
  holders,
}) {
  const client = await pool.connect();
  try {
    await client.query("begin");

    await client.query(
      `insert into mint_state
         (mint, pool_pda, pool_token_account, treasury_pda, reserve_sol_lamports)
       values ($1,$2,$3,$4,$5)
       on conflict (mint) do update
       set pool_pda=excluded.pool_pda,
           pool_token_account=excluded.pool_token_account,
           treasury_pda=excluded.treasury_pda,
           reserve_sol_lamports=excluded.reserve_sol_lamports`,
      [mint, poolPDA, poolTokenAccount, treasuryPDA, reserveSolLamports]
    );

    await client.query(`delete from holders where mint=$1`, [mint]);

    for (const [owner, amount] of Object.entries(holders)) {
      await client.query(
        `insert into holders (mint, owner, amount_base)
         values ($1,$2,$3)`,
        [mint, owner, amount]
      );
    }

    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

const FIFTEEN_MIN = 900;

export async function upsertWorkingCandle(
  mint,
  { tSec, reserveSolLamports, poolBase, cPrice = null }
) {
  const bucket = Math.floor(tSec / FIFTEEN_MIN) * FIFTEEN_MIN;
  const r  = Number(reserveSolLamports);
  const p  = poolBase != null ? String(poolBase) : null;
  const cp = (typeof cPrice === "number" && isFinite(cPrice)) ? Number(cPrice) : null;

  const { rows } = await pool.query(
    `
    INSERT INTO working_candle (
      mint, bucket_start,
      o_reserve_lamports, h_reserve_lamports, l_reserve_lamports, c_reserve_lamports,
      o_pool_base,        h_pool_base,        l_pool_base,        c_pool_base,
      o_price,            h_price,            l_price,            c_price
    )
    VALUES ($1,$2,$3,$3,$3,$3,$4,$4,$4,$4,$5,$5,$5,$5)
    ON CONFLICT (mint) DO UPDATE SET
      -- same-bucket: keep open; update high/low/close
      h_reserve_lamports = CASE
        WHEN working_candle.bucket_start = EXCLUDED.bucket_start
          THEN GREATEST(working_candle.h_reserve_lamports, EXCLUDED.c_reserve_lamports)
        ELSE EXCLUDED.o_reserve_lamports
      END,
      l_reserve_lamports = CASE
        WHEN working_candle.bucket_start = EXCLUDED.bucket_start
          THEN LEAST(working_candle.l_reserve_lamports, EXCLUDED.c_reserve_lamports)
        ELSE EXCLUDED.o_reserve_lamports
      END,
      c_reserve_lamports = EXCLUDED.c_reserve_lamports,

      h_pool_base = CASE
        WHEN working_candle.bucket_start = EXCLUDED.bucket_start
          THEN GREATEST(COALESCE(working_candle.h_pool_base, EXCLUDED.o_pool_base), EXCLUDED.c_pool_base)
        ELSE EXCLUDED.o_pool_base
      END,
      l_pool_base = CASE
        WHEN working_candle.bucket_start = EXCLUDED.bucket_start
          THEN LEAST(COALESCE(working_candle.l_pool_base, EXCLUDED.o_pool_base), EXCLUDED.c_pool_base)
        ELSE EXCLUDED.o_pool_base
      END,
      c_pool_base = EXCLUDED.c_pool_base,

      -- PRICE mirrors the same logic (nullable-safe)
      h_price = CASE
        WHEN working_candle.bucket_start = EXCLUDED.bucket_start
          THEN GREATEST(COALESCE(working_candle.h_price, EXCLUDED.o_price), EXCLUDED.c_price)
        ELSE EXCLUDED.o_price
      END,
      l_price = CASE
        WHEN working_candle.bucket_start = EXCLUDED.bucket_start
          THEN LEAST(COALESCE(working_candle.l_price, EXCLUDED.o_price), EXCLUDED.c_price)
        ELSE EXCLUDED.o_price
      END,
      c_price = EXCLUDED.c_price,

      -- bucket rollover: keep previous opens; move to new bucket
      bucket_start = CASE
        WHEN working_candle.bucket_start = EXCLUDED.bucket_start THEN working_candle.bucket_start
        ELSE EXCLUDED.bucket_start
      END,
      o_reserve_lamports = CASE
        WHEN working_candle.bucket_start = EXCLUDED.bucket_start THEN working_candle.o_reserve_lamports
        ELSE EXCLUDED.o_reserve_lamports
      END,
      o_pool_base = CASE
        WHEN working_candle.bucket_start = EXCLUDED.bucket_start THEN working_candle.o_pool_base
        ELSE EXCLUDED.o_pool_base
      END,
      o_price = CASE
        WHEN working_candle.bucket_start = EXCLUDED.bucket_start THEN working_candle.o_price
        ELSE EXCLUDED.o_price
      END,

      updated_at = now()
    RETURNING
      bucket_start        AS t,
      o_reserve_lamports, h_reserve_lamports, l_reserve_lamports, c_reserve_lamports,
      o_pool_base,        h_pool_base,        l_pool_base,        c_pool_base,
      o_price,            h_price,            l_price,            c_price
    `,
    // IMPORTANT: 5 params for $1..$5
    [mint, bucket, r, p, cp]
  );

  return rows[0] || null;
}

/** finalize the previous working candle if we’ve moved to a new 15m bucket */
export async function finalizeWorkingCandleIfNeeded(mint, nowSec, options = {}) {
  const { rows } = await pool.query(
    `SELECT
       mint,
       bucket_start,
       o_reserve_lamports, h_reserve_lamports, l_reserve_lamports, c_reserve_lamports,
       o_pool_base,        h_pool_base,        l_pool_base,        c_pool_base,
       o_price,            h_price,            l_price,            c_price
     FROM working_candle
     WHERE mint = $1`,
    [mint]
  );
  if (!rows.length) return null;

  const wc = rows[0];
  const currentBucket = Math.floor(nowSec / FIFTEEN_MIN) * FIFTEEN_MIN;

  // nothing to finalize if our working row already belongs to the current bucket
  if (Number(wc.bucket_start) >= currentBucket) return null;

  // Optional: if you ever want to skip "flat" bars unless finalizeFlat=true, you can check here.
  // Currently we always finalize, matching prior behavior.

  // Move finalized row into candles_15m (upsert)
  await pool.query(
    `
    INSERT INTO candles_15m (
      mint, bucket_start,
      o_reserve_lamports, h_reserve_lamports, l_reserve_lamports, c_reserve_lamports,
      o_pool_base,        h_pool_base,        l_pool_base,        c_pool_base,
      o_price,            h_price,            l_price,            c_price
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
    ON CONFLICT (mint, bucket_start) DO UPDATE SET
      o_reserve_lamports = EXCLUDED.o_reserve_lamports,
      h_reserve_lamports = EXCLUDED.h_reserve_lamports,
      l_reserve_lamports = EXCLUDED.l_reserve_lamports,
      c_reserve_lamports = EXCLUDED.c_reserve_lamports,
      o_pool_base = EXCLUDED.o_pool_base,
      h_pool_base = EXCLUDED.h_pool_base,
      l_pool_base = EXCLUDED.l_pool_base,
      c_pool_base = EXCLUDED.c_pool_base,
      o_price = EXCLUDED.o_price,
      h_price = EXCLUDED.h_price,
      l_price = EXCLUDED.l_price,
      c_price = EXCLUDED.c_price
    `,
    [
      wc.mint,
      Number(wc.bucket_start),
      Number(wc.o_reserve_lamports),
      Number(wc.h_reserve_lamports),
      Number(wc.l_reserve_lamports),
      Number(wc.c_reserve_lamports),
      wc.o_pool_base,
      wc.h_pool_base,
      wc.l_pool_base,
      wc.c_pool_base,
      // price fields (may be null if not yet populated)
      (wc.o_price != null ? Number(wc.o_price) : null),
      (wc.h_price != null ? Number(wc.h_price) : null),
      (wc.l_price != null ? Number(wc.l_price) : null),
      (wc.c_price != null ? Number(wc.c_price) : null),
    ]
  );

  // Delete working row
  await pool.query(`DELETE FROM working_candle WHERE mint = $1`, [mint]);

  // Normalize shape for the FE and broadcast
  const finalized = {
    t: Number(wc.bucket_start),
    o_reserve_lamports: Number(wc.o_reserve_lamports),
    h_reserve_lamports: Number(wc.h_reserve_lamports),
    l_reserve_lamports: Number(wc.l_reserve_lamports),
    c_reserve_lamports: Number(wc.c_reserve_lamports),
    o_pool_base: wc.o_pool_base,
    h_pool_base: wc.h_pool_base,
    l_pool_base: wc.l_pool_base,
    c_pool_base: wc.c_pool_base,
    // price O/H/L/C (may be nulls if not tracked yet)
    o_price: (wc.o_price != null ? Number(wc.o_price) : null),
    h_price: (wc.h_price != null ? Number(wc.h_price) : null),
    l_price: (wc.l_price != null ? Number(wc.l_price) : null),
    c_price: (wc.c_price != null ? Number(wc.c_price) : null),
  };

  try {
    // event: candle-finalized
    broadcastCandleFinalized(mint, finalized);

    // event: bucket-roll (prev -> current)
    const cur = Math.floor(nowSec / FIFTEEN_MIN) * FIFTEEN_MIN;
    // ensure this is imported from your SSE module:
    // import { broadcastBucketRolled } from "../lib/sse.js";
    broadcastBucketRolled(mint, { prev: finalized.t, current: cur });
  } catch {
    // swallow SSE errors to keep DB path robust
  }

  return finalized;
}

export async function loadCandles15m(mint, { limit = 5000 } = {}) {
  const { rows } = await pool.query(
    `select bucket_start as t,
            o_reserve_lamports, h_reserve_lamports, l_reserve_lamports, c_reserve_lamports,
            o_pool_base::text as "oPoolBase",
            h_pool_base::text as "hPoolBase",
            l_pool_base::text as "lPoolBase",
            c_pool_base::text as "cPoolBase",
            o_price, h_price, l_price, c_price
       from candles_15m
      where mint=$1
      order by bucket_start asc
      limit $2`,
    [mint, Math.max(1, Math.min(50000, limit))]
  );
  return rows;
}

export async function getWorkingCandle(mint) {
  const { rows } = await pool.query(
    `select bucket_start as t,
            o_reserve_lamports, h_reserve_lamports, l_reserve_lamports, c_reserve_lamports,
            o_pool_base::text as "oPoolBase",
            h_pool_base::text as "hPoolBase",
            l_pool_base::text as "lPoolBase",
            c_pool_base::text as "cPoolBase",
            o_price, h_price, l_price, c_price
       from working_candle
      where mint=$1`,
    [mint]
  );
  return rows[0] || null;
}

// --- Raydium metadata updates on tokens ---
// lib/files.js
export async function updateRaydiumMeta(mint, {
  poolId,
  baseVault = null,
  vaultOwner = null,
} = {}) {
  const sets = [];
  const vals = [mint];
  let i = 2;

  if (poolId != null)     { sets.push(`raydium_pool = $${i++}`);        vals.push(poolId); }
  if (baseVault != null)  { sets.push(`raydium_base_vault = $${i++}`);  vals.push(baseVault); }
  if (vaultOwner != null) { sets.push(`raydium_vault_owner = $${i++}`); vals.push(vaultOwner); }

  if (!sets.length) return;
  await pool.query(`update tokens set ${sets.join(", ")} where mint = $1`, vals);
}

//
// ---------- LEADERBOARD PREFS ----------
//
export async function upsertLeaderboardPref({ mint, owner, opted, displayName, trip }) {
  // displayName already pre-clamped by caller if needed
  await pool.query(
    `insert into leaderboard_prefs (mint, owner, opted, display_name, trip)
     values ($1,$2,$3,$4,$5)
     on conflict (mint, owner) do nothing`,
    [mint, owner, !!opted, displayName ?? null, trip ?? null]
  );
}

export async function getLeaderboardPref({ mint, wallet }) {
  const { rows } = await pool.query(
    `select opted, display_name, trip, locked_at
       from leaderboard_prefs
      where mint=$1 and owner=$2`,
    [mint, wallet]
  );
  const r = rows[0];
  return r
    ? {
        locked: true,
        opted: !!r.opted,
        displayName: r.display_name || "",
        trip: r.trip || "",
        lockedAt: r.locked_at || null,
      }
    : { locked: false, opted: false, displayName: "", trip: "", lockedAt: null };
}

//
// ---------- WALLET LEDGER ----------
//
export async function insertWalletLedger({
  tsSec,
  wallet = "",
  mint,
  side, // 'buy' | 'sell'
  solLamportsSigned, // number (signed)
  tokenBaseSigned,   // number (signed)
  txSig = null,
  source = "internal",
}) {
  await pool.query(
    `insert into wallet_ledger (ts, wallet, mint, side, sol_lamports_signed, token_base_signed, tx_sig, source)
     values (to_timestamp($1), $2, $3, $4, $5, $6, $7, $8)`,
    [tsSec, wallet, mint, side, solLamportsSigned, tokenBaseSigned, txSig, source]
  );
}

export async function getWalletStatsAgg(wallet) {
  // total net lamports
  const { rows: tot } = await pool.query(
    `select coalesce(sum(sol_lamports_signed),0)::bigint as net_lamports
       from wallet_ledger
      where wallet=$1`,
    [wallet]
  );
  const lamports = Number(tot[0]?.net_lamports || 0);

  // bounds
  const { rows: bounds } = await pool.query(
    `select min(ts) as first_ts, max(ts) as last_ts
       from wallet_ledger where wallet=$1`,
    [wallet]
  );

  return {
    lamports,
    firstTs: bounds[0]?.first_ts || null,
    lastTs: bounds[0]?.last_ts || null,
  };
}

export async function getWalletLedgerChrono(wallet) {
  const { rows } = await pool.query(
    `select ts, sol_lamports_signed::bigint as lamports
       from wallet_ledger
      where wallet=$1
      order by ts asc`,
    [wallet]
  );
  // Normalize to { ts: Date, lamports: number }
  return rows.map(r => ({ ts: new Date(r.ts), lamports: Number(r.lamports || 0) }));
}