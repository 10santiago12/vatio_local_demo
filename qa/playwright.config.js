'use strict';
const { defineConfig, devices } = require('@playwright/test');
const fs = require('node:fs');

const have = (p) => fs.existsSync(p);
const desktop = { viewport: { width: 1440, height: 900 } };
const projects = [
  { name: 'chromium', use: { ...devices['Desktop Chrome'], ...desktop } },
  { name: 'firefox', use: { ...devices['Desktop Firefox'], ...desktop } },
  { name: 'webkit', use: { ...devices['Desktop Safari'], ...desktop } },
  { name: 'iphone-13', use: { ...devices['iPhone 13'] } },
  { name: 'pixel-7', use: { ...devices['Pixel 7'] } },
];
// Installed branded browsers are optional: they run only when present on the machine.
if (have('C:/Program Files/Google/Chrome/Application/chrome.exe')) {
  projects.unshift({ name: 'chrome', use: { ...devices['Desktop Chrome'], channel: 'chrome', ...desktop } });
}
if (have('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe')) {
  projects.unshift({ name: 'msedge', use: { ...devices['Desktop Edge'], channel: 'msedge', ...desktop } });
}

module.exports = defineConfig({
  testDir: './e2e',
  outputDir: './results/artifacts',
  globalSetup: require.resolve('./e2e/global-setup.js'),
  globalTeardown: require.resolve('./e2e/global-teardown.js'),
  workers: 3,
  retries: 0,
  timeout: 45000,
  reporter: [['list'], ['json', { outputFile: 'results/report.json' }]],
  projects,
});
