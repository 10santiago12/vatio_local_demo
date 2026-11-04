'use strict';
/**
 * Public entry point of the pure domain layer.
 *
 * Reading order for a new developer (about 4 hours end to end, RNF-12):
 *   constants -> time/stats -> cost -> baseline -> alerts -> recommendations -> control -> savings
 *   -> emissions -> multisite -> permissions.
 * Rules of this layer: no HTTP, no database, no file system, no clock and no randomness. Every
 * function receives its data and an explicit `now`; the application layer supplies both.
 */

module.exports = {
  constants: require('./constants'),
  time: require('./time'),
  stats: require('./stats'),
  text: require('./text'),
  cost: require('./cost'),
  baseline: require('./baseline'),
  alerts: require('./alerts'),
  recommendations: require('./recommendations'),
  control: require('./control'),
  savings: require('./savings'),
  emissions: require('./emissions'),
  multisite: require('./multisite'),
  permissions: require('./permissions'),
};
