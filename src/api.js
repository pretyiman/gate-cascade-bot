const path = require('path');
const express = require('express');
const {
  createCascade,
  getCascade,
  listCascades,
  cancelCascade,
  holdCascade,
  resumeCascade,
  deleteCascade,
  cancelLevelOrder,
  editPendingLevel,
  editPlacedLevel,
  editSellPrice,
} = require('./cascadeEngine');
const gateClient = require('./gateClient');
const { normalizeSymbol } = require('./symbol');

const REQUIRED_FIELDS = [
  'symbol',
  'base_price',
  'base_amount_usdt',
  'price_step_pct',
  'amount_step_pct',
  'num_levels',
  'take_profit_base_pct',
  'take_profit_step_pct',
];

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.get('/status', (req, res) => {
    res.json({ dryRun: gateClient.DRY_RUN });
  });

  app.post('/cascades', (req, res) => {
    const body = req.body || {};
    const missing = REQUIRED_FIELDS.filter((f) => body[f] === undefined || body[f] === null);
    if (missing.length > 0) {
      return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });
    }

    try {
      const id = createCascade({
        symbol: normalizeSymbol(body.symbol),
        trigger_price: body.trigger_price ?? null,
        base_price: Number(body.base_price),
        base_amount_usdt: Number(body.base_amount_usdt),
        price_step_pct: Number(body.price_step_pct),
        amount_step_pct: Number(body.amount_step_pct),
        num_levels: Number(body.num_levels),
        take_profit_base_pct: Number(body.take_profit_base_pct),
        take_profit_step_pct: Number(body.take_profit_step_pct),
        poll_interval_seconds: body.poll_interval_seconds ? Number(body.poll_interval_seconds) : 60,
      });
      res.status(201).json(getCascade(id));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get('/cascades', (req, res) => {
    res.json(listCascades());
  });

  app.get('/cascades/:id', (req, res) => {
    const cascade = getCascade(req.params.id);
    if (!cascade) return res.status(404).json({ error: 'Not found' });
    res.json(cascade);
  });

  app.post('/cascades/:id/cancel', async (req, res) => {
    const ok = await cancelCascade(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Not found' });
    res.json(getCascade(req.params.id));
  });

  app.post('/cascades/:id/hold', (req, res) => {
    const ok = holdCascade(req.params.id);
    if (!ok) return res.status(400).json({ error: 'Cannot hold this cascade (not found, or not active/pending)' });
    res.json(getCascade(req.params.id));
  });

  app.post('/cascades/:id/resume', (req, res) => {
    const ok = resumeCascade(req.params.id);
    if (!ok) return res.status(400).json({ error: 'Cannot resume this cascade (not found, or not held)' });
    res.json(getCascade(req.params.id));
  });

  app.delete('/cascades/:id', async (req, res) => {
    const ok = await deleteCascade(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Not found' });
    res.json({ deleted: true });
  });

  app.post('/cascades/:id/levels/:levelId/cancel', async (req, res) => {
    const { side } = req.body || {};
    try {
      const result = await cancelLevelOrder(req.params.id, req.params.levelId, side);
      if (!result.ok) return res.status(400).json({ error: result.error });
      res.json(getCascade(req.params.id));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.patch('/cascades/:id/levels/:levelId', async (req, res) => {
    const cascade = getCascade(req.params.id);
    if (!cascade) return res.status(404).json({ error: 'Not found' });
    const level = cascade.levels.find((l) => l.id === req.params.levelId);
    if (!level) return res.status(404).json({ error: 'Level not found' });

    const body = req.body || {};
    try {
      let result;
      if (body.sell_target_price !== undefined) {
        result = await editSellPrice(req.params.id, req.params.levelId, {
          sell_target_price: Number(body.sell_target_price),
        });
      } else if (level.status === 'pending') {
        result = editPendingLevel(req.params.id, req.params.levelId, {
          target_price: Number(body.target_price),
          amount_usdt: Number(body.amount_usdt),
          take_profit_pct: Number(body.take_profit_pct ?? level.take_profit_pct),
        });
      } else if (level.status === 'placed') {
        result = await editPlacedLevel(req.params.id, req.params.levelId, {
          target_price: Number(body.target_price),
          amount_usdt: Number(body.amount_usdt),
        });
      } else {
        return res.status(400).json({ error: 'This level cannot be edited right now' });
      }

      if (!result.ok) return res.status(400).json({ error: result.error });
      res.json(getCascade(req.params.id));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return app;
}

module.exports = { buildApp };
