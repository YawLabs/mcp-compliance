import { describe, it, expect } from 'vitest';
import { computeGrade, computeScore } from '../grader.js';
import type { TestResult } from '../types.js';

describe('computeGrade', () => {
  it('returns A for 90+', () => {
    expect(computeGrade(90)).toBe('A');
    expect(computeGrade(100)).toBe('A');
  });
  it('returns B for 75-89', () => {
    expect(computeGrade(75)).toBe('B');
    expect(computeGrade(89)).toBe('B');
  });
  it('returns C for 60-74', () => {
    expect(computeGrade(60)).toBe('C');
    expect(computeGrade(74)).toBe('C');
  });
  it('returns D for 40-59', () => {
    expect(computeGrade(40)).toBe('D');
    expect(computeGrade(59)).toBe('D');
  });
  it('returns F for below 40', () => {
    expect(computeGrade(0)).toBe('F');
    expect(computeGrade(39)).toBe('F');
  });
});

describe('computeScore', () => {
  function makeTest(passed: boolean, required: boolean, category = 'transport'): TestResult {
    return {
      id: `test-${Math.random()}`,
      name: 'Test',
      category: category as TestResult['category'],
      passed,
      required,
      details: '',
      durationMs: 10,
    };
  }

  it('returns 100% when all tests pass', () => {
    const tests = [
      makeTest(true, true),
      makeTest(true, true),
      makeTest(true, false),
    ];
    const result = computeScore(tests);
    expect(result.score).toBe(100);
    expect(result.grade).toBe('A');
    expect(result.overall).toBe('pass');
  });

  it('returns fail when required tests fail', () => {
    const tests = [
      makeTest(false, true),
      makeTest(true, false),
    ];
    const result = computeScore(tests);
    expect(result.overall).toBe('fail');
  });

  it('returns partial when all required pass but some optional fail', () => {
    const tests = [
      makeTest(true, true),
      makeTest(false, false),
    ];
    const result = computeScore(tests);
    expect(result.overall).toBe('partial');
  });

  it('computes categories correctly', () => {
    const tests = [
      makeTest(true, true, 'transport'),
      makeTest(false, false, 'transport'),
      makeTest(true, true, 'lifecycle'),
    ];
    const result = computeScore(tests);
    expect(result.categories.transport).toEqual({ passed: 1, total: 2 });
    expect(result.categories.lifecycle).toEqual({ passed: 1, total: 1 });
  });
});
