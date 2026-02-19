import { SecurityFlag, AuditLogEntry } from "../types";
import * as fs from "fs";
import * as path from "path";

// ─── Prompt Injection Detection Patterns ─────────────────

const INJECTION_PATTERNS: Array<{ pattern: RegExp; severity: SecurityFlag["severity"]; description: string }> = [
  // Direct instruction overrides
  {
    pattern: /ignore\s+(previous|all|your)\s+(instructions?|rules?|guidelines?)/i,
    severity: "high",
    description: "Attempt to override instructions",
  },
  {
    pattern: /disregard\s+(previous|all|your)\s+(instructions?|programming|rules?)/i,
    severity: "high",
    description: "Attempt to disregard programming",
  },
  {
    pattern: /new\s+instructions?:|system\s+prompt:|<\/?system>/i,
    severity: "high",
    description: "Attempt to inject system-level instructions",
  },
  {
    pattern: /you\s+are\s+now\s+(a|an)\s+/i,
    severity: "medium",
    description: "Attempt to redefine assistant role",
  },
  {
    pattern: /pretend\s+(you're|you\s+are|to\s+be)/i,
    severity: "medium",
    description: "Attempt to make assistant pretend",
  },

  // Data exfiltration attempts
  {
    pattern: /send\s+(all|my|the)\s+(data|emails?|messages?|info)/i,
    severity: "high",
    description: "Potential data exfiltration request",
  },
  {
    pattern: /forward\s+(all|everything|this)\s+to/i,
    severity: "high",
    description: "Unauthorized forwarding request",
  },
  {
    pattern: /summarize\s+(all|every)\s+(emails?|messages?|conversations?)/i,
    severity: "medium",
    description: "Bulk data access request",
  },

  // External URL injection
  {
    pattern: /https?:\/\/(?!twitter\.com|x\.com|polymarket\.com)[^\s]+/i,
    severity: "low",
    description: "External URL detected (not X or Polymarket)",
  },

  // Code injection attempts
  {
    pattern: /<script[\s>]|javascript:/i,
    severity: "high",
    description: "Script injection attempt",
  },
  {
    pattern: /\$\{[^}]+\}|`[^`]*`/,
    severity: "low",
    description: "Template literal or variable interpolation",
  },

  // Encoding tricks
  {
    pattern: /&#x?[0-9a-f]+;/i,
    severity: "medium",
    description: "HTML entity encoding detected",
  },
  {
    pattern: /%[0-9a-f]{2}/i,
    severity: "low",
    description: "URL encoding detected",
  },
];

// ─── Suspicious Content Patterns ─────────────────────────

const SUSPICIOUS_PATTERNS: Array<{ pattern: RegExp; severity: SecurityFlag["severity"]; description: string }> = [
  // Hidden text tricks
  {
    pattern: /\u200b|\u200c|\u200d|\ufeff/,
    severity: "medium",
    description: "Zero-width characters detected (possible hidden text)",
  },
  {
    pattern: /\[hidden\]|\[invisible\]|<!--.*-->/i,
    severity: "medium",
    description: "Hidden content markers detected",
  },

  // Social engineering
  {
    pattern: /urgent|immediately|right\s+now|asap/i,
    severity: "low",
    description: "Urgency language (potential social engineering)",
  },
  {
    pattern: /don't\s+tell\s+anyone|keep\s+this\s+secret|confidential/i,
    severity: "medium",
    description: "Secrecy request (potential social engineering)",
  },

  // API key / credential patterns
  {
    pattern: /sk-[a-zA-Z0-9]{20,}|api[_-]?key\s*[:=]\s*\S+/i,
    severity: "high",
    description: "Potential API key or credential detected",
  },
  {
    pattern: /private[_-]?key|secret[_-]?key|password\s*[:=]/i,
    severity: "high",
    description: "Potential credential reference",
  },
];

export class SecurityScanner {
  /**
   * Scan content for security threats
   */
  scan(content: string): SecurityFlag[] {
    const flags: SecurityFlag[] = [];

    // Check injection patterns
    for (const { pattern, severity, description } of INJECTION_PATTERNS) {
      const match = content.match(pattern);
      if (match) {
        flags.push({
          type: "prompt_injection",
          severity,
          description,
          matchedPattern: match[0].slice(0, 50),
        });
      }
    }

    // Check suspicious patterns
    for (const { pattern, severity, description } of SUSPICIOUS_PATTERNS) {
      const match = content.match(pattern);
      if (match) {
        flags.push({
          type: "suspicious_pattern",
          severity,
          description,
          matchedPattern: match[0].slice(0, 50),
        });
      }
    }

    return flags;
  }

  /**
   * Check if content should be blocked based on security flags
   */
  shouldBlock(flags: SecurityFlag[]): boolean {
    const highSeverityCount = flags.filter(f => f.severity === "high").length;
    const mediumSeverityCount = flags.filter(f => f.severity === "medium").length;

    // Block if any high severity flags, or multiple medium severity
    return highSeverityCount > 0 || mediumSeverityCount >= 3;
  }

  /**
   * Sanitize content by removing potentially dangerous elements
   */
  sanitize(content: string): string {
    let sanitized = content;

    // Remove zero-width characters
    sanitized = sanitized.replace(/[\u200b\u200c\u200d\ufeff]/g, "");

    // Remove HTML tags
    sanitized = sanitized.replace(/<[^>]+>/g, "");

    // Remove HTML entities
    sanitized = sanitized.replace(/&#x?[0-9a-f]+;/gi, "");

    // Normalize whitespace
    sanitized = sanitized.replace(/\s+/g, " ").trim();

    return sanitized;
  }
}

// ─── Audit Logger ────────────────────────────────────────

const AUDIT_LOG_PATH = "backtests/claim-validator-audit.jsonl";
const MAX_LOG_SIZE_MB = 10;

export class AuditLogger {
  private logPath: string;

  constructor(basePath: string = process.cwd()) {
    this.logPath = path.join(basePath, AUDIT_LOG_PATH);
    this.ensureLogDir();
  }

  private ensureLogDir(): void {
    const dir = path.dirname(this.logPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * Log an audit event
   */
  log(entry: Omit<AuditLogEntry, "timestamp">): void {
    const fullEntry: AuditLogEntry = {
      timestamp: new Date(),
      ...entry,
    };

    // Rotate if needed
    this.rotateIfNeeded();

    // Append to log (JSONL format - one JSON object per line)
    const line = JSON.stringify(fullEntry) + "\n";
    fs.appendFileSync(this.logPath, line);
  }

  /**
   * Log claim received event
   */
  logClaimReceived(claimId: string, sourceId?: string): void {
    this.log({
      eventType: "claim_received",
      claimId,
      sourceId,
    });
  }

  /**
   * Log claim parsed event
   */
  logClaimParsed(claimId: string, securityFlags: SecurityFlag[]): void {
    this.log({
      eventType: "claim_parsed",
      claimId,
      securityFlags: securityFlags.length > 0 ? securityFlags : undefined,
    });
  }

  /**
   * Log validation complete event
   */
  logValidationComplete(claimId: string, verdict: string, sourceId?: string): void {
    this.log({
      eventType: "validation_complete",
      claimId,
      sourceId,
      verdict: verdict as AuditLogEntry["verdict"],
    });
  }

  /**
   * Log security flag event
   */
  logSecurityFlag(claimId: string, flags: SecurityFlag[]): void {
    this.log({
      eventType: "security_flag",
      claimId,
      securityFlags: flags,
    });
  }

  /**
   * Log error event
   */
  logError(error: string, claimId?: string): void {
    this.log({
      eventType: "error",
      claimId,
      metadata: { error },
    });
  }

  /**
   * Rotate log file if it exceeds max size
   */
  private rotateIfNeeded(): void {
    try {
      if (!fs.existsSync(this.logPath)) return;

      const stats = fs.statSync(this.logPath);
      const sizeMB = stats.size / (1024 * 1024);

      if (sizeMB > MAX_LOG_SIZE_MB) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const rotatedPath = this.logPath.replace(".jsonl", `-${timestamp}.jsonl`);
        fs.renameSync(this.logPath, rotatedPath);
      }
    } catch {
      // Ignore rotation errors
    }
  }

  /**
   * Read recent audit entries
   */
  readRecent(count: number = 100): AuditLogEntry[] {
    try {
      if (!fs.existsSync(this.logPath)) return [];

      const content = fs.readFileSync(this.logPath, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);
      const recentLines = lines.slice(-count);

      return recentLines.map(line => JSON.parse(line));
    } catch {
      return [];
    }
  }

  /**
   * Get security events from recent logs
   */
  getSecurityEvents(hours: number = 24): AuditLogEntry[] {
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
    const entries = this.readRecent(1000);

    return entries.filter(e =>
      new Date(e.timestamp) > cutoff &&
      (e.eventType === "security_flag" || e.securityFlags?.length)
    );
  }
}

// ─── Telegram User Allowlist ─────────────────────────────

export class TelegramAllowlist {
  private allowedUsers: Set<string>;
  private configPath: string;

  constructor(basePath: string = process.cwd()) {
    this.configPath = path.join(basePath, "config/telegram-allowlist.json");
    this.allowedUsers = this.loadAllowlist();
  }

  private loadAllowlist(): Set<string> {
    try {
      if (fs.existsSync(this.configPath)) {
        const data = JSON.parse(fs.readFileSync(this.configPath, "utf-8"));
        return new Set(data.allowedUsers || []);
      }
    } catch {
      // Ignore
    }

    // Default: empty set (must be configured)
    return new Set();
  }

  private saveAllowlist(): void {
    const dir = path.dirname(this.configPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(this.configPath, JSON.stringify({
      allowedUsers: Array.from(this.allowedUsers),
      updatedAt: new Date().toISOString(),
    }, null, 2));
  }

  /**
   * Check if a user ID is allowed
   */
  isAllowed(userId: string | number): boolean {
    return this.allowedUsers.has(String(userId));
  }

  /**
   * Add a user to the allowlist
   */
  addUser(userId: string | number): void {
    this.allowedUsers.add(String(userId));
    this.saveAllowlist();
  }

  /**
   * Remove a user from the allowlist
   */
  removeUser(userId: string | number): void {
    this.allowedUsers.delete(String(userId));
    this.saveAllowlist();
  }

  /**
   * Get all allowed users
   */
  getAllowedUsers(): string[] {
    return Array.from(this.allowedUsers);
  }
}
