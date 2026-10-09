'use strict';

process.env.APP_ENV = 'staging';
delete process.env.ANTHROPIC_KEY;

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { app } = require('../server');

let server;

before(() => {
  server = app.listen(0);
});

after(() => new Promise((resolve, reject) => {
  server.close(err => (err ? reject(err) : resolve()));
}));

test('staging responses advertise noindex and the page shows the banner', async () => {
  const { port } = server.address();
  const page = await fetch(`http://127.0.0.1:${port}/`);
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.match(html, /<meta name="robots" content="noindex, nofollow" \/>/);
  assert.match(html, /סביבת בדיקה/);

  const asset = await fetch(`http://127.0.0.1:${port}/style.css`);
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.equal(asset.headers.get('content-type').includes('text/css'), true);
});
