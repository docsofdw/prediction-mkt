import { ClaimInput, TriageReport, SourceCredibility } from "./types";
import { ClaimParser } from "./services/claim-parser";
import { BTCMapper } from "./services/btc-mapper";
import { GeneralValidator } from "./services/general-validator";
import { CorrelationAnalyzer } from "./services/correlation-analyzer";
import { TriageReporter } from "./services/triage-reporter";
import { AuditLogger, TelegramAllowlist } from "./services/security";
import { log } from "../shared/utils/logger";
import * as fs from "fs";

const CREDIBILITY_PATH = "backtests/source-credibility.json";

export class ClaimValidator {
  private parser: ClaimParser;
  private btcMapper: BTCMapper;
  private generalValidator: GeneralValidator;
  private correlationAnalyzer: CorrelationAnalyzer;
  private triageReporter: TriageReporter;
  private auditLogger: AuditLogger;
  private basePath: string;

  constructor(anthropicApiKey: string, basePath: string = process.cwd()) {
    this.basePath = basePath;
    this.parser = new ClaimParser(anthropicApiKey, basePath);
    this.btcMapper = new BTCMapper();
    this.generalValidator = new GeneralValidator();
    this.correlationAnalyzer = new CorrelationAnalyzer(basePath);
    this.triageReporter = new TriageReporter();
    this.auditLogger = new AuditLogger(basePath);
  }

  /**
   * Validate a claim end-to-end
   */
  async validate(input: ClaimInput): Promise<TriageReport> {
    log.info(`[ClaimValidator] Processing claim from: ${input.sourceId ?? input.source.slice(0, 50)}`);

    // Step 1: Parse the claim
    log.info(`[ClaimValidator] Parsing claim...`);
    const claim = await this.parser.parse(input);
    log.info(`[ClaimValidator] Parsed: ${claim.marketType} / ${claim.strategyType} (confidence: ${claim.parseConfidence})`);

    // Check for security blocks
    if (claim.securityFlags.some(f => f.severity === "high")) {
      log.warn(`[ClaimValidator] Security block triggered`);
      const report = this.triageReporter.generate({ claim });
      this.auditLogger.logValidationComplete(claim.id, report.verdict, input.sourceId);
      return report;
    }

    // Step 2: Route based on market type
    let btcMapping;
    let generalValidation;
    let correlation;

    if (claim.marketType === "btc" || claim.marketType === "crypto") {
      // BTC path
      log.info(`[ClaimValidator] Running BTC mapping...`);
      btcMapping = await this.btcMapper.map(claim);

      if (!btcMapping.mapsToExisting) {
        // Also run general validation for non-mapping BTC claims
        log.info(`[ClaimValidator] Running general validation (BTC claim didn't map)...`);
        generalValidation = await this.generalValidator.validate(claim);
      }
    } else {
      // General path
      log.info(`[ClaimValidator] Running general validation...`);
      generalValidation = await this.generalValidator.validate(claim);
    }

    // Step 3: Correlation analysis if we have returns
    const backtestReturns = btcMapping?.backtestResult
      ? [] // Would extract from full backtest result
      : [];

    if (backtestReturns.length >= 10) {
      log.info(`[ClaimValidator] Running correlation analysis...`);
      correlation = this.correlationAnalyzer.analyze(backtestReturns);
    }

    // Step 4: Generate triage report
    log.info(`[ClaimValidator] Generating triage report...`);
    const report = this.triageReporter.generate({
      claim,
      btcMapping,
      generalValidation,
      correlation,
    });

    // Step 5: Update source credibility
    if (input.sourceId) {
      this.updateCredibility(input.sourceId, report);
    }

    // Log completion
    this.auditLogger.logValidationComplete(claim.id, report.verdict, input.sourceId);

    log.info(`[ClaimValidator] Done. Verdict: ${report.verdict}`);
    return report;
  }

  /**
   * Update credibility tracking for a source
   */
  private updateCredibility(sourceId: string, report: TriageReport): void {
    const credibility = this.loadCredibility();

    const existing = credibility.find(c => c.sourceId === sourceId);
    if (existing) {
      existing.totalClaims += 1;
      existing.averageLegitimacyScore =
        (existing.averageLegitimacyScore * (existing.totalClaims - 1) + report.scores.legitimacy) /
        existing.totalClaims;
      existing.lastClaimAt = new Date();
      existing.credibilityScore = this.computeCredibilityScore(existing);
    } else {
      credibility.push({
        sourceId,
        totalClaims: 1,
        verifiedEdges: 0,
        falseEdges: 0,
        averageLegitimacyScore: report.scores.legitimacy,
        lastClaimAt: new Date(),
        credibilityScore: report.scores.legitimacy / 10,
      });
    }

    this.saveCredibility(credibility);
  }

  private computeCredibilityScore(cred: SourceCredibility): number {
    const verifiedRatio = cred.totalClaims > 0
      ? cred.verifiedEdges / cred.totalClaims
      : 0;
    const legitScore = cred.averageLegitimacyScore / 10;

    // Weighted combination
    return Math.round((verifiedRatio * 0.6 + legitScore * 0.4) * 100) / 100;
  }

  private loadCredibility(): SourceCredibility[] {
    try {
      const fullPath = `${this.basePath}/${CREDIBILITY_PATH}`;
      if (fs.existsSync(fullPath)) {
        const data = JSON.parse(fs.readFileSync(fullPath, "utf-8"));
        // Convert date strings back to Date objects
        return data.map((c: SourceCredibility & { lastClaimAt: string }) => ({
          ...c,
          lastClaimAt: new Date(c.lastClaimAt),
        }));
      }
    } catch {
      // Ignore
    }
    return [];
  }

  private saveCredibility(credibility: SourceCredibility[]): void {
    const fullPath = `${this.basePath}/${CREDIBILITY_PATH}`;
    fs.writeFileSync(fullPath, JSON.stringify(credibility, null, 2));
  }

  /**
   * Get credibility for a source
   */
  getSourceCredibility(sourceId: string): SourceCredibility | null {
    const all = this.loadCredibility();
    return all.find(c => c.sourceId === sourceId) ?? null;
  }

  /**
   * Get all source credibilities
   */
  getAllCredibilities(): SourceCredibility[] {
    return this.loadCredibility();
  }

  /**
   * Mark a previous claim as verified/false
   */
  markClaimOutcome(sourceId: string, verified: boolean): void {
    const credibility = this.loadCredibility();
    const existing = credibility.find(c => c.sourceId === sourceId);

    if (existing) {
      if (verified) {
        existing.verifiedEdges += 1;
      } else {
        existing.falseEdges += 1;
      }
      existing.credibilityScore = this.computeCredibilityScore(existing);
      this.saveCredibility(credibility);
    }
  }
}

// Export all types and services
export * from "./types";
export { ClaimParser } from "./services/claim-parser";
export { BTCMapper } from "./services/btc-mapper";
export { GeneralValidator } from "./services/general-validator";
export { CorrelationAnalyzer } from "./services/correlation-analyzer";
export { TriageReporter } from "./services/triage-reporter";
export { SecurityScanner, AuditLogger, TelegramAllowlist } from "./services/security";
