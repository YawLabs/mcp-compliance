type TestCategory = 'transport' | 'lifecycle' | 'tools' | 'resources' | 'prompts' | 'errors' | 'schema';
interface TestResult {
    id: string;
    name: string;
    category: TestCategory;
    passed: boolean;
    required: boolean;
    details: string;
    durationMs: number;
    specRef?: string;
}
type Grade = 'A' | 'B' | 'C' | 'D' | 'F';
type Overall = 'pass' | 'partial' | 'fail';
interface ComplianceReport {
    specVersion: string;
    url: string;
    timestamp: string;
    score: number;
    grade: Grade;
    overall: Overall;
    summary: {
        total: number;
        passed: number;
        failed: number;
        required: number;
        requiredPassed: number;
    };
    categories: Record<string, {
        passed: number;
        total: number;
    }>;
    tests: TestResult[];
    serverInfo: {
        protocolVersion: string | null;
        name: string | null;
        version: string | null;
        capabilities: Record<string, unknown>;
    };
    toolCount: number;
    toolNames: string[];
    resourceCount: number;
    promptCount: number;
    badge: {
        imageUrl: string;
        reportUrl: string;
        markdown: string;
        html: string;
    };
}
interface TestDefinition {
    id: string;
    name: string;
    category: TestCategory;
    required: boolean;
    specRef: string;
    description: string;
}
/** All 24 test IDs with descriptions for the explain command */
declare const TEST_DEFINITIONS: TestDefinition[];

declare function computeGrade(score: number): Grade;
declare function computeScore(tests: TestResult[]): {
    score: number;
    grade: Grade;
    overall: 'pass' | 'partial' | 'fail';
    summary: {
        total: number;
        passed: number;
        failed: number;
        required: number;
        requiredPassed: number;
    };
    categories: Record<string, {
        passed: number;
        total: number;
    }>;
};

/**
 * Generate badge URLs and markdown for a compliance report.
 * Badge images are served by mcp.hosting.
 */
declare function generateBadge(url: string): {
    imageUrl: string;
    reportUrl: string;
    markdown: string;
    html: string;
};

interface RunOptions {
    /** Optional callback for progress updates */
    onProgress?: (testId: string, passed: boolean, details: string) => void;
}
/**
 * Run the full MCP compliance test suite against a URL.
 */
declare function runComplianceSuite(url: string, options?: RunOptions): Promise<ComplianceReport>;

export { type ComplianceReport, type RunOptions, TEST_DEFINITIONS, type TestResult, computeGrade, computeScore, generateBadge, runComplianceSuite };
