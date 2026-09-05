/**
 * The Z3 singleton: memory cap, busy flag and the give-up switch that the
 * server's uncaughtException handler flips.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  getZ3,
  getZ3Param,
  isZ3Busy,
  markZ3Unusable,
  resetZ3ForTesting,
  withZ3Lock,
  Z3_MEMORY_MAX_MB,
} from '../../../src/lib/rego-z3.js';

afterEach(() => {
  resetZ3ForTesting();
});

describe('rego-z3', () => {
  it('caps Z3 memory when it initialises', async () => {
    await getZ3();
    expect(await getZ3Param('memory_max_size')).toBe(String(Z3_MEMORY_MAX_MB));
  }, 30_000);

  it('knows when a critical section is running', async () => {
    expect(isZ3Busy()).toBe(false);
    await withZ3Lock(async () => {
      expect(isZ3Busy()).toBe(true);
      return Promise.resolve();
    });
    expect(isZ3Busy()).toBe(false);
  });

  it('clears the busy flag when the section throws', async () => {
    await expect(withZ3Lock(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(isZ3Busy()).toBe(false);
  });

  it('refuses further use once marked unusable, until reset', async () => {
    markZ3Unusable('heap abort');
    await expect(getZ3()).rejects.toThrow(/heap abort/);
    resetZ3ForTesting();
    await expect(getZ3()).resolves.toBeDefined();
  }, 30_000);
});
