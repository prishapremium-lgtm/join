'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

delete process.env.ANTHROPIC_KEY;

const {
  app,
  composeAddress,
  parseAddress,
  splitIsraeliAddress,
  normalizeExtracted,
  resolveRoetoAddress,
  collectIdImages,
} = require('../server');

let server;

before(() => {
  server = app.listen(0);
});

after(() => new Promise((resolve, reject) => {
  server.close(err => (err ? reject(err) : resolve()));
}));

function request(method, path, body) {
  const { port } = server.address();
  const data = body == null ? '' : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch (_) { json = { raw }; }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test('composeAddress builds one Hebrew line from parts', () => {
  assert.equal(
    composeAddress({ street: 'הרצל', houseNumber: '12', apartment: '4', city: 'תל אביב', zip: '6100000' }),
    'הרצל 12, דירה 4, תל אביב, 6100000',
  );
  assert.equal(composeAddress({ city: 'חיפה' }), 'חיפה');
  assert.equal(composeAddress({}), '');
});

test('parseAddress keeps street, city and drops a trailing postal code', () => {
  assert.deepEqual(parseAddress('הרצל 12, תל אביב'), { city: 'תל אביב', street: 'הרצל 12' });
  assert.deepEqual(parseAddress('הרצל 12, תל אביב, 6100000'), { city: 'תל אביב', street: 'הרצל 12' });
  assert.deepEqual(parseAddress(''), { city: 'לא צוין', street: 'לא צוין' });
});

test('splitIsraeliAddress reads street, house, apartment, city and zip', () => {
  assert.deepEqual(splitIsraeliAddress('הרצל 12, תל אביב, 6100000'), {
    street: 'הרצל', houseNumber: '12', apartment: '', city: 'תל אביב', zip: '6100000',
  });
  assert.deepEqual(splitIsraeliAddress('הרצל 12/4, חיפה'), {
    street: 'הרצל', houseNumber: '12', apartment: '4', city: 'חיפה', zip: '',
  });
  assert.deepEqual(splitIsraeliAddress('רחוב ויצמן 5 דירה 8א, ראשון לציון 7520000'), {
    street: 'ויצמן', houseNumber: '5', apartment: '8א', city: 'ראשון לציון', zip: '7520000',
  });
});

test('normalizeExtracted pads a near-complete ID and keeps structured parts', () => {
  const out = normalizeExtracted({
    firstName: ' ישראל ',
    lastName: 'ישראלי',
    idNumber: '12345678',
    birthDate: '15/01/1990',
    idIssueDate: '2020-05-01T00:00:00',
    gender: 'נקבה',
    street: 'רחוב הרצל',
    houseNumber: '12א',
    apartment: 'דירה 4',
    city: 'תל אביב',
    zip: '6100000',
  });
  assert.equal(out.firstName, 'ישראל');
  assert.equal(out.idNumber, '012345678');
  assert.equal(out.birthDate, '1990-01-15');
  assert.equal(out.idIssueDate, '2020-05-01');
  assert.equal(out.gender, '2');
  assert.equal(out.street, 'הרצל');
  assert.equal(out.houseNumber, '12א');
  assert.equal(out.apartment, '4');
  assert.equal(out.zip, '6100000');
  assert.equal(out.address, 'הרצל 12א, דירה 4, תל אביב, 6100000');
});

test('normalizeExtracted splits a combined address and does not invent a short ID', () => {
  const out = normalizeExtracted({
    idNumber: '12345',
    address: 'הרצל 12, תל אביב, 6100000',
    gender: '3',
    birthDate: '2020-13-40',
    zip: '123',
  });
  assert.equal(out.idNumber, '12345');
  assert.equal(out.street, 'הרצל');
  assert.equal(out.houseNumber, '12');
  assert.equal(out.city, 'תל אביב');
  assert.equal(out.zip, '6100000');
  assert.equal(out.gender, '');
  assert.equal(out.birthDate, '');
  assert.equal(out.address, 'הרצל 12, תל אביב, 6100000');
});

test('normalizeExtracted does not overwrite parts that were already read', () => {
  const out = normalizeExtracted({
    street: 'ויצמן',
    address: 'הרצל 12, תל אביב, 6100000',
  });
  assert.equal(out.street, 'ויצמן');
  assert.equal(out.houseNumber, '12');
  assert.equal(out.city, 'תל אביב');
});

test('resolveRoetoAddress prefers parts and still accepts a legacy address string', () => {
  assert.deepEqual(
    resolveRoetoAddress({ street: 'הרצל', houseNumber: '12', apartment: '4', city: 'חיפה', zip: '3300000' }),
    { city: 'חיפה', street: 'הרצל 12 דירה 4' },
  );
  assert.deepEqual(
    resolveRoetoAddress({ street: 'הרצל 12', houseNumber: '12', city: 'חיפה' }),
    { city: 'חיפה', street: 'הרצל 12' },
  );
  assert.deepEqual(
    resolveRoetoAddress({ address: 'הרצל 12, תל אביב, 6100000' }),
    { city: 'תל אביב', street: 'הרצל 12' },
  );
});

test('collectIdImages prefers the images array, strips data urls, and caps the count', () => {
  const jpeg = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF]), Buffer.alloc(40, 1)]).toString('base64');
  const one = collectIdImages({ imageBase64: `data:image/jpeg;base64,${jpeg}`, images: [] });
  assert.equal(one.length, 1);
  assert.equal(one[0], jpeg);

  const many = collectIdImages({
    images: Array.from({ length: 10 }, () => jpeg),
    imageBase64: Buffer.alloc(40, 2).toString('base64'),
  });
  assert.equal(many.length, 8);
  assert.equal(many[0], jpeg);
  assert.equal(collectIdImages({}).length, 0);
});

test('extract-id rejects an empty upload and fails softly without an API key', async () => {
  const missing = await request('POST', '/api/extract-id', {});
  assert.equal(missing.status, 400);
  assert.match(missing.json.message, /תמונה/);

  const jpeg = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF]), Buffer.alloc(40, 1)]).toString('base64');
  const noKey = await request('POST', '/api/extract-id', { images: [jpeg, jpeg] });
  assert.equal(noKey.status, 500);
  assert.match(noKey.json.message, /מפתח|לא הוגדר/);
  assert.equal(noKey.json.success, false);
});

test('submit still requires client data and the signed PDF', async () => {
  const noClient = await request('POST', '/api/submit', {});
  assert.equal(noClient.status, 400);
  assert.match(noClient.json.message, /נתונים/);

  const noPdf = await request('POST', '/api/submit', { clientData: { firstName: 'ישראל' } });
  assert.equal(noPdf.status, 400);
  assert.match(noPdf.json.message, /PDF/);
});
