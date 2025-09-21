import express from "express";
import cors from "cors";
import { sseHandler } from "./lib/sse.js";
import tradingRoutes from "./routes/trading.js";
import tokenRoutes from "./routes/tokens.js";
import leaderboardRoutes from "./routes/leaderboard.js";
import uploadRoutes from "./routes/uploads.js";
import commentsRouter from "./routes/comments.js";
import miscRoutes from "./routes/misc.js";
import migrationRoutes from "./routes/migration.js";
import miscRouter from "./routes/misc.js";
import { tryInitializeCurveConfig } from "./instructions/initCurve.js";
import { autoScanAndMigrateAll } from "./instructions/migrate.js";
import { resyncAllMints } from "./lib/chain.js";
import { refreshSolUsd } from "./lib/quotes.js";

const app = express();
app.use(cors());
app.use(express.json());

// SSE stream
app.get("/stream/holdings", sseHandler);

// REST routes
app.use(tradingRoutes);
app.use(tokenRoutes);
app.use(leaderboardRoutes);
app.use(commentsRouter);
app.use(uploadRoutes);
app.use(miscRoutes);
app.use(migrationRoutes);
app.use(miscRouter);

const PORT = process.env.PORT || 4000;
app.listen(PORT, async () => {
  console.log(`Server running at http://localhost:${PORT}`);
  tryInitializeCurveConfig();

  // periodic on-chain resync (10s)
  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try { 
      await resyncAllMints(); 
      await autoScanAndMigrateAll();
      await refreshSolUsd();
    }
    catch (e) { console.error("Periodic resync failed:", e); }
    finally { running = false; }
  }, 10_000);
});
