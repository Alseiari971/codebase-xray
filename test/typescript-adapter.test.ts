import assert from 'node:assert/strict';
import { test } from 'node:test';
import { packageName } from '../src/adapters/typescript.ts';

test('packageName extracts the npm package from a specifier', () => {
  assert.equal(packageName('react'), 'react');
  assert.equal(packageName('lodash/fp'), 'lodash');
  assert.equal(packageName('@scope/pkg'), '@scope/pkg');
  assert.equal(packageName('@scope/pkg/deep/path'), '@scope/pkg');
});

test('packageName rejects relative paths and common aliases', () => {
  for (const specifier of ['./x', '../x', '/abs/x', 'C:/x', '@/lib/x', '~/x', '#internal', '@scope']) {
    assert.equal(packageName(specifier), undefined, specifier);
  }
});
