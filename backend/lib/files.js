import pool from "../lib/db.js";
import "dotenv/config";

export async function applyOptimisticLedgerDelta({ mint, type, tokenAmountBase, solLamports, wallet }) {
  if (!mint || !type || typeof tokenAmountBase !== "number" || typeof solLamports !== "number") {
    throw new Error("Missing mint/type/tokenAmountBase/solLamports");
  }

  const deltaTokens   = BigInt(tokenAmountBase);
  const deltaLamports = Number(solLamports);

  // token deltas (BigInt)
  const poolDelta   = (type === "buy"  ? -deltaTokens :  deltaTokens);
  const walletDelta = (type === "buy"  ?  deltaTokens : -deltaTokens);
  // reserve delta (Number)
  const reserveDelta = (type === "buy" ?  deltaLamports : -deltaLamports);

  const client = await pool.connect();
  try {
    await client.query("begin");

    // PRE: read current balances (locked)
    const { rows: preMs } = await client.query(
      `select reserve_sol_lamports from mint_state where mint=$1 for update`,
      [mint]
    );
    const preReserve = Number(preMs[0]?.reserve_sol_lamports ?? 0);

    const { rows: prePool } = await client.query(
      `select amount_base::text as amount_base from holders where mint=$1 and owner='BONDING_CURVE' for update`,
      [mint]
    );
    const prePoolBase = prePool[0]?.amount_base ?? "0";

    // 1) reserve SOL (delta upsert)
    const { rows: msRows } = await client.query(
      `insert into mint_state (mint, reserve_sol_lamports)
         values ($1, $2)
       on conflict (mint) do update
         set reserve_sol_lamports = greatest(0, mint_state.reserve_sol_lamports + EXCLUDED.reserve_sol_lamports)
       returning reserve_sol_lamports`,
      [mint, reserveDelta]
    );
    const reserveSolLamports = Number(msRows[0].reserve_sol_lamports || 0);

    // 2) pool BONDING_CURVE balance (delta)
    await client.query(
      `insert into holders (mint, owner, amount_base)
         values ($1, 'BONDING_CURVE', $2::numeric)
       on conflict (mint, owner) do update
         set amount_base = greatest(0, holders.amount_base + EXCLUDED.amount_base)`,
      [mint, poolDelta.toString()]
    );

    // Fetch post pool balance
    const { rows: poolRows } = await client.query(
      `select amount_base::text as amount_base
         from holders
        where mint = $1 and owner = 'BONDING_CURVE'`,
      [mint]
    );
    const poolBase = poolRows[0]?.amount_base ?? "0";

    // 3) trading wallet token balance
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
    return {
      reserveSolLamports,
      poolBase,
      preReserveSolLamports: preReserve,
      prePoolBase,
      walletBase,
    };
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

  return rows.map(r => ({
    ...r,
    ts: Number(r.ts),
    no: Number(r.no),
  }));
}

export async function insertCommentRow(client, row) {
  const { rows } = await client.query(
    `insert into comments (id, mint, parent_id, author, trip, body, ts)
     values ($1,$2,$3,$4,$5,$6,$7)
     returning no`,
    [row.id, row.mint, row.parentId, row.author, row.trip, row.body, row.ts]
  );
  row.no = Number(rows[0].no);
}

/* ------------ DEV TRADES ------------ */
export async function recordDevTrade({ mint, tsSec, side, sol, wallet, isDev = null }) {
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

export async function upsertWorkingCandle(mint, { tSec, reserveSolLamports, poolBase }) {
  const bucket = Math.floor(tSec / 900) * 900;
  const rLamports = Number(reserveSolLamports);
  const pBase = poolBase != null ? String(poolBase) : null;

  const { rows } = await pool.query(
    `
    INSERT INTO working_candle (
      mint, bucket_start,
      o_reserve_lamports, h_reserve_lamports, l_reserve_lamports, c_reserve_lamports,
      o_pool_base,        h_pool_base,        l_pool_base,        c_pool_base
    )
    VALUES ($1,$2,$3,$3,$3,$3,$4,$4,$4,$4)
    ON CONFLICT (mint) DO UPDATE SET
      h_reserve_lamports = CASE
        WHEN working_candle.bucket_start = EXCLUDED.bucket_start
          THEN GREATEST(
                 COALESCE(working_candle.h_reserve_lamports, working_candle.o_reserve_lamports, EXCLUDED.o_reserve_lamports, EXCLUDED.c_reserve_lamports),
                 COALESCE(EXCLUDED.c_reserve_lamports, working_candle.h_reserve_lamports, working_candle.o_reserve_lamports, EXCLUDED.o_reserve_lamports)
               )
        ELSE EXCLUDED.o_reserve_lamports
      END,
      l_reserve_lamports = CASE
        WHEN working_candle.bucket_start = EXCLUDED.bucket_start
          THEN LEAST(
                 COALESCE(working_candle.l_reserve_lamports, working_candle.o_reserve_lamports, EXCLUDED.o_reserve_lamports, EXCLUDED.c_reserve_lamports),
                 COALESCE(EXCLUDED.c_reserve_lamports, working_candle.l_reserve_lamports, working_candle.o_reserve_lamports, EXCLUDED.o_reserve_lamports)
               )
        ELSE EXCLUDED.o_reserve_lamports
      END,
      c_reserve_lamports = COALESCE(EXCLUDED.c_reserve_lamports, working_candle.c_reserve_lamports),
      o_reserve_lamports = CASE
        WHEN working_candle.bucket_start = EXCLUDED.bucket_start
          THEN COALESCE(working_candle.o_reserve_lamports, EXCLUDED.o_reserve_lamports, working_candle.c_reserve_lamports)
        ELSE EXCLUDED.o_reserve_lamports
      END,

      h_pool_base = CASE
        WHEN working_candle.bucket_start = EXCLUDED.bucket_start
          THEN GREATEST(
                 COALESCE(working_candle.h_pool_base, working_candle.o_pool_base, EXCLUDED.o_pool_base, EXCLUDED.c_pool_base),
                 COALESCE(EXCLUDED.c_pool_base, working_candle.h_pool_base, working_candle.o_pool_base, EXCLUDED.o_pool_base)
               )
        ELSE EXCLUDED.o_pool_base
      END,
      l_pool_base = CASE
        WHEN working_candle.bucket_start = EXCLUDED.bucket_start
          THEN LEAST(
                 COALESCE(working_candle.l_pool_base, working_candle.o_pool_base, EXCLUDED.o_pool_base, EXCLUDED.c_pool_base),
                 COALESCE(EXCLUDED.c_pool_base, working_candle.l_pool_base, working_candle.o_pool_base, EXCLUDED.o_pool_base)
               )
        ELSE EXCLUDED.o_pool_base
      END,
      c_pool_base = COALESCE(EXCLUDED.c_pool_base, working_candle.c_pool_base),
      o_pool_base = CASE
        WHEN working_candle.bucket_start = EXCLUDED.bucket_start
          THEN COALESCE(working_candle.o_pool_base, EXCLUDED.o_pool_base, working_candle.c_pool_base)
        ELSE EXCLUDED.o_pool_base
      END,

      bucket_start = EXCLUDED.bucket_start,
      updated_at = now()
    RETURNING
      bucket_start AS t,
      o_reserve_lamports, h_reserve_lamports, l_reserve_lamports, c_reserve_lamports,
      o_pool_base,        h_pool_base,        l_pool_base,        c_pool_base
    `,
    [mint, bucket, rLamports, pBase]
  );

  return rows[0] || null;
}


export async function finalizeWorkingCandleIfNeeded(mint, nowSec) {
  const { rows } = await pool.query(`SELECT * FROM working_candle WHERE mint=$1`, [mint]);
  if (!rows.length) return null;

  const wc = rows[0];
  const currentBucket = Math.floor(nowSec / 900) * 900;
  if (Number(wc.bucket_start) >= currentBucket) return null;

  await pool.query(
    `
    INSERT INTO candles_15m (
      mint, bucket_start,
      o_reserve_lamports, h_reserve_lamports, l_reserve_lamports, c_reserve_lamports,
      o_pool_base,        h_pool_base,        l_pool_base,        c_pool_base
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT (mint, bucket_start) DO UPDATE SET
      o_reserve_lamports = EXCLUDED.o_reserve_lamports,
      h_reserve_lamports = EXCLUDED.h_reserve_lamports,
      l_reserve_lamports = EXCLUDED.l_reserve_lamports,
      c_reserve_lamports = EXCLUDED.c_reserve_lamports,
      o_pool_base = EXCLUDED.o_pool_base,
      h_pool_base = EXCLUDED.h_pool_base,
      l_pool_base = EXCLUDED.l_pool_base,
      c_pool_base = EXCLUDED.c_pool_base
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
    ]
  );

  await pool.query(`DELETE FROM working_candle WHERE mint=$1`, [mint]);

  return {
    t: Number(wc.bucket_start),
    o_reserve_lamports: Number(wc.o_reserve_lamports),
    h_reserve_lamports: Number(wc.h_reserve_lamports),
    l_reserve_lamports: Number(wc.l_reserve_lamports),
    c_reserve_lamports: Number(wc.c_reserve_lamports),
    o_pool_base: wc.o_pool_base,
    h_pool_base: wc.h_pool_base,
    l_pool_base: wc.l_pool_base,
    c_pool_base: wc.c_pool_base,
  };
}


export async function loadCandles15m(mint, { limit = 5000, order = "asc" } = {}) {
  const dir = String(order).toLowerCase() === "desc" ? "desc" : "asc";
  const { rows } = await pool.query(
    `select bucket_start as t,
            o_reserve_lamports, h_reserve_lamports, l_reserve_lamports, c_reserve_lamports,
            o_pool_base::text as "oPoolBase",
            h_pool_base::text as "hPoolBase",
            l_pool_base::text as "lPoolBase",
            c_pool_base::text as "cPoolBase"
       from candles_15m
      where mint=$1
      order by bucket_start ${dir}
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
            c_pool_base::text as "cPoolBase"
       from working_candle
      where mint=$1`,
    [mint]
  );
  return rows[0] || null;
}

/* ------------ Raydium metadata ------------ */
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

/* ------------ Leaderboard prefs ------------ */
export async function upsertLeaderboardPref({ mint, owner, opted, displayName, trip }) {
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

/* ------------ Wallet ledger ------------ */
export async function insertWalletLedger({
  tsSec,
  wallet = "",
  mint,
  side,
  solLamportsSigned,
  tokenBaseSigned,
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
  const { rows: tot } = await pool.query(
    `select coalesce(sum(sol_lamports_signed),0)::bigint as net_lamports
       from wallet_ledger
      where wallet=$1`,
    [wallet]
  );
  const lamports = Number(tot[0]?.net_lamports || 0);

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
  return rows.map(r => ({ ts: new Date(r.ts), lamports: Number(r.lamports || 0) }));
}

export async function loadTradesForMint(mint) {
  if (!mint || typeof mint !== "string") throw new Error("mint required");

  const { rows } = await pool.query(
    `
    SELECT
      EXTRACT(EPOCH FROM wl.ts) * 1000 AS ts_ms,
      wl.side,
      ABS(wl.sol_lamports_signed)::bigint AS lamports,
      COALESCE(lp.opted, false) AS opted,
      CASE WHEN COALESCE(lp.opted, false) THEN wl.wallet ELSE NULL END AS wallet,
      COALESCE(lp.trip, '') AS trip,
      COALESCE(NULLIF(lp.display_name, ''), 'Anonymous') AS display_name,
      (wl.wallet = t.creator) AS is_dev
    FROM wallet_ledger wl
    LEFT JOIN leaderboard_prefs lp
      ON lp.mint = wl.mint AND lp.owner = wl.wallet
    JOIN tokens t
      ON t.mint = wl.mint
    WHERE wl.mint = $1
    ORDER BY wl.ts DESC
    `,
    [mint]
  );

  const LAMPORTS_PER_SOL = 1_000_000_000;
  return rows.map(r => ({
    ts: Number(r.ts_ms),
    side: r.side,
    sol: Number(r.lamports) / LAMPORTS_PER_SOL,
    wallet: r.wallet || undefined,
    isDev: !!r.is_dev,
    trip: r.trip || null,
    displayName: r.display_name || "Anonymous",
    opted: !!r.opted,
  }));
}
