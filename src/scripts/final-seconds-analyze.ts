/**
 * Final Seconds Analysis
 *
 * Analyzes recorded order book data to answer:
 *   1. How often is there liquidity at 98c+ in the final 15 seconds?
 *   2. What's the win rate when buying at 98c+ with <15s remaining?
 *   3. What's the relationship between BTC distance and price levels?
 *
 * Usage:
 *   npx ts-node src/scripts/final-seconds-analyze.ts [--report]
 */

import "dotenv/config";
import { validationConfig } from "../markets/btc/validation/config";
import { openValidationDb, migrateValidationDb, SqliteDatabase } from "../shared/validation/sqlite";
import { log } from "../shared/utils/logger";

interface SnapshotStats {
  secondsRemaining: number;
  count: number;
  avgHighPrice: number | null;
  at95cPlus: number;
  at98cPlus: number;
  avgSpread: number | null;
  avgBidDepth: number | null;
}

interface OutcomeStats {
  total: number;
  highSideWins: number;
  winRate: number;
  at98c: {
    count: number;
    wins: number;
    winRate: number;
  };
  byDistance: Array<{
    range: string;
    count: number;
    highSideWinRate: number;
    avgHighPrice: number | null;
  }>;
}

function getSnapshotStats(db: SqliteDatabase): SnapshotStats[] {
  const rows = db.prepare(`
    SELECT
      seconds_remaining,
      COUNT(*) as count,
      AVG(high_confidence_price) as avg_high_price,
      SUM(CASE WHEN high_confidence_price >= 0.95 THEN 1 ELSE 0 END) as at_95c_plus,
      SUM(CASE WHEN high_confidence_price >= 0.98 THEN 1 ELSE 0 END) as at_98c_plus,
      AVG(spread_cents) as avg_spread,
      AVG(up_bid_depth + down_bid_depth) as avg_bid_depth
    FROM final_seconds_snapshots
    WHERE high_confidence_side IS NOT NULL
    GROUP BY seconds_remaining
    ORDER BY seconds_remaining DESC
  `).all() as Array<{
    seconds_remaining: number;
    count: number;
    avg_high_price: number | null;
    at_95c_plus: number;
    at_98c_plus: number;
    avg_spread: number | null;
    avg_bid_depth: number | null;
  }>;

  return rows.map(r => ({
    secondsRemaining: r.seconds_remaining,
    count: r.count,
    avgHighPrice: r.avg_high_price,
    at95cPlus: r.at_95c_plus,
    at98cPlus: r.at_98c_plus,
    avgSpread: r.avg_spread,
    avgBidDepth: r.avg_bid_depth,
  }));
}

function getOutcomeStats(db: SqliteDatabase): OutcomeStats {
  const totals = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(high_side_won) as wins
    FROM final_seconds_outcomes
  `).get() as { total: number; wins: number | null };

  const at98c = db.prepare(`
    SELECT
      COUNT(*) as count,
      SUM(high_side_won) as wins
    FROM final_seconds_outcomes
    WHERE was_98c_plus = 1
  `).get() as { count: number; wins: number | null };

  const byDistance = db.prepare(`
    SELECT
      CASE
        WHEN ABS(btc_distance_at_final) >= 0.5 THEN '>= 0.50%'
        WHEN ABS(btc_distance_at_final) >= 0.25 THEN '0.25-0.50%'
        WHEN ABS(btc_distance_at_final) >= 0.10 THEN '0.10-0.25%'
        ELSE '< 0.10%'
      END as distance_range,
      COUNT(*) as count,
      AVG(high_side_won) as win_rate,
      AVG(final_high_price) as avg_price
    FROM final_seconds_outcomes
    GROUP BY distance_range
    ORDER BY MIN(ABS(btc_distance_at_final)) DESC
  `).all() as Array<{
    distance_range: string;
    count: number;
    win_rate: number | null;
    avg_price: number | null;
  }>;

  return {
    total: totals.total,
    highSideWins: totals.wins || 0,
    winRate: totals.total > 0 ? ((totals.wins || 0) / totals.total) * 100 : 0,
    at98c: {
      count: at98c.count,
      wins: at98c.wins || 0,
      winRate: at98c.count > 0 ? ((at98c.wins || 0) / at98c.count) * 100 : 0,
    },
    byDistance: byDistance.map(d => ({
      range: d.distance_range,
      count: d.count,
      highSideWinRate: (d.win_rate || 0) * 100,
      avgHighPrice: d.avg_price,
    })),
  };
}

function getRecentOutcomes(db: SqliteDatabase, limit = 20): Array<{
  slug: string;
  outcome: string;
  highSide: string | null;
  highPrice: number | null;
  won: boolean;
  distance: number | null;
}> {
  const rows = db.prepare(`
    SELECT
      slug,
      outcome,
      final_high_side,
      final_high_price,
      high_side_won,
      btc_distance_at_final
    FROM final_seconds_outcomes
    ORDER BY resolved_at DESC
    LIMIT ?
  `).all(limit) as Array<{
    slug: string;
    outcome: string;
    final_high_side: string | null;
    final_high_price: number | null;
    high_side_won: number;
    btc_distance_at_final: number | null;
  }>;

  return rows.map(r => ({
    slug: r.slug,
    outcome: r.outcome,
    highSide: r.final_high_side,
    highPrice: r.final_high_price,
    won: r.high_side_won === 1,
    distance: r.btc_distance_at_final,
  }));
}

function getLiquidityAnalysis(db: SqliteDatabase): {
  has98cLiquidity: number;
  has95cLiquidity: number;
  totalSub15s: number;
} {
  const row = db.prepare(`
    SELECT
      SUM(CASE WHEN high_confidence_price >= 0.98 THEN 1 ELSE 0 END) as has_98c,
      SUM(CASE WHEN high_confidence_price >= 0.95 THEN 1 ELSE 0 END) as has_95c,
      COUNT(*) as total
    FROM final_seconds_snapshots
    WHERE seconds_remaining <= 15 AND high_confidence_side IS NOT NULL
  `).get() as { has_98c: number | null; has_95c: number | null; total: number };

  return {
    has98cLiquidity: row.has_98c || 0,
    has95cLiquidity: row.has_95c || 0,
    totalSub15s: row.total,
  };
}

function printReport(db: SqliteDatabase): void {
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  FINAL SECONDS ANALYSIS - 5-Minute BTC Markets");
  console.log("═══════════════════════════════════════════════════════════\n");

  // Summary counts
  const counts = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM final_seconds_snapshots) as snapshots,
      (SELECT COUNT(DISTINCT slug) FROM final_seconds_snapshots) as markets,
      (SELECT COUNT(*) FROM final_seconds_outcomes) as outcomes
  `).get() as { snapshots: number; markets: number; outcomes: number };

  console.log("DATA COLLECTION:");
  console.log(`  Total snapshots: ${counts.snapshots}`);
  console.log(`  Unique markets:  ${counts.markets}`);
  console.log(`  Resolved:        ${counts.outcomes}`);
  console.log("");

  // Snapshot stats by time
  const snapStats = getSnapshotStats(db);
  if (snapStats.length > 0) {
    console.log("PRICE BY TIME REMAINING:");
    console.log("┌─────────────┬───────┬───────────┬─────────┬─────────┬─────────┐");
    console.log("│ T-seconds   │ Count │ Avg Price │ >= 95c  │ >= 98c  │ Spread  │");
    console.log("├─────────────┼───────┼───────────┼─────────┼─────────┼─────────┤");
    for (const s of snapStats) {
      const pct95 = s.count > 0 ? ((s.at95cPlus / s.count) * 100).toFixed(0) : "0";
      const pct98 = s.count > 0 ? ((s.at98cPlus / s.count) * 100).toFixed(0) : "0";
      console.log(
        `│ T-${s.secondsRemaining.toString().padStart(2)}s       │ ${s.count.toString().padStart(5)} │ ` +
        `${s.avgHighPrice ? (s.avgHighPrice * 100).toFixed(1) + "c" : "N/A".padStart(4)}     │ ` +
        `${pct95.padStart(5)}%  │ ${pct98.padStart(5)}%  │ ` +
        `${s.avgSpread ? s.avgSpread.toFixed(1) + "c" : "N/A".padStart(4)}    │`
      );
    }
    console.log("└─────────────┴───────┴───────────┴─────────┴─────────┴─────────┘");
    console.log("");
  }

  // Liquidity analysis for sub-15s
  const liquidity = getLiquidityAnalysis(db);
  if (liquidity.totalSub15s > 0) {
    console.log("LIQUIDITY AT 98c+ (sub-15s snapshots):");
    const pct98 = ((liquidity.has98cLiquidity / liquidity.totalSub15s) * 100).toFixed(1);
    const pct95 = ((liquidity.has95cLiquidity / liquidity.totalSub15s) * 100).toFixed(1);
    console.log(`  Has 98c+ liquidity: ${liquidity.has98cLiquidity}/${liquidity.totalSub15s} (${pct98}%)`);
    console.log(`  Has 95c+ liquidity: ${liquidity.has95cLiquidity}/${liquidity.totalSub15s} (${pct95}%)`);
    console.log("");
  }

  // Outcome analysis
  const outcomes = getOutcomeStats(db);
  if (outcomes.total > 0) {
    console.log("OUTCOME ANALYSIS:");
    console.log(`  Total resolved: ${outcomes.total}`);
    console.log(`  High-side wins: ${outcomes.highSideWins} (${outcomes.winRate.toFixed(1)}%)`);
    console.log("");

    if (outcomes.at98c.count > 0) {
      console.log("  WHEN PRICED AT 98c+:");
      console.log(`    Count: ${outcomes.at98c.count}`);
      console.log(`    Win rate: ${outcomes.at98c.winRate.toFixed(1)}%`);
      console.log(`    Expected P&L per $1 bet: ${((outcomes.at98c.winRate / 100) * 0.02 - (1 - outcomes.at98c.winRate / 100) * 0.98).toFixed(4)}`);
      console.log("");
    }

    if (outcomes.byDistance.length > 0) {
      console.log("  BY BTC DISTANCE FROM TARGET:");
      console.log("  ┌──────────────┬───────┬──────────┬───────────┐");
      console.log("  │ Distance     │ Count │ Win Rate │ Avg Price │");
      console.log("  ├──────────────┼───────┼──────────┼───────────┤");
      for (const d of outcomes.byDistance) {
        console.log(
          `  │ ${d.range.padEnd(12)} │ ${d.count.toString().padStart(5)} │ ` +
          `${d.highSideWinRate.toFixed(1).padStart(6)}%  │ ` +
          `${d.avgHighPrice ? (d.avgHighPrice * 100).toFixed(1) + "c" : "N/A".padStart(6)}     │`
        );
      }
      console.log("  └──────────────┴───────┴──────────┴───────────┘");
      console.log("");
    }
  }

  // Recent outcomes
  const recent = getRecentOutcomes(db, 10);
  if (recent.length > 0) {
    console.log("RECENT OUTCOMES:");
    for (const r of recent) {
      const shortSlug = r.slug.slice(-10);
      const status = r.won ? "✓" : "✗";
      const price = r.highPrice ? `${(r.highPrice * 100).toFixed(1)}c` : "N/A";
      const dist = r.distance ? `${r.distance.toFixed(2)}%` : "N/A";
      console.log(`  ${status} ${shortSlug} | ${r.outcome.padEnd(4)} | High: ${r.highSide?.padEnd(4) || "N/A "} @ ${price} | Dist: ${dist}`);
    }
    console.log("");
  }

  // Verdict
  if (outcomes.total >= 10) {
    console.log("═══════════════════════════════════════════════════════════");
    console.log("VERDICT:");

    const liqRate = liquidity.totalSub15s > 0 ? (liquidity.has98cLiquidity / liquidity.totalSub15s) * 100 : 0;

    if (liqRate < 20) {
      console.log("  ❌ LIQUIDITY PROBLEM: Only " + liqRate.toFixed(0) + "% of sub-15s snapshots have 98c+ pricing");
      console.log("     The strategy cannot be executed - there's no one to buy from");
    } else if (outcomes.at98c.count < 10) {
      console.log("  ⏳ NEED MORE DATA: Only " + outcomes.at98c.count + " trades at 98c+");
      console.log("     Collect more samples before drawing conclusions");
    } else {
      const expectedPnl = (outcomes.at98c.winRate / 100) * 0.02 - (1 - outcomes.at98c.winRate / 100) * 0.98;
      if (expectedPnl > 0) {
        console.log(`  ✅ STRATEGY VIABLE: ${outcomes.at98c.winRate.toFixed(1)}% win rate at 98c+`);
        console.log(`     Expected edge: ${(expectedPnl * 100).toFixed(2)}% per trade`);
      } else {
        console.log(`  ❌ NO EDGE: ${outcomes.at98c.winRate.toFixed(1)}% win rate is below breakeven`);
        console.log(`     Need >98% wins to profit at 98c pricing`);
      }
    }
    console.log("═══════════════════════════════════════════════════════════\n");
  } else {
    console.log("  ⏳ Collecting data... Need at least 10 resolved markets for analysis\n");
  }
}

async function main() {
  const db = openValidationDb(validationConfig.dbPath);
  migrateValidationDb(db);

  const isReport = process.argv.includes("--report");

  if (isReport) {
    printReport(db);
  } else {
    // Quick summary
    const counts = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM final_seconds_snapshots) as snapshots,
        (SELECT COUNT(DISTINCT slug) FROM final_seconds_snapshots) as markets,
        (SELECT COUNT(*) FROM final_seconds_outcomes) as outcomes,
        (SELECT SUM(high_side_won) FROM final_seconds_outcomes) as wins
    `).get() as { snapshots: number; markets: number; outcomes: number; wins: number | null };

    log.info("Final Seconds Data Summary:");
    log.info(`  Snapshots: ${counts.snapshots} across ${counts.markets} markets`);
    log.info(`  Outcomes:  ${counts.outcomes} resolved (${counts.wins || 0} high-side wins)`);

    if (counts.outcomes > 0) {
      const winRate = ((counts.wins || 0) / counts.outcomes * 100).toFixed(1);
      log.info(`  Win Rate:  ${winRate}%`);
    }

    log.info("\nRun with --report for full analysis");
  }

  db.close();
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  log.error(`Analysis failed: ${message}`);
  process.exit(1);
});
