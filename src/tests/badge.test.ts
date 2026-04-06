import { describe, it, expect } from 'vitest';
import { generateBadge } from '../badge.js';

describe('generateBadge', () => {
  it('generates correct badge URLs', () => {
    const badge = generateBadge('https://my-server.example.com/mcp');
    expect(badge.imageUrl).toContain('mcp.hosting/api/compliance/');
    expect(badge.reportUrl).toContain('mcp.hosting/compliance/');
    expect(badge.markdown).toContain('[![MCP Compliant]');
    expect(badge.html).toContain('<a href=');
  });

  it('handles simple URLs', () => {
    const badge = generateBadge('https://localhost:3000');
    expect(badge.imageUrl).toContain('localhost');
  });
});
