const test = require('node:test');
const assert = require('node:assert/strict');
const { pickEvictionVictim } = require('../lib/sessionCapacity');

test('does not evict when under the running cap', () => {
  assert.equal(pickEvictionVictim({
    runningIds: ['1', '2'],
    maxRunning: 8,
    protectedIds: new Set(),
    lastUsedAt: new Map(),
  }), null);
});

test('evicts the least recently used unprotected browser', () => {
  const lastUsedAt = new Map([
    ['1', 100],
    ['2', 50],
    ['3', 300],
  ]);
  assert.equal(pickEvictionVictim({
    runningIds: ['1', '2', '3'],
    maxRunning: 3,
    startingId: '4',
    protectedIds: new Set(),
    lastUsedAt,
  }), '2');
});

test('never evicts VNC or collection-busy browsers', () => {
  assert.equal(pickEvictionVictim({
    runningIds: ['1', '2'],
    maxRunning: 2,
    startingId: '3',
    protectedIds: new Set(['1', '2']),
    lastUsedAt: new Map([['1', 1], ['2', 2]]),
  }), null);
});
