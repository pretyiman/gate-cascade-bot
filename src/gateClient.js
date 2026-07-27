const crypto = require('crypto');
const https = require('https');
const { normalizeSymbol } = require('./symbol');

const BASE_HOST = 'api.gateio.ws';

function sign(method, urlPath, queryString, bodyString, timestamp, apiSecret) {
  const bodyHash = crypto.createHash('sha512').update(bodyString || '').digest('hex');
  const signatureString = `${method}\n${urlPath}\n${queryString || ''}\n${bodyHash}\n${timestamp}`;
  const signature = crypto.createHmac('sha512', apiSecret).update(signatureString).digest('hex');
  return signature;
}

function request({ method, urlPath, queryString = '', bodyString = '', apiKey, apiSecret }) {
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

/** Public endpoint, no credentials needed - every USDT spot pair's ticker, for building a trending list. */
async function getAllTickers() {
  return request({ method: 'GET', urlPath: '/api/v4/spot/tickers' });
}

/**
 * Public endpoint, no credentials needed - one pair's last price. Separate from
 * the per-client getTicker (which is only reachable via createClient) so this
 * can be used for validation (e.g. manual-template creation) without requiring
 * a user to have configured API credentials first.
 */
async function getPublicTicker(symbol) {
  const currencyPair = normalizeSymbol(symbol);
  const result = await request({
    method: 'GET',
    urlPath: '/api/v4/spot/tickers',
    queryString: `currency_pair=${currencyPair}`,
  });
  const ticker = Array.isArray(result) ? result[0] : result;
  if (!ticker || ticker.last === undefined) {
    throw new Error(`No market data found for ${currencyPair} - check the pair is correct`);
  }
  return parseFloat(ticker.last);
}

const pairPrecisionCache = new Map();

/**
 * Public endpoint, no credentials needed - a pair's own allowed decimal places
 * for price/amount. Needed so a computed trigger price (see
 * computeReactiveTriggerPrice) always lands on a value Gate.io will actually
 * accept, regardless of whether the coin is priced at 0.00000012 or 50000.
 * Cached per process since this never changes at runtime.
 */
async function getPairPrecision(symbol) {
  const currencyPair = normalizeSymbol(symbol);
  if (pairPrecisionCache.has(currencyPair)) return pairPrecisionCache.get(currencyPair);

  const info = await request({
    method: 'GET',
    urlPath: `/api/v4/spot/currency_pairs/${currencyPair}`,
  });
  const result = {
    pricePrecision: Number(info.precision),
    amountPrecision: Number(info.amount_precision),
  };
  pairPrecisionCache.set(currencyPair, result);
  return result;
}

const REACTIVE_TRIGGER_BUFFER_PCT = Number(process.env.REACTIVE_TRIGGER_BUFFER_PCT || 0.0002); // 0.02%

/**
 * Levels 2+ have no user-declared arm price the way level 1's cascade-wide
 * trigger_price does - we compute one: a tiny buffer above the buy price so
 * Gate's native trigger order can still be used for them too (funds stay
 * unlocked until price is genuinely close), rounded to the pair's own valid
 * price precision. Guarantees at least one real tick of separation from the
 * buy price even after rounding - a pair with few decimal places could
 * otherwise round a 0.02% buffer away to nothing, which would make the
 * trigger fire immediately instead of waiting.
 */
function computeReactiveTriggerPrice(buyPrice, pricePrecision) {
  const tick = 1 / 10 ** pricePrecision;
  const raw = buyPrice * (1 + REACTIVE_TRIGGER_BUFFER_PCT);
  let rounded = Number(raw.toFixed(pricePrecision));
  if (rounded <= buyPrice) {
    rounded = Number((buyPrice + tick).toFixed(pricePrecision));
  }
  return rounded;
}

/**
 * Verifies a key/secret actually work by making one real, read-only call to
 * Gate.io (wallet balances) - always real, regardless of dry-run, since a
 * balance check has no side effects and dry-run has no meaning here.
 */
async function testCredentials({ apiKey, apiSecret }) {
  const accounts = await request({ method: 'GET', urlPath: '/api/v4/spot/accounts', apiKey, apiSecret });
  const usdt = accounts.find((a) => a.currency === 'USDT');
  return {
    usdtAvailable: usdt ? parseFloat(usdt.available) : 0,
    accountCount: accounts.length,
  };
}

const GATE_TRIGGER_EXPIRATION_SECONDS = Number(process.env.GATE_TRIGGER_EXPIRATION_SECONDS || 2592000); // 30 days

/**
 * Builds a client bound to one user's credentials/dry-run mode. Nothing is
 * read from process.env here - each tenant gets their own key/secret/mode.
 */
function createClient({ apiKey, apiSecret, dryRun }) {
  let dryRunOrderCounter = 0;

  /**
   * Native price-triggered (conditional) order - Gate's own server watches the
   * market and only creates the real resting buy once triggerPrice is reached,
   * so no funds are locked and nothing rests on the book before then. Used for
   * a live cascade's level 1 arm condition (the user-declared trigger_price),
   * and reactively for every later level too - each one gets armed only after
   * the previous level's fill notification arrives, using a small computed
   * buffer above its buy price as the trigger (see cascadeEngine.js's
   * placeNextLevel and gateClient.js's computeReactiveTriggerPrice) - so only
   * one trigger is ever live at a time, never all of them pre-armed at once.
   */
  async function placeTriggerOrder({ symbol, triggerPrice, buyPrice, amountUsdt }) {
    const currencyPair = normalizeSymbol(symbol);
    const amount = (amountUsdt / buyPrice).toFixed(8);

    const body = {
      trigger: { price: triggerPrice.toString(), rule: '<=', expiration: GATE_TRIGGER_EXPIRATION_SECONDS },
      put: {
        type: 'limit',
        side: 'buy',
        price: buyPrice.toString(),
        amount,
        account: 'normal', // different enum than placeOrder's 'spot' - this is the price_orders endpoint's own field
        time_in_force: 'gtc',
      },
      market: currencyPair, // this endpoint's top-level field is `market`, not `currency_pair`
    };
    const bodyString = JSON.stringify(body);

    if (dryRun) {
      dryRunOrderCounter += 1;
      const fakeId = `dryrun-trigger-${Date.now()}-${dryRunOrderCounter}`;
      console.log('[DRY_RUN] would place trigger order:', body);
      return { id: fakeId, status: 'open', market: currencyPair };
    }

    return request({ method: 'POST', urlPath: '/api/v4/spot/price_orders', bodyString, apiKey, apiSecret });
  }

  async function getTriggerOrder(triggerOrderId) {
    if (dryRun) {
      // Dry-run trigger orders never fire on their own, same philosophy as
      // getOrder's dry-run branch - tests/manual runs drive progress explicitly.
      return { id: triggerOrderId, status: 'open' };
    }

    return request({
      method: 'GET',
      urlPath: `/api/v4/spot/price_orders/${triggerOrderId}`,
      apiKey,
      apiSecret,
    });
  }

  async function cancelTriggerOrder(triggerOrderId) {
    if (dryRun) {
      console.log(`[DRY_RUN] would cancel trigger order ${triggerOrderId}`);
      return { id: triggerOrderId, status: 'cancelled' };
    }

    return request({
      method: 'DELETE',
      urlPath: `/api/v4/spot/price_orders/${triggerOrderId}`,
      apiKey,
      apiSecret,
    });
  }

  async function getTicker(symbol) {
    // Public endpoint, no auth needed - always real regardless of dryRun,
    // same as before (harmless market-data read, no account access).
    const currencyPair = normalizeSymbol(symbol);
    const result = await request({
      method: 'GET',
      urlPath: '/api/v4/spot/tickers',
      queryString: `currency_pair=${currencyPair}`,
    });
    const ticker = Array.isArray(result) ? result[0] : result;
    return parseFloat(ticker.last);
  }

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

    if (dryRun) {
      dryRunOrderCounter += 1;
      const fakeId = `dryrun-${Date.now()}-${dryRunOrderCounter}`;
      console.log(`[DRY_RUN] would place ${side} order:`, body);
      return { id: fakeId, status: 'open', currency_pair: currencyPair, amount, price: price.toString() };
    }

    return request({ method: 'POST', urlPath: '/api/v4/spot/orders', bodyString, apiKey, apiSecret });
  }

  async function getOrder(orderId, symbol) {
    const currencyPair = normalizeSymbol(symbol);

    if (dryRun) {
      // Nothing ever actually trades in dry-run, so fake orders never "fill" on
      // their own - tests/manual runs should drive fills explicitly.
      return { id: orderId, status: 'open', currency_pair: currencyPair };
    }

    return request({
      method: 'GET',
      urlPath: `/api/v4/spot/orders/${orderId}`,
      queryString: `currency_pair=${currencyPair}`,
      apiKey,
      apiSecret,
    });
  }

  async function cancelOrder(orderId, symbol) {
    const currencyPair = normalizeSymbol(symbol);

    if (dryRun) {
      console.log(`[DRY_RUN] would cancel order ${orderId} (${currencyPair})`);
      return { id: orderId, status: 'cancelled' };
    }

    return request({
      method: 'DELETE',
      urlPath: `/api/v4/spot/orders/${orderId}`,
      queryString: `currency_pair=${currencyPair}`,
      apiKey,
      apiSecret,
    });
  }

  return {
    getTicker,
    placeOrder,
    getOrder,
    cancelOrder,
    placeTriggerOrder,
    getTriggerOrder,
    cancelTriggerOrder,
    dryRun,
  };
}

module.exports = {
  createClient,
  getAllTickers,
  getPublicTicker,
  getPairPrecision,
  computeReactiveTriggerPrice,
  testCredentials,
};
