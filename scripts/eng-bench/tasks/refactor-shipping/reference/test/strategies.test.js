// Reference test (grader self-test only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateShipping, registerCarrier } from '../src/shipping.js';

test('a registered carrier is used', () => {
  registerCarrier('local', { quote: () => ({ cost: 1 }) });
  assert.deepEqual(calculateShipping({ carrier: 'local', weightKg: 1 }), { cost: 1 });
});
