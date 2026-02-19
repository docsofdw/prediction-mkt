import Anthropic from "@anthropic-ai/sdk";
import axios from "axios";
import crypto from "crypto";
import { ClaimInput, ParsedClaim, MarketType, StrategyType, EdgeSource, ExtractedParameters, SecurityFlag } from "../types";
import { SecurityScanner, AuditLogger } from "./security";

const EXTRACTION_PROMPT = `You are analyzing a trading/prediction market claim from social media. Extract structured information about the claimed trading edge.

<content>
{{CONTENT}}
</content>

Analyze this and return a JSON object with:
{
  "parseConfidence": 0.0-1.0,
  "marketType": "btc" | "crypto" | "weather" | "elections" | "sports" | "economics" | "events" | "unknown",
  "strategyType": "momentum" | "mean-reversion" | "breakout" | "arbitrage" | "structural" | "information" | "sentiment" | "unknown",
  "edgeSource": "structural" | "informational" | "behavioral" | "technical" | "fundamental" | "unknown",
  "summary": "One paragraph summary of the claimed edge",
  "parameters": {
    "windows": [numbers if mentioned],
    "thresholds": [price levels, percentages],
    "ratios": [z-scores, ratios],
    "timeframes": ["5 minutes", "1 hour", etc],
    "indicators": ["MA", "RSI", etc],
    "entryConditions": ["description of when to enter"],
    "exitConditions": ["description of when to exit"]
  },
  "marketIdentifiers": {
    "keywords": ["bitcoin", "election", etc],
    "strikes": [100000, 95000] if price targets mentioned,
    "expirations": ["March 2026", "Q2"] if deadlines mentioned,
    "specificMarkets": ["BTC > $100k by March"]
  },
  "claimedEdge": {
    "returnPercent": number if claimed,
    "sharpeRatio": number if claimed,
    "winRate": number if claimed,
    "description": "what they claim the edge is"
  },
  "warnings": ["any red flags or unclear aspects"]
}

Be conservative with parseConfidence. If the post is vague or hype without specifics, confidence should be low (<0.5).
If there's no actual trading claim, set marketType and strategyType to "unknown".
Return ONLY the JSON object, no other text.`;

export class ClaimParser {
  private anthropic: Anthropic;
  private securityScanner: SecurityScanner;
  private auditLogger: AuditLogger;

  constructor(apiKey: string, basePath?: string) {
    this.anthropic = new Anthropic({ apiKey });
    this.securityScanner = new SecurityScanner();
    this.auditLogger = new AuditLogger(basePath);
  }

  /**
   * Fetch content from X post URL using FxTwitter API
   */
  async fetchXContent(url: string): Promise<string> {
    // Validate URL is actually X/Twitter
    if (!url.match(/^https?:\/\/(twitter\.com|x\.com)\//)) {
      throw new Error("URL must be from twitter.com or x.com");
    }

    // Extract username and tweet ID
    const match = url.match(/(?:twitter\.com|x\.com)\/([^/]+)\/status\/(\d+)/);
    if (!match) {
      throw new Error(`Cannot parse X URL: ${url}`);
    }

    const [, username, tweetId] = match;

    // Use FxTwitter API (public, no auth required)
    try {
      const apiUrl = `https://api.fxtwitter.com/${username}/status/${tweetId}`;
      const { data } = await axios.get(apiUrl, {
        timeout: 15_000,
        headers: {
          "User-Agent": "PolymarketClaimValidator/1.0",
        },
      });

      if (data.code !== 200 || !data.tweet) {
        throw new Error(`FxTwitter API error: ${data.message || "Unknown error"}`);
      }

      const tweet = data.tweet;
      const parts: string[] = [];

      // Add author info for context
      if (tweet.author?.name) {
        parts.push(`Author: ${tweet.author.name} (@${tweet.author.screen_name})`);
        if (tweet.author.description) {
          parts.push(`Bio: ${tweet.author.description}`);
        }
      }

      // Add main tweet text
      if (tweet.text && tweet.text.trim()) {
        parts.push(`\nTweet: ${tweet.text}`);
      } else if (tweet.raw_text?.text) {
        parts.push(`\nTweet: ${tweet.raw_text.text}`);
      }

      // If it's an article/long-form post, extract that content
      if (tweet.article) {
        if (tweet.article.title) {
          parts.push(`\nArticle Title: ${tweet.article.title}`);
        }
        if (tweet.article.preview_text) {
          parts.push(`Article Preview: ${tweet.article.preview_text}`);
        }
      }

      // Add quote tweet if present
      if (tweet.quote) {
        parts.push(`\nQuoted Tweet (@${tweet.quote.author?.screen_name}): ${tweet.quote.text}`);
      }

      // Add engagement metrics for credibility context
      if (tweet.likes || tweet.retweets) {
        parts.push(`\nEngagement: ${tweet.likes?.toLocaleString() || 0} likes, ${tweet.retweets?.toLocaleString() || 0} retweets, ${tweet.views?.toLocaleString() || 0} views`);
      }

      const content = parts.join("\n").trim();

      if (!content || content.length < 20) {
        throw new Error("Tweet content too short or empty");
      }

      return content;

    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.response?.status === 404) {
          throw new Error("Tweet not found or deleted");
        }
        if (error.response?.status === 429) {
          throw new Error("Rate limited - please try again later");
        }
      }
      throw new Error(`Could not fetch X post: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private cleanHtml(html: string): string {
    return html
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, " ")
      .trim();
  }

  /**
   * Parse a claim using Claude
   */
  async parse(input: ClaimInput): Promise<ParsedClaim> {
    const claimId = crypto.randomUUID();

    // Log claim received
    this.auditLogger.logClaimReceived(claimId, input.sourceId);

    // Resolve content if URL provided
    let content = input.content;
    let fetchError: string | null = null;

    if (!content && input.source.startsWith("http")) {
      try {
        content = await this.fetchXContent(input.source);
      } catch (error) {
        fetchError = error instanceof Error ? error.message : String(error);
        // If fetch fails, use URL as content but track the error
        content = `[URL: ${input.source}]\n\nNote: Could not fetch content automatically. Error: ${fetchError}`;
      }
    } else if (!content) {
      content = input.source;
    }

    // Security scan on raw content
    const securityFlags = this.securityScanner.scan(content);

    // Check if we should block
    if (this.securityScanner.shouldBlock(securityFlags)) {
      this.auditLogger.logSecurityFlag(claimId, securityFlags);

      return {
        id: claimId,
        input,
        parseConfidence: 0,
        marketType: "unknown",
        strategyType: "unknown",
        edgeSource: "unknown",
        summary: "Content blocked due to security concerns",
        parameters: {},
        warnings: ["Content blocked: " + securityFlags.map(f => f.description).join(", ")],
        securityFlags,
      };
    }

    // Sanitize content before sending to LLM
    const sanitizedContent = this.securityScanner.sanitize(content);

    // Call Claude for extraction
    try {
      const response = await this.anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 2000,
        messages: [
          {
            role: "user",
            content: EXTRACTION_PROMPT.replace("{{CONTENT}}", sanitizedContent),
          },
        ],
      });

      const responseText = response.content[0].type === "text"
        ? response.content[0].text
        : "";

      // Extract JSON from response
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error("Failed to extract JSON from Claude response");
      }

      const extracted = JSON.parse(jsonMatch[0]);

      const parsedClaim: ParsedClaim = {
        id: claimId,
        input,
        parseConfidence: extracted.parseConfidence ?? 0.5,
        marketType: (extracted.marketType as MarketType) ?? "unknown",
        strategyType: (extracted.strategyType as StrategyType) ?? "unknown",
        edgeSource: (extracted.edgeSource as EdgeSource) ?? "unknown",
        summary: extracted.summary ?? "",
        parameters: (extracted.parameters as ExtractedParameters) ?? {},
        marketIdentifiers: extracted.marketIdentifiers,
        claimedEdge: extracted.claimedEdge,
        warnings: extracted.warnings ?? [],
        securityFlags,
      };

      // Log successful parse
      this.auditLogger.logClaimParsed(claimId, securityFlags);

      return parsedClaim;

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.auditLogger.logError(errorMessage, claimId);

      return {
        id: claimId,
        input,
        parseConfidence: 0,
        marketType: "unknown",
        strategyType: "unknown",
        edgeSource: "unknown",
        summary: "Failed to parse claim",
        parameters: {},
        warnings: [`Parse error: ${errorMessage}`],
        securityFlags,
      };
    }
  }
}
