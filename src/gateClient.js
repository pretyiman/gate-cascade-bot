const crypto = require('crypto');
const https = require('https');
const { normalizeSymbol } = require('./symbol');

const BASE_HOST = 'api.gateio.ws';
const DRY_RUN = String(process.env.DRY_RUN || 'true').toLowerCase() === 'true';

function sign(method, urlPath, queryString, bodyString, timestamp, apiSecret) {
  const bodyHash = crypto.createHash('sha512').update(bodyString || '').digest('hex');
  const signatureString = `${method}\n${urlPath}\n${queryString || ''}\n${bodyHash}\n${timestamp}`;
  const signature = crypto.createHmac('sha512', apiSecret).update(signatureString).digest('hex');
  return signature;
}

function request({ method, urlPath, queryString = '', bodyString = '' }) {
  const apiKey = process.env.GATE_API_KEY;
  const apiSecret = process.env.GATE_API_SECRET;
  const timestamp = Math.floor(Date.now() / 1000).toString();

  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };

  // Public endpoints (like tickers) don't need signing or keys.
  if (apiKey && apiSecret) {
    headers.KEY = apiKey;
    headers.SIGN = sign(method, urlPath, queryString, bodyString, timestamp, apiSecret);
    headers.Timestamp = timestamp;
  }

  const fullPath = queryString ? `${urlPath}?${queryString}` : urlPath;

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: BASE_HOST,
        path: fullPath,
        method,
        headers: {
          ...headers,
          ...(bodyString ? { 'Content-Length': Buffer.byteLength(bodyString) } : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          let parsed;
          try {
            parsed = raw ? JSON.parse(raw) : null;
          } catch (err) {
            return reject(new Error(`Failed to parse Gate.io response: ${raw}`));
          }
          if (res.statusCode >= 400) {
            return reject(new Error(`Gate.io ${res.statusCode}: ${JSON.stringify(parsed)}`));
          }
          resolve(parsed);
        });
      }
    );
    req.on('error', reject);
    if (bodyString) req.write(bodyString);
    req.end();
  });
}

async function getTicker(symbol) {
  const currencyPair = normalizeSymbol(symbol);
  const result = await request({
    method: 'GET',
    urlPath: '/api/v4/spot/tickers',
    queryString: `currency_pair=${currencyPair}`,
  });
  const ticker = Array.isArray(result) ? result[0] : result;
  return parseFloat(ticker.last);
}

let dryRunOrderCounter = 0;

async function placeOrder({ symbol, side, price, amountUsdt, amountBase }) {
  const currencyPair = normalizeSymbol(symbol);
  const amount = amountBase != null ? amountBase.toFixed(8) : (amountUsdt / price).toFixed(8);

  const body = {
    text: `t-${Date.now()}`,
    currency_pair: currencyPair,
    type: 'limit',
    account: 'spot',
    side,
    amount,
    price: price.toString(),
    time_in_force: 'gtc',
    iceberg: '0',
  };
  const bodyString = JSON.stringify(body);

  if (DRY_RUN) {
    dryRunOrderCounter += 1;
    const fakeId = `dryrun-${Date.now()}-${dryRunOrderCounter}`;
    console.log(`[DRY_RUN] would place ${side} order:`, body);
    return { id: fakeId, status: 'open', currency_pair: currencyPair, amount, price: price.toString() };
  }

  return request({ method: 'POST', urlPath: '/api/v4/spot/orders', bodyString });
}

async function getOrder(orderId, symbol) {
  const currencyPair = normalizeSymbol(symbol);

  if (DRY_RUN) {
    // In dry-run, nothing ever actually trades on Gate.io, so fake orders never "fill" on
    // their own. Tests/manual runs should drive fills explicitly (see cascadeEngine tests).
    return { id: orderId, status: 'open', currency_pair: currencyPair };
  }

  return request({
    method: 'GET',
    urlPath: `/api/v4/spot/orders/${orderId}`,
    queryString: `currency_pair=${currencyPair}`,
  });
}

async function cancelOrder(orderId, symbol) {
  const currencyPair = normalizeSymbol(symbol);

  if (DRY_RUN) {
    console.log(`[DRY_RUN] would cancel order ${orderId} (${currencyPair})`);
    return { id: orderId, status: 'cancelled' };
  }

  return request({
    method: 'DELETE',
    urlPath: `/api/v4/spot/orders/${orderId}`,
    queryString: `currency_pair=${currencyPair}`,
  });
}

module.exports = { getTicker, placeOrder, getOrder, cancelOrder, DRY_RUN };
